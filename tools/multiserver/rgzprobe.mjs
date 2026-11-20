// Find one wanted file inside a server's .rgz patches.
//
// A .rgz is a gzip stream of loose files with no file table, so the range-read
// trick that makes stage 1 cheap does not apply: the only way to know what is
// inside one is to download it whole. twRO alone publishes 132 of them in the
// indexed window and thousands overall, so this never sweeps them — it probes
// the newest ones until it finds the file, and remembers what it saw.
//
// Ordering is the whole economy of this module. The hit is almost always in a
// `*_live_client_*.rgz`, which is where a client-side table update ships; the
// `*_Raghash_*.rgz` ones carry only RagHash.dat. So client patches are tried
// first, newest first, and everything else after. Finding twRO's
// iteminfo_new.lub took 1 download of 2.5 MB.
//
// Every probe is written to index/<origin>/rgzprobe.tsv, so a second run (for a
// different wanted file, or after an interrupted one) re-reads the local copy
// instead of the network.

import { basename, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { download } from "./net.mjs";
import { readRgz, rgzData } from "../../extract-grf.mjs";
import { normalizePath } from "./pathshapes.mjs";
import { rgzProbeOrder } from "./origins.mjs";
import { paths, appendRows, ensureDir, readRows } from "./store.mjs";

const PROBE_HEADER = ["seq", "file", "bytes", "entries", "contents"];

/**
 * Download .rgz patches newest-first until one contains a file whose normalized
 * path ends with `tail` — a string, or several candidate tails in the order
 * they are preferred — and write that file next to the other extracted tables.
 *
 * @returns {Promise<{found: boolean, path?: string, archive?: string, seq?: number,
 *   tried: number, bytes: number, fromCache: number}>}
 */
export async function findInRgz(origin, tail, { limit = 12, outDir, onProgress } = {}) {
  const wants = (Array.isArray(tail) ? tail : [tail]).map((t) => t.toLowerCase());
  // The ledger lives beside rgz.tsv rather than in it: rgz.tsv is stage 1's
  // record of what exists; this is a record of what was opened.
  const ledger = paths.rgz(origin.id) + ".probe";
  const probed = new Map();
  for (const r of readRows(ledger)) probed.set(r.file, r);

  const order = rgzProbeOrder(readRows(paths.rgz(origin.id)));
  if (!order.length) {
    return { found: false, tried: 0, bytes: 0, fromCache: 0, note: "no .rgz in the index" };
  }

  const out = { found: false, tried: 0, bytes: 0, fromCache: 0 };
  for (const row of order) {
    // Already opened in an earlier probe: trust the recorded contents.
    const seen = probed.get(row.file);
    if (seen && !seen.contents.split("|").some((p) => wants.some((w) => p.endsWith(w)))) continue;
    if (out.tried >= limit) break;
    out.tried++;

    const local = join(paths.cacheDir(origin.id), row.file);
    let got;
    try {
      got = await download(`${origin.files}/${row.file}`, local);
    } catch (err) {
      onProgress?.({ archive: row.file, error: err.message });
      continue;
    }
    if (got.cached) out.fromCache++;
    out.bytes += got.bytes;

    let parsed;
    try {
      parsed = readRgz(readFileSync(local));
    } catch (err) {
      onProgress?.({ archive: row.file, error: `unreadable: ${err.message}` });
      continue;
    }
    const files = parsed.entries.filter((e) => e.type === "file");
    if (!seen) {
      appendRows(ledger, PROBE_HEADER, [
        [
          row.seq,
          row.file,
          got.bytes,
          files.length,
          // Capped: a client patch can carry thousands of files and the ledger
          // only has to be able to rule an archive out next time.
          files
            .slice(0, 200)
            .map((e) => normalizePath(e.name))
            .join("|"),
        ],
      ]);
    }

    // By candidate first, not by position in the archive: where a client ships
    // two of them, the preferred name must win whatever order they are stored in.
    const hit = wants
      .flatMap((w) => files.filter((e) => normalizePath(e.name).endsWith(w)))
      .at(0);
    onProgress?.({
      archive: row.file,
      seq: Number(row.seq),
      files: files.length,
      bytes: got.bytes,
      cached: got.cached,
      hit: Boolean(hit),
    });
    if (!hit) continue;

    const dest = join(ensureDir(outDir ?? join(paths.catalogDir(origin.id), "raw")), basename(normalizePath(hit.name)));
    writeFileSync(dest, rgzData(parsed, hit));
    return { ...out, found: true, path: dest, archive: row.file, seq: Number(row.seq) };
  }
  return out;
}
