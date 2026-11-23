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

// The other effect tree, and the one that matters for a costume whose whole
// visual is a `.str` animation. `/sprite/이팩트/` holds sprite-shaped effects
// (a `.spr`/`.act` pair); a `.str` and the textures it plays live here instead,
// one folder per effect, named `efst_` + the costume's sprite name:
//
//     data\texture\effect\efst_C_CLB_SS_LL\bbcat.str      9,592 bytes
//     data\texture\effect\efst_C_CLB_SS_LL\catan01.TGA  180,844 bytes  (×54)
//
// The `.str` file's own name is arbitrary and names nothing we can predict
// (`bbcat.str`, `flutter_butterfly.str`), so the folder is the target, exactly
// as a garment's folder is.
export const EFFECT_TEX_DIR = "/texture/effect/";
export const EFFECT_TEX_PREFIX = "efst_";

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

/**
 * The `.str` effect folder for a sprite name, with the one name variant the
 * tables justify.
 *
 * Nine of the costumes Divine-Pride lists and we do not show draw nothing at
 * all: their `.spr` is a placeholder and the visual is a `.str` effect hung off
 * the item. The pipeline could not fetch one — `spriteTargets` reaches
 * `/sprite/이팩트/`, where a sprite-shaped effect lives, and nothing reached
 * `/texture/effect/`, so a plan over all eight clients came out with **4 effect
 * rows**, which are two costumes' `.spr`/`.act` pairs, and not one `.str`.
 *
 * The folder name derived from the sprite is right more often than the first
 * measurement of this suggested. `efst_C_Astra_Blessing/astra.str` and
 * `efst_C_Fluttering_Haze/skaura33.str` are both exactly `efst_` + the sprite
 * name, in six clients each, and both matched these targets from the day they
 * were added — what kept them out of the plan was `originCanDraw` in
 * stage4-plan.mjs, which dropped any view with no `.spr`, and that is precisely
 * what an effect-only costume has. The two are fixed together or neither
 * shows.
 *
 * What a path shape still cannot reach is a costume whose effect our own client
 * maps by hand: `resources/effects/index.json` holds a `gold_shower` and a
 * `time_accessory` that look like two of the nine, under names no sprite gives.
 * That is a mapping, not a target.
 *
 * Two forms are tried, because a costume and the ordinary hat it copies share
 * one effect folder and the folder is named after whichever came first:
 * `_C_FlutterButterfly_BL`'s effect is `efst_flutterbutterfly_bl`, with no
 * `c_`. Measured over the 3,242 sprite names in the shortlist: the exact form
 * finds 40 folders, the stripped form takes it to 46. The variant does not
 * steal another costume's effect — 39 folders are claimed by more than one
 * sprite name, 5 of those by an exact claimant and a stripped one, and all 5
 * are the base/costume pair of the same hat (`_Jirant_Circlet` and
 * `_C_Jirant_Circlet`), which is the same artwork and so the same effect.
 */
export function effectFolders(...names) {
  const out = [];
  for (const name of names) {
    if (!name) continue;
    const bare = name.toLowerCase().replace(/^_+/, "");
    if (!bare) continue;
    // Both spellings the effect tree uses. The `efst_` prefix is the common one,
    // but it is a convention and not a rule: `robe:94 C_Rotating_Gears` —
    // "Capa de Engrenagens", one of the costumes this audit went looking for —
    // files its animation as `/texture/effect/C_Rotating_Gears/gearwheel.str`,
    // with no prefix at all, in iRO, kRO, twRO and thRO. Asking for the bare
    // folder costs one more name per sprite and is what reaches it.
    out.push(`${EFFECT_TEX_PREFIX}${bare}`);
    const stripped = bare.replace(/^c_?/, "");
    if (stripped && stripped !== bare) out.push(`${EFFECT_TEX_PREFIX}${stripped}`);
    // The unprefixed form takes the sprite's own name and nothing else. The
    // `c_`-stripped variant is deliberately NOT tried without the prefix:
    // `efst_` keeps that guess inside the costume-effect tree, while
    // `/texture/effect/` is the game's whole effect library, where a stripped
    // name like `fire` or `aura` is somebody else's folder with hundreds of
    // textures in it.
    out.push(bare);
  }
  return out;
}

/**
 * The same folders, as prefixes to match an index row against.
 *
 * One source of truth with `effectFolders` on purpose: the planner matches
 * paths with these, and stage 5 looks for a `.str` in those folders in the
 * mirror. The two asking different questions is how an effect costume gets
 * fetched and then dropped.
 */
export function effectTargets(...names) {
  return effectFolders(...names).map((folder) => `${EFFECT_TEX_DIR}${folder}/`);
}

/** Is this target an effect rather than the costume's own artwork? Both effect
 *  trees count, so the plan's `effect` tier means the same thing for a `.str`
 *  as it always has for a sprite-shaped aura. */
export const isEffectTarget = (prefix) =>
  prefix.startsWith(EFFECT_DIR) || prefix.startsWith(EFFECT_TEX_DIR);

/** Dispatch on the namespace a shortlist row belongs to. */
export function targetsFor(kind, ...names) {
  const own = kind === "robe" ? robeTargets(...names) : spriteTargets(names[0]);
  // The `.str` folder is keyed by the sprite name in both namespaces, so it is
  // the same question for a garment as for a headgear.
  return [...own, ...effectTargets(...names)];
}
