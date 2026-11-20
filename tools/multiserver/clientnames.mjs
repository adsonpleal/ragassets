// What every client calls a costume, keyed by the sprite name they share.
//
// The catalogue has always carried one `name` and the id of the client it came
// from, chosen by this pipeline's own order. That throws away the other six
// answers, and a consumer that wants to pick by language — English first, say —
// cannot, because the choice was already made upstream. This module keeps all
// of them.
//
// The join is the same one the item-id question uses, and it is not the view
// id. A client's `items.tsv` maps item id -> resource name, and a costume's
// resource name IS its sprite name, so inverting that table turns a sprite into
// that client's item ids, and `names.tsv` turns those into its display name.
// Going through the view id instead would be narrower and wrong: view ids are
// one global table, so they say nothing about which client actually has a name.
//
// Measured over the 663 costumes in the 2026-11-19 catalogue:
//
//   jro 455   twro 445   thro 316   twrozero 216   iro 99   latam 76
//   kro 71   krozero 0
//
// 624 of 663 get a name from at least one client and 390 from more than one.
// kRO Zero ships no item table and no name table at all, so it can never appear
// as a key here.
//
// thRO is the second English source, added 2026-11-19. Its table is English
// despite the client being Thai — 18,843 of its 18,889 names are pure ASCII and
// 28 carry any Thai script — and it names 237 costumes iRO cannot, so an
// English-first order now yields English on 336 of 663 rather than 99. That
// retires the claim this comment used to make, that the English gap could not
// be closed from these clients: it could, by adding one.
// See docs/per-client-names.md.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readItemInfo } from "./iteminfo.mjs";
import { ORIGINS } from "./origins.mjs";
import { paths, readRows } from "./store.mjs";

/**
 * The key both sides of the join are reduced to.
 *
 * Lowercased because every path under `data/` is, and the leading underscore of
 * an accessory name is dropped because it is a marker in the accessory tables
 * and not part of the resource — no resource in any client's item table starts
 * with one. This is the same normalisation `/icons/costume` applies, on purpose:
 * a consumer that can fetch the icon for a sprite can look up its names with
 * the same string.
 */
export const normResource = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/^_+/, "");

/**
 * `idnum2itemdisplaynametable.txt` stores display names underscore-joined and
 * the client renders them with spaces — the file literally reads
 * `19507#Costume:_Shining_Sun#`. 7,379 of iRO's 8,367 names carry an underscore
 * and 132 carry a space, so publishing them raw would push a client-rendering
 * quirk onto every consumer.
 *
 * Only the clients read through that file need it. The ones read through
 * `iteminfo_new.lub` already hold spaced names, and running this over them
 * would damage any name that legitimately contains an underscore.
 */
export const spaceOut = (s) => String(s ?? "").replace(/_/g, " ").trim();

/**
 * Names the clients ship for rows that are not really items: unreleased stubs,
 * internal markers, and the literal placeholder some tables use.
 */
export const isPlaceholderName = (s) =>
  !s || !String(s).trim() || /^#/.test(s) || /sprite\s*name/i.test(s);

/**
 * Collapse one client's candidates for a sprite into one name.
 *
 * A resource name is not unique to one item — `_햇` is six of them, because
 * Gravity re-issues a look as a new item — so a client can offer several
 * distinct names for one sprite. The tie-break prefers an id that
 * `iteminfo_new.lub` flags as a costume, since the catalogue's rows are
 * costumes; failing that it takes the lowest id, which is the original release.
 *
 * This is a convention, not a fact: 212 of the 663 have several costume-flagged
 * candidates and the flag cannot separate them.
 */
function pickName(ids, nameById, isCostume) {
  const byName = new Map();
  for (const id of [...ids].sort((a, b) => a - b)) {
    const raw = nameById.get(id);
    if (isPlaceholderName(raw)) continue;
    if (!byName.has(raw)) byName.set(raw, id);
  }
  if (!byName.size) return null;
  for (const [name, id] of byName) if (isCostume(id)) return name;
  return [...byName.keys()][0];
}

/**
 * Build sprite -> { origin: name } from each client's own two tables.
 *
 * `tables` is injected so this can be tested without a state root: one entry
 * per client, `items` as [itemId, resourceName] pairs, `names` as a Map of
 * item id -> the raw string that client's table holds, and `underscored`
 * saying whether that string needs `spaceOut`.
 */
export function clientNamesBySprite({ tables = [], isCostume = () => false } = {}) {
  const out = new Map();
  for (const { origin, items = [], names, underscored = false } of tables) {
    if (!names || !names.size) continue;
    // sprite -> every item id that client gives that resource name
    const idsBySprite = new Map();
    for (const [id, resource] of items) {
      if (!resource) continue;
      const k = normResource(resource);
      if (!idsBySprite.has(k)) idsBySprite.set(k, new Set());
      idsBySprite.get(k).add(Number(id));
    }
    for (const [sprite, ids] of idsBySprite) {
      const raw = pickName(ids, names, isCostume);
      if (raw === null) continue;
      const display = underscored ? spaceOut(raw) : String(raw).trim();
      if (isPlaceholderName(display)) continue;
      if (!out.has(sprite)) out.set(sprite, {});
      out.get(sprite)[origin] = display;
    }
  }
  return out;
}

/**
 * Read the tables off the state root.
 *
 * Whether a client's names need `spaceOut` is decided by which file stage 2
 * actually read for it, not by a list of client ids: the underscore convention
 * belongs to `idnum2itemdisplaynametable.txt`, so the presence of that file in
 * the origin's extracted copies is the honest test. A client that switches to
 * `iteminfo_new.lub` in a later patch then stops being transformed without
 * anyone editing a constant here.
 */
export function readClientNameTables({ root = null } = {}) {
  const catalogDir = (o) => (root ? join(root, "catalog", o) : paths.catalogDir(o));
  const tables = [];
  const costumeIds = new Set();
  for (const origin of Object.keys(ORIGINS)) {
    const dir = catalogDir(origin);
    const itemsFile = join(dir, "items.tsv");
    const namesFile = join(dir, "names.tsv");
    if (!existsSync(itemsFile) || !existsSync(namesFile)) continue;
    const items = readRows(itemsFile).map((r) => [Number(r.item), r.resource]);
    const names = new Map(readRows(namesFile).map((r) => [Number(r.item), r.name]));
    const underscored = existsSync(join(dir, "raw", "data", "idnum2itemdisplaynametable.txt"));
    tables.push({ origin, items, names, underscored });

    const info = join(dir, "raw", "iteminfo_new.lub");
    if (existsSync(info)) {
      try {
        for (const [id, it] of readItemInfo(info).items) if (it.costume) costumeIds.add(Number(id));
      } catch {
        // A client whose iteminfo will not parse costs us the tie-break for its
        // ids, not the names themselves.
      }
    }
  }
  return { tables, isCostume: (id) => costumeIds.has(Number(id)) };
}

/** The map stage 5 joins against, read from disk. */
export function clientNamesFromDisk(opts = {}) {
  const { tables, isCostume } = readClientNameTables(opts);
  return clientNamesBySprite({ tables, isCostume });
}
