// Stage 4 — fetch and extract only the sprites on the shortlist.
//
// For each wanted sprite name, the stage-1 path index already says which
// archives of this origin contain it. Take the newest archive per file, download
// those archives, and extract in ascending sequence order so a later patch
// overwrites an earlier one — which is the whole reason a patch history can
// stand in for a client: patches carry whole files, not binary deltas.
//
// Path shapes, read off real twRO tables rather than assumed:
//
//   data\sprite\악세사리\남\남_C_Chained_Bear.{act,spr}     headgear, per sex
//   data\sprite\악세사리\여\여_C_Chained_Bear.{act,spr}
//   data\sprite\로브\C_S_Thanatos_Wing\...                   garment
//   data\sprite\이팩트\C_S_Thanatos_Wing\...                 wing/effect sprite
//
// An AccName value already carries the leading underscore (`_C_Chained_Bear`),
// so the headgear file is literally <sex> + <accName>. Garment and effect folders
// drop it.
//
// Each origin extracts into its own tree, never a shared one. Two reasons, both
// load-bearing: the same view id resolves to a different filename on jRO (2007,
// 2696), and ragassets bakes the skin-tone table and the robe pruning per
// sprite, so those passes run per tree.

import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { download } from "./net.mjs";
import { normalizePath, targetsFor } from "./pathshapes.mjs";
import { EXTRACTOR, paths, ensureDir, readRows, streamRows } from "./store.mjs";

const execFileAsync = promisify(execFile);

/**
 * Shortlist rows this origin can actually supply.
 *
 * Rows the client itself marks as ordinary equipment are skipped: 153 of the 981
 * missing views are things like the Adventurer's Backpack, which the app leaves
 * out on purpose, and their sprites live in the same multi-hundred-MB client
 * patches as everything else. A row with no flag is kept — only kRO and jRO
 * views lack one, and "unknown" is not "no".
 */
function wantedFor(originId, { includeEquipment = false } = {}) {
  const rows = readRows(paths.shortlist());
  if (!rows.length) throw new Error("no shortlist on disk — run stage 3 first");
  return rows.filter(
    (r) =>
      r.need === "yes" &&
      r.sprite &&
      r.origins.split(",").includes(originId) &&
      (includeEquipment || r.costume !== "no"),
  );
}

export async function fetchAssets(
  origin,
  { limit = Infinity, dryRun = false, includeEquipment = false, onProgress } = {},
) {
  const wanted = wantedFor(origin.id, { includeEquipment });
  // One prefix per shape, mapped back to the view that asked for it.
  const targets = [];
  for (const row of wanted) {
    // The row's kind decides the shape: a headgear is two files named after the
    // sprite, a garment is a folder named by the robe table.
    for (const t of targetsFor(row.kind, row.sprite)) {
      targets.push({ prefix: t, key: `${row.kind}:${row.view}`, sprite: row.sprite });
    }
  }

  // Walk the path index once: for every file whose normalized path matches a
  // wanted prefix, remember the newest archive that carries it.
  const bestByPath = new Map(); // normalized path -> {seq, archive, path}
  const hitViews = new Set();
  for await (const r of streamRows(paths.pathsFile(origin.id))) {
    const norm = normalizePath(r.path);
    // Cheap gate first: the index is mostly textures, lua and maps, and
    // matching every row against ~1,200 prefixes would dominate the run.
    if (!norm.includes("/sprite/")) continue;
    const hit = targets.find((t) => norm.includes(t.prefix));
    if (!hit) continue;
    hitViews.add(hit.key);
    const seq = Number(r.seq);
    const prev = bestByPath.get(norm);
    if (!prev || seq > prev.seq) bestByPath.set(norm, { seq, archive: r.file, path: r.path });
  }

  // Group by archive, oldest sequence first, so newer patches land last.
  const byArchive = new Map();
  for (const hit of bestByPath.values()) {
    if (!byArchive.has(hit.archive)) byArchive.set(hit.archive, { seq: hit.seq, files: [] });
    const g = byArchive.get(hit.archive);
    g.seq = Math.min(g.seq, hit.seq);
    g.files.push(hit.path);
  }
  const archives = [...byArchive.entries()]
    .sort((a, b) => a[1].seq - b[1].seq)
    .slice(0, limit === Infinity ? undefined : limit);

  const stats = {
    origin: origin.id,
    wanted: wanted.length,
    resolved: hitViews.size,
    unresolved: wanted.length - hitViews.size,
    archives: archives.length,
    downloaded: 0,
    bytes: 0,
    extracted: 0,
  };

  const mirror = ensureDir(paths.mirrorDir(origin.id));

  for (const [archive, group] of archives) {
    if (dryRun) {
      onProgress?.({ msg: `would fetch ${archive} for ${group.files.length} file(s)` });
      continue;
    }
    const local = join(paths.cacheDir(origin.id), archive);
    const got = await download(`${origin.files}/${archive}`, local);
    if (!got.cached) stats.downloaded++;
    stats.bytes += got.bytes;

    // Match on the basenames of exactly the files this archive was chosen for.
    // Escaping the dots matters: `_c_x.spr` as a regex would also match
    // `_c_xxspr`, and these trees are full of near-identical names.
    const alts = [
      ...new Set(group.files.map((p) => normalizePath(p).split("/").pop().replace(/[.]/g, "[.]"))),
    ];
    const { stderr } = await execFileAsync(
      process.execPath,
      [EXTRACTOR, "--extract", mirror, "--grf", local, "--match", `(${alts.join("|")})$`],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const n = Number(/Extracted (\d+) file/.exec(stderr ?? "")?.[1] ?? 0);
    stats.extracted += n;
    onProgress?.({
      msg: `${got.cached ? "cached" : "fetched"} ${archive} (seq ${group.seq}) -> ${n}/${group.files.length} file(s)`,
    });
  }

  return stats;
}
