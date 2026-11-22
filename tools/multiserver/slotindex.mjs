// Build `slots.tsv` — which slot each (kind, view) occupies.
//
// Reads only the raw item table already saved under `catalog/<origin>/raw/` by
// stage 2, so this costs no network. Five origins ship a readable one: LATAM,
// twRO, twRO Zero and thRO as `iteminfo_new.lub`, and **iRO as plain
// `itemInfo.lub`** — the filename difference `iteminfo.mjs` records, and which
// this stage spent its first life ignoring, because it asked for one name
// instead of asking that module which names exist. jRO's item data is the
// legacy `.txt` pair, which carries no description, and kRO/kRO Zero ship no
// reachable modern table at all. So a view's slot is known when any of those
// five names it — which, because item ids are global, covers plenty of
// costumes those five do not themselves offer.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ITEM_INFO_FILES, readItemInfo } from "./iteminfo.mjs";
import { bestSlot, kindFromSlots, slotRank } from "./slots.mjs";
import { paths, readRows, writeRows } from "./store.mjs";

/** Origins whose raw item table stage 2 left on disk, in order of trust. */
export function slotSources(originIds) {
  return originIds
    .map((id) => {
      const dir = join(paths.catalogDir(id), "raw");
      const path = ITEM_INFO_FILES.map((f) => join(dir, f)).find((p) => existsSync(p));
      return path ? { id, path } : null;
    })
    .filter(Boolean);
}

/**
 * Which view ids each sprite table actually defines, pooled over every client
 * catalogued on disk.
 *
 * This is the evidence for `tableFor`, and it is pooled on purpose: the two
 * numberings are Gravity's, identical across servers, so a view defined in
 * *any* client's accessory table is an accessory view. Pooling also keeps the
 * answer stable while the set of clients on disk grows.
 */
export function viewTables(originIds) {
  const tables = { acc: new Set(), robe: new Set() };
  for (const id of originIds) {
    for (const [file, kind] of [
      ["views.tsv", "acc"],
      ["robes.tsv", "robe"],
    ]) {
      const path = join(paths.catalogDir(id), file);
      if (!existsSync(path)) continue;
      for (const r of readRows(path)) {
        const view = Number(r.view);
        if (Number.isInteger(view) && view) tables[kind].add(view);
      }
    }
  }
  return tables;
}

/**
 * The sprite table this item's art lives in, which is **not** the same question
 * as the slot it equips in.
 *
 * `kindFromSlots` answers from the slot alone, and for a few costumes the two
 * disagree: the "Costume Whisper Candy Pouch" equips in the garment position,
 * so the slot says the robe table, but its `_C_Halloween_Candypouch` is in the
 * accessory table of all eight clients and in no robe table at all. Keyed by
 * the slot it became `robe:2579`, a key no client defines and the app can never
 * join against, so a costume whose position *was* read still read as having
 * none. The app models the same disagreement, from the other side, with its
 * `viewKind` field.
 *
 * The rule is deliberately narrow: only a candidate namespace that defines the
 * view **nowhere** gives way, and only to one that does. A view both tables
 * define is two different costumes and the slot is the only thing that can tell
 * them apart, so it is left alone.
 */
export function tableFor(view, slots, tables) {
  const kind = kindFromSlots(slots);
  if (!kind || !tables) return kind;
  const other = kind === "acc" ? "robe" : "acc";
  if (!tables[kind]?.has(view) && tables[other]?.has(view)) return other;
  return kind;
}

/**
 * Merge every source into one (kind, view) -> slots map.
 *
 * A view can be named by several origins and by several items within one, and
 * they do disagree: 201 pairs of items name different slots for the same view.
 * The order of preference, strongest first:
 *
 *   1. the earlier source. `sources` comes in origin order, LATAM first, and
 *      LATAM is the server the app actually simulates — where it defines a
 *      view, it is the authority on that view, and a foreign client's item for
 *      the same number is the one more likely to be stale or re-gifted. This
 *      ordering is what takes agreement with the app from 1,227/1,239 to
 *      1,231/1,239. The 5 that still differ are views where the app and this
 *      index pick a *different item* for the same view, and the two items
 *      genuinely carry different slot sets — not a parsing disagreement.
 *   2. an item the client flags as a costume, over one it does not.
 *   3. the lowest item id — the same tiebreak stage 2 uses, and for the same
 *      reason: Gravity re-gifts a costume as a new item every few years, and
 *      the oldest one describes the art rather than the event that handed it
 *      out.
 */
export function mergeSlots(sources, tables = null) {
  const out = new Map(); // "kind:view" -> {kind, view, slots, origin, item, costume, rank}
  const stats = { sources: 0, items: 0, withEquip: 0, views: 0, conflicts: 0, retabled: 0 };
  for (const [rank, src] of sources.entries()) {
    stats.sources++;
    const { items } = readItemInfo(src.path);
    for (const [id, it] of items) {
      stats.items++;
      if (!it.view || !it.equip.length) continue;
      stats.withEquip++;
      const kind = tableFor(it.view, it.equip, tables);
      if (!kind) continue;
      if (kind !== kindFromSlots(it.equip)) stats.retabled++;
      const key = `${kind}:${it.view}`;
      const prev = out.get(key);
      if (prev && prev.slots.join(",") !== it.equip.join(",")) stats.conflicts++;
      const better =
        !prev ||
        rank < prev.rank ||
        (rank === prev.rank &&
          ((it.costume && !prev.costume) || (it.costume === prev.costume && id < prev.item)));
      if (better) {
        out.set(key, {
          kind,
          view: it.view,
          slots: it.equip,
          origin: src.id,
          item: id,
          costume: it.costume,
          rank,
        });
      }
    }
  }
  stats.views = out.size;
  return { slots: out, stats };
}

/** Write `slots.tsv` and report. */
export function buildSlotIndex(originIds) {
  const sources = slotSources(originIds);
  if (!sources.length) {
    throw new Error(
      `no raw ${ITEM_INFO_FILES.join(" or ")} under any catalog/<origin>/raw — run stage 2 first`,
    );
  }
  const { slots, stats } = mergeSlots(sources, viewTables(originIds));
  const rows = [...slots.values()]
    .sort(
      (a, b) =>
        slotRank(bestSlot(a.slots)) - slotRank(bestSlot(b.slots)) ||
        a.kind.localeCompare(b.kind) ||
        a.view - b.view,
    )
    .map((r) => [r.kind, r.view, r.slots.join(","), bestSlot(r.slots), r.origin, r.item]);
  writeRows(paths.slots(), ["kind", "view", "slots", "best", "origin", "item"], rows);

  const perSlot = {};
  for (const r of slots.values()) {
    const b = bestSlot(r.slots);
    perSlot[b] = (perSlot[b] ?? 0) + 1;
  }
  return { ...stats, perSlot, sources: sources.map((s) => s.id) };
}

/** Read `slots.tsv` back as "kind:view" -> best slot. */
export function readSlotIndex() {
  const map = new Map();
  if (!existsSync(paths.slots())) return map;
  for (const r of readRows(paths.slots())) map.set(`${r.kind}:${Number(r.view)}`, r.best);
  return map;
}
