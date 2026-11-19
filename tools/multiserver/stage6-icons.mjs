// Stage 6 — the inventory icon for each foreign costume.
//
// The LATAM pass (`extract-grf.mjs --icons`) goes item id -> the item's
// `identifiedResourceName` out of System/iteminfo_new.lub -> the BMP at
// `data/texture/유저인터페이스/item/<res>.bmp`, and writes `<out>/item/<id>.png`.
// None of that chain survives the crossing: this catalogue has no item ids (a
// foreign costume is a view id in another client's table), and kRO Zero
// publishes no item table at all.
//
// It does not need one. `identifiedResourceName` *is* the accessory sprite name
// — that is the premise resolveView already rests on — so the sprite name the
// catalogue carries goes straight to the BMP, with the client's leading
// underscore stripped:
//
//   sprite `_C_Chained_Bear` -> data\texture\유저인터페이스\item\C_Chained_Bear.bmp
//                            -> data\texture\유저인터페이스\collection\C_Chained_Bear.bmp
//
// Measured against the seven clients' path indexes, for the 663 costumes in the
// catalogue: 637 (96.1%) have the `item/` BMP in some client's archives and 638
// the `collection/` one, with 25 having neither anywhere. Those 25 are a 404 on
// purpose — the consumer already falls back to a rendered thumbnail, and a
// placeholder would be a picture that claims to be the costume.
//
// **The icon is keyed by sprite name alone, with no origin dimension.** That is
// a departure from how the sprites are stored (one tree per origin, and a
// costume pinned to one of them), and the two reasons it is right here are the
// two reasons that rule exists there, both absent:
//
//   * A costume's `.spr` and `.act` must come from the same client, because 282
//     of the `.act` files differ between clients and a garment assembled from
//     two would animate against the wrong offsets. An icon is one standalone
//     BMP with no companion file to disagree with.
//   * Asking each costume's own tree for its icon finds 556 of 663 (83.9%);
//     asking every client finds 637 (96.1%). The missing 12% are costumes
//     whose art was cheapest to fetch from a client that ships no icon for it,
//     which says nothing about the icon.
//
// So an icon may come from any client that has it, and `icons-plan.tsv` records
// which one each came from, since "where did this picture come from" is a
// question somebody will ask.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bmpToPng, sanitizePath } from "../../extract-grf.mjs";
import { ORIGINS } from "./origins.mjs";
import { normalizePath } from "./pathshapes.mjs";
import { blockedFrom, resolveOrigin } from "./stage4-plan.mjs";
import { paths, ensureDir, readRows, writeRows } from "./store.mjs";

/** The client's "user interface" texture root, the same one --icons reads. */
export const UI_DIR = "data/texture/유저인터페이스";

/** The two sizes the client ships: ~24x24 in the inventory, ~75x100 in the
 *  collection book. Both, because the consumer uses both. */
export const ICON_KINDS = ["item", "collection"];

/**
 * The file name an icon is stored under: the sprite name, lowercased, with the
 * leading underscore the accessory tables carry stripped.
 *
 * The underscore marks "this is an accessory sprite" in the name table and is
 * not part of the resource name, which is why the BMP is `캡.bmp` and the sprite
 * is `_캡`. Garment names carry none to begin with.
 */
export function iconName(sprite) {
  return sprite.replace(/^_+/, "").toLowerCase();
}

/** The two GRF paths that would hold this sprite's icons, normalized. */
export function iconPaths(sprite) {
  const bare = iconName(sprite);
  return bare ? ICON_KINDS.map((kind) => ({ kind, path: `${UI_DIR}/${kind}/${bare}.bmp` })) : [];
}

/**
 * Every icon path the catalogue wants, as path -> {sprite, kind}.
 *
 * Keyed by path and not by costume: several costumes can share a sprite name
 * across namespaces (a headgear and a garment view can both point at one
 * resource), and the icon is the same file either way, so it is fetched once.
 */
export function wantedIcons(costumes) {
  const out = new Map();
  for (const c of costumes) {
    if (!c.sprite) continue;
    for (const { kind, path } of iconPaths(c.sprite)) {
      // `key` and `tier` are the two fields resolveOrigin carries through from
      // a target to its hits, so an icon target names itself by its own path.
      if (!out.has(path)) out.set(path, { sprite: iconName(c.sprite), kind, key: path, tier: "icon" });
    }
  }
  return out;
}

/**
 * Greedy set cover over (origin, archive) pairs, same shape as `coverPlan` and
 * deliberately not the same function.
 *
 * `coverPlan` pins every file of one costume to one origin, which is what keeps
 * a garment's animation consistent. An icon has nothing to be consistent with,
 * so pinning would only throw away the 12% of icons that live in a client other
 * than the one the art came from. What is left is an ordinary cover: take the
 * archive that supplies the most icons nobody has supplied yet.
 */
export function coverIcons(byOrigin) {
  const buckets = new Map(); // "<origin>|<archive>" -> [hit]
  for (const [originId, best] of byOrigin) {
    for (const [, hit] of best) {
      const k = `${originId}|${hit.archive}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push({ ...hit, originId });
    }
  }
  const taken = new Set(); // normalized icon path, whoever supplies it
  const steps = [];
  for (;;) {
    let pick = null;
    let gain = 0;
    for (const [k, hits] of buckets) {
      let g = 0;
      for (const h of hits) if (!taken.has(h.key)) g++;
      if (g > gain) {
        gain = g;
        pick = k;
      }
    }
    if (!pick) break;
    const hits = buckets.get(pick).filter((h) => !taken.has(h.key));
    for (const h of hits) taken.add(h.key);
    const [originId, archive] = pick.split("|");
    steps.push({ originId, archive, seq: Math.min(...hits.map((h) => h.seq)), files: hits });
    buckets.delete(pick);
  }
  return { steps, covered: taken };
}

/**
 * Plan the icon fetch and write `icons-plan.tsv`.
 *
 * The file has the same columns `plan.tsv` has, in the same order, because
 * `stage4-fetch.mjs` reads it with the same reader: an icon is a GRF entry like
 * any other and there is no second fetcher.
 */
export async function planIcons({ origins, costumes, onProgress } = {}) {
  const wanted = wantedIcons(costumes);
  const match = (norm) => {
    const at = norm.indexOf(UI_DIR);
    // The asset tree is rooted differently in a few archives, so match from the
    // folder that names it rather than from the start of the path — the same
    // thing originsFromPaths does for sprites.
    return at < 0 ? undefined : wanted.get(norm.slice(at));
  };

  const byOrigin = new Map();
  for (const origin of origins) {
    const blocked = blockedFrom(readRows(paths.archives(origin.id)));
    onProgress?.({ msg: `scanning ${origin.id} for icons` });
    byOrigin.set(
      origin.id,
      await resolveOrigin(origin.id, [], { blocked, onProgress, gate: "/texture/", match }),
    );
  }

  const { steps, covered } = coverIcons(byOrigin);
  const missing = [...wanted.values()].filter((w) => !covered.has(w.key));

  writeRows(
    paths.iconPlan(),
    ["origin", "archive", "seq", "slot", "kind", "view", "tier", "path", "uncompSize", "sprite"],
    steps.flatMap((s) =>
      s.files.map((f) => {
        const icon = wanted.get(f.key);
        return [
          s.originId,
          s.archive,
          s.seq,
          "",
          icon.kind,
          "",
          "icon",
          f.path,
          f.uncompSize,
          icon.sprite,
        ];
      }),
    ),
  );

  const perOrigin = {};
  let bytes = 0;
  for (const s of steps) {
    perOrigin[s.originId] = (perOrigin[s.originId] ?? 0) + 1;
    for (const f of s.files) bytes += f.uncompSize;
  }
  return {
    wanted: wanted.size,
    covered: covered.size,
    missing,
    archives: steps.length,
    bytes,
    perOrigin,
  };
}

/** Where the fetcher put one planned icon, in that origin's mirror tree. */
export function mirroredIcon(originId, grfPath) {
  const safe = sanitizePath(grfPath);
  return safe ? join(paths.mirrorDir(originId), safe) : null;
}

/**
 * Turn the fetched BMPs into the PNG tree a gateway serves.
 *
 * `<out>/{item,collection}/<sprite>.png`, magenta keyed to transparent by
 * extract-grf.mjs's own `bmpToPng` — the same function the LATAM icons go
 * through, so the two trees cannot come out looking different.
 *
 * A manifest goes beside them. The tree is flat by sprite name, so without one
 * there is nothing on disk that says which client each picture came from.
 */
export function buildIconTree({ out = paths.iconsDir(), plan = readRows(paths.iconPlan()) } = {}) {
  const dirs = {};
  for (const kind of ICON_KINDS) dirs[kind] = ensureDir(join(out, kind));

  const counts = {};
  const perOrigin = {};
  const fails = { absent: 0, convert: 0 };
  const sprites = {};
  for (const row of plan) {
    const kind = row.kind;
    if (!ICON_KINDS.includes(kind)) continue;
    const src = mirroredIcon(row.origin, row.path);
    if (!src || !existsSync(src)) {
      // Planned but not on disk: the fetch has not run yet, or that archive
      // turned out to be blocked. Counted, never guessed at.
      fails.absent++;
      continue;
    }
    const png = bmpToPng(readFileSync(src));
    if (!png) {
      fails.convert++;
      continue;
    }
    writeFileSync(join(dirs[kind], `${row.sprite}.png`), png);
    counts[kind] = (counts[kind] ?? 0) + 1;
    perOrigin[row.origin] = (perOrigin[row.origin] ?? 0) + 1;
    (sprites[row.sprite] ??= {})[kind] = row.origin;
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString().slice(0, 10),
        note:
          "Costume icons keyed by sprite name, not by item id and not by origin. " +
          "`sprites[name][kind]` is the client whose archives the picture came from.",
        origins: Object.fromEntries(
          Object.keys(perOrigin)
            .sort()
            .map((id) => [id, ORIGINS[id]?.label ?? id]),
        ),
        counts,
        perOrigin,
        sprites,
      },
      null,
      2,
    ) + "\n",
  );

  return { out, counts, perOrigin, fails, sprites: Object.keys(sprites).length };
}

/** The costumes an icon run is about: the published catalogue, if there is one. */
export function catalogueCostumes(file = paths.catalogue()) {
  if (!existsSync(file)) {
    throw new Error(`no catalogue at ${file} — run \`publishable\` first`);
  }
  const doc = JSON.parse(readFileSync(file, "utf8"));
  return doc.costumes ?? doc.items ?? [];
}

/** Normalized form of a path, re-exported so the CLI can report one. */
export { normalizePath };
