// Stage 2 — build each client's own catalogue, from its own files.
//
// Finds the newest archive in the stage-1 index that carries each wanted table,
// downloads just those archives, extracts just those files, and writes:
//
//   views.tsv      view id -> sprite name (+ the ACCESSORY_ constant)
//   items.tsv      item id -> resource name
//   names.tsv      item id -> display name, in that server's language
//   costumes.tsv   the join: view id, sprite, item id, display name
//
// The join has two routes and reports which one it used. A modern client keeps
// item data in System/iteminfo_new.lub, where each entry's ClassNum IS the view
// id, so the join is exact. Where that file is absent the only route is the old
// `idnum2item*table.txt` pair plus the client's naming convention: an accessory
// sprite is the item's resource name with a leading underscore (item `고글` ->
// accessory `_고글`). Checked, not assumed — the run reports both counts, and a
// view with no item at all is normal (that is exactly the 1,054
// renderable-but-unlisted costumes this whole project is about).
//
// Measured, twRO: 2,339 of 2,432 matched views came from ClassNum, and only 93
// needed the convention.
//
// This is the stage that answers the naming problem without any new asset: a
// costume with no LATAM item still has an English name on iRO, a Japanese one on
// jRO and a Chinese one on twRO.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { download } from "./net.mjs";
import { normalizePath } from "./grf.mjs";
import {
  joinAccessories,
  joinRobes,
  readAegisNames,
  readResourceTable,
  readDisplayNameTable,
} from "./lubtables.mjs";
import { ITEM_INFO_FILES, ITEM_INFO_TAILS, readItemInfo } from "./iteminfo.mjs";
import { legacyNameCoverage } from "./coverage.mjs";
import { findInRgz } from "./rgzprobe.mjs";
import { EXTRACTOR, paths, ensureDir, readRows, streamRows, writeRows } from "./store.mjs";

const execFileAsync = promisify(execFile);

// Each wanted file, by the tail of its normalized path. `iteminfo_new.lub` is
// the modern item table and the .txt pair is what older clients shipped; an
// origin may have either, both, or — twRO — only the one inside a .rgz.
const WANTED = [
  { key: "accessoryId", tail: "datainfo/accessoryid.lub" },
  { key: "accName", tail: "datainfo/accname.lub" },
  // Two spellings, iRO's being the bare one — see ITEM_INFO_FILES.
  { key: "itemInfo", tail: ITEM_INFO_TAILS },
  { key: "itemRes", tail: "idnum2itemresnametable.txt" },
  { key: "itemName", tail: "idnum2itemdisplaynametable.txt" },
  { key: "robeId", tail: "datainfo/spriterobeid.lub" },
  // The data table, not SpriteRobeName_F.lub — the `_F` file is a set of
  // functions (ReqRobSprName, IsTopLayer) that *read* RobeNameTable, and every
  // client ships both. Matching the prefix picked whichever copy had the higher
  // sequence, which on iRO was the function file, and the catalogue came out
  // with 337 garment views and not one name.
  { key: "robeName", tail: "datainfo/spriterobename.lub" },
  { key: "aegisName", tail: "lua files/itemdbnametbl.lub" },
];

const tailsOf = (want) => (Array.isArray(want.tail) ? want.tail : [want.tail]);
const matches = (want, normPath) => tailsOf(want).some((t) => normPath.endsWith(t));

/**
 * Newest *extractable* archive per wanted file, out of the stage-1 index.
 *
 * "Extractable" is the whole point of this function. jRO's current AccName sits
 * in a v0x300 `.gsf` and kRO's in a `.gsf`/`.gef`, and those list but do not
 * extract — taking the newest copy would download 100 MB and parse nothing. The
 * stage-1 ledger already recorded which archives are blocked, so this skips
 * them and reports the newer copy it had to pass over, rather than pretending
 * the table it used is current.
 */
export async function locateTables(originId) {
  const status = new Map();
  for (const row of readRows(paths.archives(originId))) status.set(row.file, row.status);

  const best = new Map(); // key -> newest extractable
  const skipped = new Map(); // key -> newest blocked, if newer than `best`
  for await (const row of streamRows(paths.pathsFile(originId))) {
    const norm = normalizePath(row.path);
    for (const want of WANTED) {
      if (!matches(want, norm)) continue;
      const seq = Number(row.seq);
      const hit = { seq, archive: row.file, path: row.path, key: want.key };
      if (status.get(row.file) === "ok") {
        const prev = best.get(want.key);
        if (!prev || seq > prev.seq) best.set(want.key, hit);
      } else {
        const prev = skipped.get(want.key);
        if (!prev || seq > prev.seq) skipped.set(want.key, hit);
      }
    }
  }
  for (const [key, hit] of skipped) {
    const chosen = best.get(key);
    if (chosen && hit.seq > chosen.seq) {
      chosen.newerBlocked = `${hit.archive} (seq ${hit.seq})`;
    } else if (!chosen) {
      // Nothing readable at all for this table: record it so the caller can say
      // so instead of silently producing an empty catalogue.
      best.set(key, { ...hit, blocked: true });
    }
  }
  return best;
}

/** Where extract-grf.mjs put a file whose GRF path ended with `tail`. */
function findExtracted(root, tail) {
  // Several candidates resolve by *candidate* order, not by the order the
  // directory walk happens to reach them, so a client shipping both spellings
  // still yields the preferred one.
  const wants = (Array.isArray(tail) ? tail : [tail]).map((t) => t.toLowerCase());
  const best = new Map();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      const norm = normalizePath(full);
      const i = wants.findIndex((w) => norm.endsWith(w));
      if (i >= 0 && !best.has(i)) best.set(i, full);
    }
  }
  for (let i = 0; i < wants.length; i++) if (best.has(i)) return best.get(i);
  return null;
}

async function extractFrom(origin, archive, matchRe, outDir) {
  const url = `${origin.files}/${archive}`;
  const local = join(paths.cacheDir(origin.id), archive);
  const got = await download(url, local);
  await execFileAsync(
    process.execPath,
    [EXTRACTOR, "--extract", outDir, "--grf", local, "--match", matchRe],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return { local, bytes: got.bytes, cached: got.cached };
}

export async function catalogueOrigin(origin, { onProgress, probeRgz = true, rgzLimit = 12 } = {}) {
  const located = await locateTables(origin.id);
  if (!located.size) {
    throw new Error(`no indexed paths for ${origin.id} — run stage 1 first`);
  }

  const outDir = ensureDir(join(paths.catalogDir(origin.id), "raw"));
  ensureDir(paths.catalogDir(origin.id));

  // One extraction per archive, even when it holds several wanted files. An
  // archive we know we cannot extract is never downloaded.
  const byArchive = new Map();
  for (const hit of located.values()) {
    if (hit.blocked) continue;
    if (!byArchive.has(hit.archive)) byArchive.set(hit.archive, []);
    byArchive.get(hit.archive).push(hit);
  }

  const fetched = [];
  for (const [archive, hits] of byArchive) {
    const matchRe = hits
      .map((h) => normalizePath(h.path).split("/").pop().replace(/[.]/g, "[.]"))
      .join("|");
    const res = await extractFrom(origin, archive, `(${matchRe})$`, outDir);
    fetched.push({ archive, hits: hits.map((h) => h.key), ...res });
    onProgress?.({ origin: origin.id, archive, keys: hits.map((h) => h.key), ...res });
  }

  // --- views: two namespaces, kept apart ---
  // A headgear view id and a garment view id are different numbers in different
  // spaces, and the same small value means a different costume in each.
  const idFile = located.has("accessoryId") ? findExtracted(outDir, "accessoryid.lub") : null;
  const nameFile = located.has("accName") ? findExtracted(outDir, "accname.lub") : null;
  const robeIdFile = located.has("robeId") ? findExtracted(outDir, "spriterobeid.lub") : null;
  // The robe name file is spelled differently per server, so take the basename
  // from the path the index actually matched.
  const robeNameTail = located.get("robeName")
    ? normalizePath(located.get("robeName").path).split("/").pop()
    : null;
  const robeNameFile = robeNameTail ? findExtracted(outDir, robeNameTail) : null;
  const result = { origin: origin.id, fetched, located: [...located.values()] };

  if (idFile && nameFile) {
    const { rows, stats } = joinAccessories(idFile, nameFile);
    writeRows(
      join(paths.catalogDir(origin.id), "views.tsv"),
      ["view", "sprite", "accessoryKey"],
      rows.map((r) => [r.view, r.sprite ?? "", r.key]),
    );
    result.views = { count: rows.length, ...stats };
    result.viewRows = rows;
  } else {
    result.views = { count: 0, note: "accessory tables not found in the index" };
    result.viewRows = [];
  }

  if (robeIdFile && robeNameFile) {
    const { rows, stats } = joinRobes(robeIdFile, robeNameFile);
    writeRows(
      join(paths.catalogDir(origin.id), "robes.tsv"),
      ["view", "sprite", "spriteEng", "robeKey"],
      rows.map((r) => [r.view, r.sprite ?? "", r.spriteEng ?? "", r.key]),
    );
    result.robes = { count: rows.length, ...stats };
    result.robeRows = rows;
  } else {
    result.robes = { count: 0, note: "robe tables not found in the index" };
    result.robeRows = [];
  }

  // --- items + names ---
  // Two sources, and the modern one wins. System/iteminfo_new.lub carries
  // ClassNum, which IS the view id, so the join below is exact; the old .txt
  // pair has only resource names, which the join has to match by the client's
  // naming convention. twRO has dropped the .txt files altogether — its item
  // data arrives in a .rgz, which has no file table to range-read, so when the
  // stage-1 index has no copy the newest client patches get probed for one.
  let itemInfoFile =
    located.has("itemInfo") && !located.get("itemInfo").blocked
      ? findExtracted(outDir, ITEM_INFO_FILES)
      : null;
  let itemInfoFrom = itemInfoFile ? "grf" : null;

  // Read the legacy pair first, because it decides whether probing is worth
  // anybody's bandwidth.
  const resFile = findExtracted(outDir, "idnum2itemresnametable.txt");
  const nameTblFile = findExtracted(outDir, "idnum2itemdisplaynametable.txt");
  const legacyRes = resFile ? readResourceTable(resFile) : new Map();
  const legacyNames = nameTblFile ? readDisplayNameTable(nameTblFile, origin.encoding) : new Map();

  // A .rgz has to be downloaded whole to see inside it, so the probe needs a
  // trigger, and "are the .txt tables missing?" is the wrong one — three of the
  // six origins ship .txt files that do not answer the question:
  //
  //   twRO   277 copies of idnum2itemresnametable.txt and NO display-name
  //          table, so the .txt pair names nothing at all.
  //   kRO    both tables, but an ancient pair: 7,170 items, which name 553 of
  //          its 2,734 views.
  //   jRO    both tables, current enough to name 2,184 views — and probing it
  //          spent 41 MB over 12 patches (two of them an 18 MB Ragexe) to find
  //          nothing, because its iteminfo sits in the blocked v0x300 .gsf.
  //
  // So the trigger is coverage: probe when what we already have fails to name
  // half the views this client defines. That is a measurement of this client,
  // not a guess about which files a region ships.
  const namedSprites = new Set();
  for (const [id, res] of legacyRes) {
    if (legacyNames.has(id)) namedSprites.add(`_${res}`.toLowerCase());
  }
  let withSprite = 0;
  let namedByLegacy = 0;
  for (const r of result.viewRows) {
    if (!r.sprite) continue;
    withSprite++;
    if (namedSprites.has(r.sprite.toLowerCase())) namedByLegacy++;
  }
  const legacyCoverage = withSprite ? namedByLegacy / withSprite : 0;
  // Probe only when what we already have fails to explain this client — see
  // coverage.mjs for why the presence of the .txt files is the wrong test.
  const legacy = legacyNameCoverage({ viewRows: result.viewRows, legacyRes, legacyNames });
  if (!itemInfoFile && probeRgz && legacy.thin) {
    onProgress?.({
      origin: origin.id,
      rgz: { why: `.txt tables name ${legacy.label} (${(legacy.ratio * 100).toFixed(0)}%)` },
    });
    const probe = await findInRgz(origin, ITEM_INFO_TAILS, {
      limit: rgzLimit,
      outDir,
      onProgress: (p) => onProgress?.({ origin: origin.id, rgz: p }),
    });
    result.rgzProbe = probe;
    if (probe.found) {
      itemInfoFile = probe.path;
      itemInfoFrom = `rgz:${probe.archive}`;
    }
  }

  const info = itemInfoFile ? readItemInfo(itemInfoFile) : null;
  const itemRes = new Map();
  const itemNames = new Map();
  if (info) {
    for (const [id, it] of info.items) {
      if (it.resource) itemRes.set(id, it.resource);
      if (it.name) itemNames.set(id, it.name);
    }
  }

  // Where both exist, the legacy pair fills gaps: a client that ships
  // iteminfo_new.lub keeps the .txt around for a while, and an id in one and not
  // the other is free coverage.
  let fromLegacy = 0;
  for (const [id, res] of legacyRes) {
    if (!itemRes.has(id)) {
      itemRes.set(id, res);
      fromLegacy++;
    }
  }
  for (const [id, n] of legacyNames) if (!itemNames.has(id)) itemNames.set(id, n);

  if (itemRes.size) {
    writeRows(
      join(paths.catalogDir(origin.id), "items.tsv"),
      ["item", "resource"],
      [...itemRes].map(([id, res]) => [id, res]),
    );
  }
  if (itemNames.size) {
    writeRows(
      join(paths.catalogDir(origin.id), "names.tsv"),
      ["item", "name"],
      [...itemNames].map(([id, n]) => [id, n]),
    );
  }
  result.items = {
    resources: itemRes.size,
    names: itemNames.size,
    legacyNamed: legacy.label,
    source: itemInfoFrom
      ? `iteminfo (${itemInfoFrom})${fromLegacy ? " + .txt" : ""}`
      : "legacy .txt tables",
    iteminfo: info?.stats ?? null,
    legacy: { resources: legacyRes.size, names: legacyNames.size, filledGaps: fromLegacy },
  };

  // --- the join ---
  // The item's resource name decides which namespace it belongs to, and that is
  // what makes the view id meaningful:
  //
  //   "_" + resource is an accessory sprite  -> headgear, that view id
  //   resource is a robe sprite (the Korean
  //   folder name, which is the same string) -> garment, that view id
  //   neither                                -> not a costume (weapon, armour,
  //                                             card, consumable): dropped
  //
  // ClassNum is the item's view id *inside* its namespace, so it cannot pick the
  // namespace by itself: ClassNum 2 is a sword, headgear view 2 is a cat-ear
  // hairband and garment view 2 is an adventurer's backpack. It is used here as
  // a cross-check, and the disagreements are reported rather than hidden.
  const accViewOfSprite = new Map();
  for (const r of result.viewRows) {
    if (r.sprite) accViewOfSprite.set(r.sprite.toLowerCase(), r.view);
  }
  const robeViewOfSprite = new Map();
  for (const r of result.robeRows) {
    for (const n of [r.sprite, r.spriteEng]) {
      if (n) robeViewOfSprite.set(n.toLowerCase(), r.view);
    }
  }

  // kind -> view -> item id. Several items share one view, so the pick matters:
  // **a named item always beats an unnamed one**, and among named ones the
  // lowest id wins. A costume gets re-gifted as a new item every few years and
  // the first one Gravity shipped is the one whose name describes the art rather
  // than the event that handed it out — but the oldest item of all is often a
  // pre-costume hat the client no longer names, and taking that one by id threw
  // away the name on 430 of LATAM's views.
  const byKind = { acc: new Map(), robe: new Map() };
  // Ranked, highest first: having a name at all, then being the costume version
  // (the app shows "[Visual] Óculos Elegantes", not the 2005 hat "Óculos
  // Charmoso", for the same art), then the lowest id.
  const rank = (id) => [itemNames.has(id) ? 1 : 0, info?.items.get(id)?.costume ? 1 : 0];
  const better = (id, prev) => {
    if (prev === undefined) return true;
    const a = rank(id);
    const b = rank(prev);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return id < prev;
  };
  const check = { agree: 0, disagree: 0, noClassNum: 0, unplaced: 0 };
  for (const [id, res] of itemRes) {
    const low = res.toLowerCase();
    let kind = null;
    let view = accViewOfSprite.get(`_${low}`);
    if (view !== undefined) kind = "acc";
    else {
      view = robeViewOfSprite.get(low);
      if (view !== undefined) kind = "robe";
    }
    if (kind === null) {
      // An item with a view id we cannot place in either namespace: almost all
      // of these are weapons, whose ClassNum is a third numbering.
      if (info?.items.get(id)?.view) check.unplaced++;
      continue;
    }
    const claimed = info?.items.get(id)?.view ?? 0;
    if (!claimed) check.noClassNum++;
    else if (claimed === view) check.agree++;
    else check.disagree++;
    if (better(id, byKind[kind].get(view))) byKind[kind].set(view, id);
  }

  const costumes = [];
  const counts = { acc: 0, robe: 0, accNamed: 0, robeNamed: 0 };
  for (const [kind, rows] of [
    ["acc", result.viewRows],
    ["robe", result.robeRows],
  ]) {
    for (const r of rows) {
      const item = byKind[kind].get(r.view);
      const name = item !== undefined ? (itemNames.get(item) ?? "") : "";
      if (item !== undefined) counts[kind]++;
      if (name) counts[`${kind}Named`]++;
      // Whether the client itself calls this a costume. A view can be real,
      // named and drawable and still be ordinary equipment — garment view 2 is
      // the Adventurer's Backpack — which the app does not list on purpose. Only
      // iteminfo carries the flag, so it is "" where we read the .txt tables.
      const flag = info?.items.get(item);
      costumes.push([
        kind,
        r.view,
        r.sprite ?? "",
        item ?? "",
        name,
        flag === undefined ? "" : flag.costume ? "yes" : "no",
      ]);
    }
  }
  if (costumes.length) {
    writeRows(
      join(paths.catalogDir(origin.id), "costumes.tsv"),
      ["kind", "view", "sprite", "item", "name", "costume"],
      costumes,
    );
  }
  result.classNum = check;

  // --- aegis names ---
  // item id -> the English server-side identifier. Written per origin even
  // though every client agrees on it, because the catalogue is per origin and
  // whichever one is read first should be usable on its own.
  const aegisFile = located.has("aegisName") ? findExtracted(outDir, "itemdbnametbl.lub") : null;
  const aegis = aegisFile ? readAegisNames(aegisFile) : new Map();
  if (aegis.size) {
    writeRows(
      join(paths.catalogDir(origin.id), "aegis.tsv"),
      ["item", "aegis"],
      [...aegis].map(([id, name]) => [id, name]),
    );
  }
  result.aegis = aegis.size;
  result.join = {
    acc: { views: result.viewRows.length, withItem: counts.acc, withName: counts.accNamed },
    robe: { views: result.robeRows.length, withItem: counts.robe, withName: counts.robeNamed },
  };
  delete result.viewRows;
  delete result.robeRows;
  return result;
}

export function catalogueExists(originId) {
  const f = join(paths.catalogDir(originId), "views.tsv");
  return existsSync(f) && statSync(f).size > 0;
}
