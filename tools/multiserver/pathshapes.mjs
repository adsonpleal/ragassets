// GRF path handling, kept free of any dependency so it can be unit-tested
// without a ragassets checkout.
//
// Paths inside an archive are Windows-style and inconsistently cased —
// `data\LuaFiles514\Lua Files\Datainfo\AccName.lub` in one patch and
// `data\luafiles514\lua files\datainfo\accname.lub` in the next, for the same
// file. Everything that compares paths compares the normalized form.

export function normalizePath(p) {
  return p.replace(/\\/g, "/").toLowerCase();
}

// Korean directory names, which are the same in every region's client because
// they are the original Korean asset tree: 악세사리 = accessory (headgear),
// 로브 = robe (garment), 이팩트 = effect (wings and the like).
export const ACC_DIR = "/sprite/악세사리/";
export const ROBE_DIR = "/sprite/로브/";
export const EFFECT_DIR = "/sprite/이팩트/";

// Male and female sprite prefixes.
export const SEX_PREFIX = ["남", "여"];

/**
 * The headgear files for an accessory sprite name.
 *
 * An AccName value already carries the leading underscore (`_C_Chained_Bear`),
 * and the file is literally <sex> + that name:
 *
 *     data\sprite\악세사리\남\남_C_Chained_Bear.spr
 *
 * The effect folder is included because a hat effect is keyed by the same name
 * (minus the underscore) and is what makes an "empty" costume visible.
 */
export function spriteTargets(accName) {
  const low = accName.toLowerCase();
  const bareLow = low.replace(/^_/, "");
  const out = [];
  for (const sex of SEX_PREFIX) out.push(`${ACC_DIR}${sex}/${sex}${low}.`);
  out.push(`${EFFECT_DIR}${bareLow}/`);
  return out;
}

/**
 * The garment folders for a robe sprite name.
 *
 * A garment is a whole folder, not a pair of files, and its name comes from the
 * **robe** table — never from an accessory name, which is a different namespace
 * entirely. Both spellings the robe table carries are tried, because a live
 * client has folders under each: `로브/기린의날개/` (the Korean name, which is
 * also the item's own resource name) and `로브/C_Juncea_Wing/` (the ASCII one).
 */
export function robeTargets(...names) {
  const out = [];
  for (const name of names) {
    if (!name) continue;
    const low = name.toLowerCase().replace(/^_/, "");
    out.push(`${ROBE_DIR}${low}/`, `${EFFECT_DIR}${low}/`);
  }
  return out;
}

/** Dispatch on the namespace a shortlist row belongs to. */
export function targetsFor(kind, ...names) {
  return kind === "robe" ? robeTargets(...names) : spriteTargets(names[0]);
}
