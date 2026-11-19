// Read a client's System/iteminfo_new.lub — the modern item table.
//
// This is where a modern client keeps item data, and it replaced the old
// `idnum2item*table.txt` pair. twRO has dropped the .txt files entirely: a grep
// of its whole 2,833-archive index finds neither, while one `.rgz` carries an
// 8.6 MB iteminfo_new.lub with 19,914 items. So any origin without the .txt
// tables is not missing its item data; it ships it here.
//
// Three fields matter to this project, and the first one is the prize:
//
//   ClassNum                 the VIEW ID. An item that says ClassNum = 1219 is
//                            the costume that view draws — no guessing from the
//                            resource name, which is what the .txt route has to
//                            do. Non-headgear items carry 0.
//   identifiedDisplayName    the name, in that server's language.
//   identifiedResourceName   the item's resource name, Korean in every client.
//
// The equip position — top, middle, lower, garment — has no field of its own.
// It is written in `identifiedDescriptionName`, as a labelled line in that
// server's language, which is what `slots.mjs` reads.
//
// The file is precompiled Lua 5.1 bytecode (magic 1b 4c 75 61 51) with
// sizeof(size_t) = 4, which a 64-bit Lua refuses to load; ragassets' own
// undumper and VM read it, so this just runs the chunk and walks `tbl`.

import { readFileSync } from "node:fs";
import { LuaTable, decodeClientString, runChunk } from "../../extract-grf.mjs";
import { parseSlotsFromLines } from "./slots.mjs";

const PLACEHOLDER = /^(\(null\)|null|n\/a|unknown)$/i;

/**
 * @returns {{items: Map<number, {view: number, name: string|null,
 *   resource: string|null, slots: number, equip: string[],
 *   costume: boolean}>, stats: object}}
 *
 * `slots` is the card-slot count the table carries; `equip` is the equip
 * position parsed out of the description. Two different things that both get
 * called "slots" in this domain, so they keep separate names here.
 */
export function readItemInfo(path) {
  const tbl = runChunk(readFileSync(path)).get("tbl");
  const items = new Map();
  const stats = { total: 0, withView: 0, withName: 0, withResource: 0, costume: 0, withEquip: 0 };
  if (!(tbl instanceof LuaTable)) {
    return { items, stats: { ...stats, note: "chunk defined no `tbl` table" } };
  }
  for (const [id, entry] of tbl.map) {
    if (typeof id !== "number" || !(entry instanceof LuaTable)) continue;
    const classNum = entry.get("ClassNum");
    const view = typeof classNum === "number" && classNum > 0 ? Math.round(classNum) : 0;
    // A few client names end in trailing spaces; the join compares these.
    // `(null)` is twRO's own placeholder for an item it has not named yet (94 of
    // them, including 6 costumes) — a name that would otherwise be shipped to
    // the UI as if it were real.
    const raw = (decodeClientString(entry.get("identifiedDisplayName")) || "").trim();
    const name = raw && !PLACEHOLDER.test(raw) ? raw : null;
    const resource =
      decodeClientString(entry.get("identifiedResourceName")) ||
      decodeClientString(entry.get("unidentifiedResourceName")) ||
      null;
    stats.total++;
    if (view) stats.withView++;
    if (name) stats.withName++;
    if (resource) stats.withResource++;
    const costume = entry.get("costume") === true;
    if (costume) stats.costume++;
    const desc = entry.get("identifiedDescriptionName");
    const equip = desc instanceof LuaTable
      ? parseSlotsFromLines([...desc.map.values()].map((l) => decodeClientString(l)))
      : [];
    if (equip.length) stats.withEquip++;
    items.set(id, {
      view,
      name,
      resource,
      slots: Number(entry.get("slotCount") || 0),
      equip,
      costume,
    });
  }
  return { items, stats };
}

/**
 * view id -> the item that draws it, lowest id first.
 *
 * Several items can share a ClassNum: Gravity re-gifts a costume as a new item
 * every few years, and the oldest one is the one whose name describes the art
 * rather than the event that handed it out.
 */
export function itemsByView(items) {
  const out = new Map();
  for (const [id, it] of items) {
    if (!it.view) continue;
    const prev = out.get(it.view);
    if (prev === undefined || id < prev) out.set(it.view, id);
  }
  return out;
}
