// Which slot a costume occupies — top, middle, lower or garment.
//
// The client's item table has no equip-position field. The position is written
// in the item's *description text*, as a labelled line, and ragassets already
// reads the Portuguese form ("Equipa em: ^777777Topo e Meio^000000"). Only
// Portuguese, though, so every foreign costume came back with no slot at all.
//
// The labels and values below were collected from the tables on disk, not
// guessed. Across LATAM, twRO and twRO Zero (the three origins that ship a
// readable `iteminfo_new.lub`), the position line reads:
//
//   pt   "Posição : Topo"            Topo / Meio / Baixo / Capa
//        "Equipa em : Topo e Meio"   joined with "e" or ","
//   zh   "位置 : 頭上"                頭上 / 頭中 / 頭下 (head upper/middle/lower)
//        "位置 : 披肩"                披肩 — the shoulder cape, i.e. a garment
//        "位置 : 頭上/中/下"          joined with "/", "、" or run together
//
// Coverage on those three: twRO 2,160 of 2,185 costumes, twRO Zero 2,275 of
// 2,286, LATAM 1,137 of 1,493. The Portuguese gap is real — 356 LATAM costumes
// write no position line at all — which is itself worth knowing, since the app
// derives the slot the same way.
//
// This module is pure so it can be tested without a ragassets checkout; the
// caller hands it already-decoded strings.

/** Slot order: most wanted first. Headgear before garments, top before lower. */
export const SLOT_PRIORITY = ["top", "mid", "low", "garment"];

/** Rank for sorting. Unknown slots sort after every known one. */
export function slotRank(slot) {
  const i = SLOT_PRIORITY.indexOf(slot);
  return i === -1 ? SLOT_PRIORITY.length : i;
}

// "<label> : <value>", where the value runs until the next "<word> :" field.
// Both ASCII and fullwidth colons appear, sometimes in the same table.
const LABEL = /(?:Equipa em|Posi[çc][ãa]o|位置|装備位置)\s*[:：]\s*(.+)/i;

/**
 * The slots named by one position *value* (the text after the label).
 *
 * Returns `[]` when the value names none, which is not the same as a costume
 * having no slot — it means this client did not say.
 */
export function parseSlotValue(value) {
  if (typeof value !== "string") return [];
  // The value is often followed by the next field with no separator at all
  // ("頭上重量: 0"), so cut at the first "<word> :" and lowercase for pt.
  const t = value.split(/\s+\S+\s*[:：]/)[0].toLowerCase();
  const slots = [];
  // Chinese first: 披肩 (shoulder cape) is a garment, and the three head
  // positions are 上/中/下 under a 頭 prefix. Checking the characters rather
  // than the whole word is what handles "頭上/中/下" and "頭上中下" alike.
  if (t.includes("披肩") || t.includes("披風")) slots.push("garment");
  if (t.includes("頭")) {
    if (t.includes("上")) slots.push("top");
    if (t.includes("中")) slots.push("mid");
    if (t.includes("下")) slots.push("low");
  }
  // Portuguese. `ixo` catches the mojibake "Baixo" turns into when a CP1252
  // table is read as UTF-8, which ragassets' own parser also allows for.
  if (t.includes("topo") || t.includes("superior")) slots.push("top");
  if (t.includes("meio")) slots.push("mid");
  if (t.includes("baixo") || /(^|\s)ixo\b/.test(t)) slots.push("low");
  if (t.includes("capa")) slots.push("garment");
  return [...new Set(slots)].sort((a, b) => slotRank(a) - slotRank(b));
}

/** The slots named anywhere in a description's lines. First hit wins. */
export function parseSlotsFromLines(lines) {
  for (const raw of lines) {
    if (typeof raw !== "string") continue;
    // Colour codes (^RRGGBB) sit inside the value and would break the cut.
    const m = raw.replace(/\^[0-9a-fA-F]{6}/g, "").match(LABEL);
    if (!m) continue;
    const slots = parseSlotValue(m[1]);
    if (slots.length) return slots;
  }
  return [];
}

/**
 * The namespace a slot set implies, as a cross-check on stage 2.
 *
 * Stage 2 decides the namespace from the sprite name (is it in the accessory
 * table or the robe table). The slot is independent evidence: a costume that
 * equips in the garment position is a garment. Disagreements are worth looking
 * at rather than silently resolving.
 */
export function kindFromSlots(slots) {
  if (!slots.length) return null;
  return slots.includes("garment") && slots.length === 1 ? "robe" : "acc";
}

/** The highest-priority slot in a set — what a fetch should order by. */
export function bestSlot(slots) {
  if (!slots?.length) return null;
  return [...slots].sort((a, b) => slotRank(a) - slotRank(b))[0];
}
