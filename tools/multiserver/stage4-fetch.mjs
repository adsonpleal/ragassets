// Stage 4, fetching half — read the planned sprites out of the patch servers
// without downloading the patches.
//
// A GRF entry carries its own offset and compressed length, so one sprite's
// bytes can be read on their own. That is the difference between a few hundred
// MB and about eleven GB: the 191 archives a full plan touches average 60 MB
// each (twRO's run from 2 MB to 292 MB), while the sprites inside them are a
// few hundred KB.
//
// Per archive the shape is:
//
//   1. two range reads for the header and the file table   (grf.mjs listRemote)
//   2. match the planned paths against the table's entries
//   3. coalesce the entries' spans that sit close together
//   4. one range read per span, then decodeGrfEntry per entry
//
// Step 3 earns its place because of step 4's cost: every request waits its turn
// behind a one-per-second-per-host limiter, so 1,500 entry reads is 25 minutes
// of waiting. Patches group a costume's files together, so merging spans that
// are within a window collapses most of a costume's files into one request.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeGrfEntry, grfEntrySpan, sanitizePath } from "../../extract-grf.mjs";
import { listRemote } from "./grf.mjs";
import { readRange } from "./net.mjs";
import { ORIGINS } from "./origins.mjs";
import { coalesceSpans, fileEntries, rangeCost } from "./ranges.mjs";
import { normalizePath } from "./pathshapes.mjs";
import { paths, ensureDir, readRows } from "./store.mjs";

/** An entry's span, tagged with the entry so the bytes can be matched back. */
export function entrySpans(entries) {
  return entries.map((entry) => ({ entry, ...grfEntrySpan(entry) }));
}

/**
 * Read the plan and group it by the archive each file comes from.
 *
 * `file` is which plan: the sprite plan by default, or the icon plan stage 6
 * writes. Both have the same columns on purpose — an icon is a GRF entry like
 * any other, so there is one fetcher and not two.
 */
export function readPlan({ origin, file = paths.plan() } = {}) {
  const rows = readRows(file);
  if (!rows.length) throw new Error(`no plan at ${file} — run \`plan\` first`);
  const byArchive = new Map();
  for (const r of rows) {
    if (origin && r.origin !== origin) continue;
    const k = `${r.origin}|${r.archive}`;
    if (!byArchive.has(k)) {
      byArchive.set(k, { origin: r.origin, archive: r.archive, seq: Number(r.seq), paths: [] });
    }
    byArchive.get(k).paths.push(r.path);
  }
  // Ascending sequence, so a later patch's copy of a file overwrites an earlier
  // one — the same reason the index is overlaid by sequence.
  return [...byArchive.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Fetch one archive's planned files by range read.
 *
 * `written` counts files put on disk, `requests` the round trips spent, and
 * `bytes` only what was actually transferred — the point of the exercise.
 */
export async function fetchArchive(step, { force = false, onProgress } = {}) {
  const origin = ORIGINS[step.origin];
  if (!origin) throw new Error(`unknown origin in plan: ${step.origin}`);
  const mirror = ensureDir(paths.mirrorDir(step.origin));

  const wanted = new Map(); // normalized path -> destination
  for (const p of step.paths) {
    const safe = sanitizePath(p);
    if (safe) wanted.set(normalizePath(p), join(mirror, safe));
  }
  // Resume: a mirror is built over many runs, and re-reading a file that is
  // already there is pure waste.
  let mirrored = 0;
  if (!force) {
    for (const [norm, dest] of wanted) {
      if (!existsSync(dest)) continue;
      wanted.delete(norm);
      mirrored++;
    }
  }
  // `skipped` counts every file resume stepped over, not only the archives it
  // skipped whole. Counting only the whole ones made the run summary 14,304
  // files short of the plan, which reads like lost data and is not: a partly
  // mirrored archive still contributes its untouched files here.
  const stats = {
    archive: step.archive,
    requests: 0,
    bytes: 0,
    written: 0,
    missing: 0,
    skipped: mirrored,
  };
  if (!wanted.size) return stats;

  const url = `${origin.files}/${step.archive}`;
  const listed = await listRemote(url);
  stats.requests += 2;
  stats.bytes += listed.tableBytes ?? 0;
  if (listed.blocked) {
    stats.blocked = listed.blocked;
    stats.missing = wanted.size;
    return stats;
  }

  // Directory entries are dropped before anything else: the index that built
  // the plan carried them, and writing one puts an empty file where a
  // directory has to go. See `fileEntries`.
  const entries = fileEntries(listed.files).filter((f) =>
    wanted.has(normalizePath(f.filename)),
  );
  stats.missing = wanted.size - entries.length;

  const ranges = coalesceSpans(entrySpans(entries));
  stats.plannedRequests = rangeCost(ranges).requests;
  for (const range of ranges) {
    const buf = await readRange(url, range.start, range.end);
    stats.requests++;
    stats.bytes += buf.length;
    for (const s of range.spans) {
      const at = s.start - range.start;
      // A short read means the span was clipped; writing a truncated sprite is
      // worse than leaving it absent, so skip and let the count show it.
      if (at + s.length > buf.length) {
        stats.missing++;
        continue;
      }
      let data;
      try {
        data = decodeGrfEntry(Buffer.from(buf.subarray(at, at + s.length)), s.entry);
      } catch {
        stats.missing++;
        continue;
      }
      const dest = wanted.get(normalizePath(s.entry.filename));
      if (!dest) continue;
      // A sprite is never empty. An empty payload means the entry was not the
      // file we took it for, and writing it would shadow the real one.
      if (!data.length) {
        stats.missing++;
        continue;
      }
      // One unwritable path must not end a run that takes hours: a name the
      // filesystem refuses, or a collision with a directory this archive also
      // carries, is counted and stepped over.
      try {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, data);
        stats.written++;
      } catch (err) {
        stats.failed = (stats.failed ?? 0) + 1;
        onProgress?.({ msg: `  ! ${dest}: ${err.code ?? err.message}` });
      }
    }
    onProgress?.({
      msg: `  ${step.archive}: ${stats.written} file(s), ${stats.requests} request(s)`,
    });
  }
  return stats;
}

/** Walk the whole plan. */
export async function fetchPlan({
  origin,
  file,
  limit = Infinity,
  dryRun = false,
  force = false,
  onProgress,
} = {}) {
  const steps = readPlan({ origin, file }).slice(0, limit === Infinity ? undefined : limit);
  const totals = {
    archives: 0,
    requests: 0,
    bytes: 0,
    written: 0,
    missing: 0,
    skipped: 0,
    blocked: 0,
    failed: 0,
  };
  for (const step of steps) {
    totals.archives++;
    if (dryRun) {
      onProgress?.({
        msg: `would read ${step.paths.length} file(s) from ${step.origin}/${step.archive}`,
      });
      continue;
    }
    const r = await fetchArchive(step, { force, onProgress });
    totals.requests += r.requests;
    totals.bytes += r.bytes;
    totals.written += r.written;
    totals.missing += r.missing;
    totals.skipped += r.skipped;
    totals.failed += r.failed ?? 0;
    if (r.blocked) totals.blocked++;
    onProgress?.({
      msg:
        `${step.origin}/${step.archive} (seq ${step.seq}) -> ${r.written} written, ` +
        `${r.requests} request(s)${r.blocked ? ` [${r.blocked}]` : ""}` +
        `${r.skipped ? ` [${r.skipped} already mirrored]` : ""}`,
    });
  }
  return totals;
}
