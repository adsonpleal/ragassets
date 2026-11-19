// Build `slots.tsv` — which slot each (kind, view) occupies.
//
// Reads only the raw `iteminfo_new.lub` already saved under
// `catalog/<origin>/raw/` by stage 2, so this costs no network. Three origins
// ship a readable one (LATAM, twRO, twRO Zero); jRO's item data is the legacy
// `.txt` pair, which carries no description, and kRO/kRO Zero/iRO ship no
// reachable modern table at all. So a view's slot is known when any of those
// three names it — which, because item ids are global, covers plenty of
// costumes those three do not themselves offer.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readItemInfo } from "./iteminfo.mjs";
import { bestSlot, kindFromSlots, slotRank } from "./slots.mjs";
import { paths, readRows, writeRows } from "./store.mjs";

/** Origins whose raw item table stage 2 left on disk, in order of trust. */
export function slotSources(originIds) {
  return originIds
    .map((id) => ({ id, path: join(paths.catalogDir(id), "raw", "iteminfo_new.lub") }))
    .filter((s) => existsSync(s.path));
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
export function mergeSlots(sources) {
  const out = new Map(); // "kind:view" -> {kind, view, slots, origin, item, costume, rank}
  const stats = { sources: 0, items: 0, withEquip: 0, views: 0, conflicts: 0 };
  for (const [rank, src] of sources.entries()) {
    stats.sources++;
    const { items } = readItemInfo(src.path);
    for (const [id, it] of items) {
      stats.items++;
      if (!it.view || !it.equip.length) continue;
      stats.withEquip++;
      const kind = kindFromSlots(it.equip);
      if (!kind) continue;
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
      "no raw iteminfo_new.lub under any catalog/<origin>/raw — run stage 2 first",
    );
  }
  const { slots, stats } = mergeSlots(sources);
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
