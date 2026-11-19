// Stage 1 — index every archive of an origin without downloading any of them.
//
// This is the stage the whole plan rests on: once the index exists, every later
// question ("which patch has AccName.lub?", "where is this sprite?") is a local
// grep instead of a download. Measured cost for all six origins is ~85 MB and a
// few hours of wall clock at one request per second per host.
//
// Resumable by design — archives.tsv is the ledger, and an archive already in it
// is skipped. Interrupt it and run it again; it picks up where it stopped. New
// patches on a later run cost only the new archives.
//
// Archives that cannot be read are recorded with a status, never skipped in
// silence: `blocked` for kRO/jRO v0x300, `rgz` for the tableless gzip patches,
// `error` with the message for anything else. Silence is how you end up
// believing a server has no new costumes when really its format changed.

import { readRows, appendRows, paths, ensureDir, ARCHIVE_HEADER, PATH_HEADER } from "./store.mjs";
import { GRF_EXT, RGZ_EXT, parsePatchList } from "./origins.mjs";
import { fetchText } from "./net.mjs";
import { listRemote } from "./grf.mjs";

export async function indexOrigin(origin, { limit = Infinity, newestFirst = true, includePulled = false, onProgress } = {}) {
  ensureDir(paths.indexDir(origin.id));

  const text = await fetchText(origin.index);
  const all = parsePatchList(text, { includePulled });
  const archives = all.filter((e) => GRF_EXT.test(e.file) || RGZ_EXT.test(e.file));

  // The ledger is keyed by filename, not sequence: the same file can appear
  // under two sequences in these indexes, and re-reading its table twice is
  // just somebody else's bandwidth.
  const done = new Set(readRows(paths.archives(origin.id)).map((r) => r.file));

  let todo = archives.filter((e) => !done.has(e.file));
  if (newestFirst) todo = todo.reverse();
  todo = todo.slice(0, limit === Infinity ? undefined : limit);

  const stats = {
    origin: origin.id,
    inIndex: archives.length,
    known: done.size,
    scanned: 0,
    indexed: 0,
    blocked: 0,
    rgz: 0,
    errors: 0,
    entries: 0,
    tableBytes: 0,
  };

  for (const entry of todo) {
    const url = `${origin.files}/${entry.file}`;
    stats.scanned++;

    // No table to read in a .rgz; note it and move on. These are small and can
    // be downloaded whole later if stage 3 shows a gap.
    if (RGZ_EXT.test(entry.file)) {
      stats.rgz++;
      appendRows(paths.rgz(origin.id), ["seq", "file"], [[entry.seq, entry.file]]);
      appendRows(paths.archives(origin.id), ARCHIVE_HEADER, [
        [entry.seq, entry.file, "rgz", "", "", 0, 0, "rgz", "no file table"],
      ]);
      continue;
    }

    let listed;
    try {
      listed = await listRemote(url);
    } catch (err) {
      stats.errors++;
      appendRows(paths.archives(origin.id), ARCHIVE_HEADER, [
        [entry.seq, entry.file, "grf", "", "", 0, 0, "error", String(err.message).slice(0, 200)],
      ]);
      onProgress?.(stats, entry, { error: err.message });
      continue;
    }

    stats.tableBytes += listed.tableBytes ?? 0;
    const version = listed.version === undefined ? "" : `0x${listed.version.toString(16)}`;
    const status = listed.blocked ? "blocked" : "ok";
    if (listed.blocked) stats.blocked++;
    else stats.indexed++;

    appendRows(paths.archives(origin.id), ARCHIVE_HEADER, [
      [
        entry.seq,
        entry.file,
        listed.kind,
        version,
        listed.layout ?? "",
        listed.files.length,
        listed.tableBytes ?? 0,
        status,
        listed.blocked ?? "",
      ],
    ]);

    // Directory entries carry no payload (flags 0 and no size); they would
    // triple the index for nothing.
    const rows = listed.files
      .filter((f) => f.uncompSize > 0)
      .map((f) => [entry.seq, entry.file, f.filename, f.uncompSize, f.flags]);
    stats.entries += rows.length;
    appendRows(paths.pathsFile(origin.id), PATH_HEADER, rows);

    onProgress?.(stats, entry, { entries: rows.length, status });
  }

  return stats;
}
