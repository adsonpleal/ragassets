// Renders every costume in the catalogue once and records the ones that draw
// nothing.
//
// Every costume, not only the foreign ones. Two thirds of the catalogue is
// `origin: latam` -- art this client already ships, for an item it never
// released -- and those rows were never swept, because the query this built
// always carried an `origin`. LATAM is not one: its tree is the gateway's own
// `resourceDir` rather than a mirror of somebody else's client, so `origin=latam`
// is a 500 and a sprite override with no origin is a 400. They render from the
// bare view id, which is what the app sends for them too, and that is the one
// line that was missing here.
//
// A view id from another client is not the only way this can come back empty.
// Some sprites contribute no pixels in the default pose at all: the costume is
// an effect hung off an accessory whose own sprite is blank, or its act puts
// the frame outside any canvas. The gateway answers those with a 200 and a
// valid PNG of a character wearing nothing, which is indistinguishable from a
// request that asked for nothing -- so the only way to find them is to render
// the bare character too and compare the bytes.
//
// A costume is only called blank after several poses have been tried, in both
// genders. The first version of this asked for the standing pose alone and
// called 47 costumes blank; five of them draw perfectly well once the
// character moves -- iRO's `_low_pony_bu` is empty standing, sitting and
// walking, and draws from action type 3 on. A sprite whose act defines no
// frames for the early action types is still a costume; a sprite that defines
// none for any of them is the one to drop.
//
// That bare-character comparison and the pose ladder now live in
// `renderprobe.mjs`, because the renderable probe needs exactly the same
// machinery to answer a different question -- see the header there.
//
// Only a costume that fails the first pose pays for the others, so the sweep
// stays a little over one request per costume.
//
// The output is committed (blank-visuals.json) and read by
// stage5-catalogue.mjs, so the catalogue the app ships has no dead tiles
// and the reason each one went is in the repo rather than in someone's memory.
//
//   node tools/multiserver/find-blank-visuals.mjs [--base <url>] [--out <file>] [--items <json>]

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DEFAULT_BASE, VIEW_PARAM, firstPoseThatDraws, poseLadder } from "./renderprobe.mjs";
import { paths } from "./store.mjs";

/** Our own client. Not an `origin` the gateway accepts -- see the header. */
const LOCAL = "latam";

/** Everything but the pose: fixed so two runs compare, and framed wide enough
 *  that nothing is cropped away. */
const BODY = "job=0&head=1&frame=0&canvas=248x232%2B124%2B184";
/** Tried in order; the first is the pose the grid thumbnails use, so almost
 *  every costume is settled by one request. */
export const POSES = poseLadder(BODY);

/** This pipeline says acc/robe and the app says headgear/garment; both turn up
 *  here, because `--items` takes either file. */
export const kindOf = (item) => item.kind ?? (item.viewKind === "garment" ? "robe" : "acc");

/** A row's tree. The app's copy omits it on its own client's rows, where the
 *  whole point is that there is no foreign tree to name. */
export const originOf = (item) => item.origin ?? LOCAL;

/** The query the app would send for this one costume in this pose, and nothing
 *  else -- the comparison is only honest if the two URLs differ by the costume. */
export function renderQuery(item, pose) {
  const p = VIEW_PARAM[kindOf(item)];
  // Our own art renders from the bare view id: the resolver's own table
  // supplies it, and naming either an origin or a sprite is an error the
  // gateway rejects rather than a question it answers.
  if (originOf(item) === LOCAL) return `${pose}&${p}=${item.view}`;
  const sprite = `${item.view}:${item.sprite}`;
  return (
    `${pose}&origin=${encodeURIComponent(item.origin)}` +
    `&${p}=${item.view}&${p}Sprite=${encodeURIComponent(sprite)}`
  );
}

export async function findBlank(items, { base = DEFAULT_BASE, width = 5, log = () => {} } = {}) {
  // Normalized once, so neither the query, the sort nor the output has to know
  // which of the two files these rows came out of. Grouped by origin so the
  // gateway's per-origin engine cache stays warm instead of being evicted and
  // rebuilt a few hundred times.
  const ordered = items
    .map((item) => ({ ...item, origin: originOf(item), kind: kindOf(item) }))
    .sort((a, b) => a.origin.localeCompare(b.origin) || a.kind.localeCompare(b.kind) || a.view - b.view);
  const { drew, extra, errors } = await firstPoseThatDraws({
    items: ordered,
    queryFor: renderQuery,
    ladder: POSES,
    base,
    width,
    log,
  });
  // A request that could not be made is not a verdict. This output is committed
  // and deletes tiles from the app's catalogue, so a sweep that could not reach
  // the box has to fail rather than hand back a list that is merely shorter.
  if (errors) throw new Error(`${errors} de ${ordered.length} visuais não deram resposta`);
  const blank = ordered.filter((item) => drew.get(item) === null);
  log(`${ordered.length + extra} renderizações no total`);
  return blank;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = arg("--base", DEFAULT_BASE);
  const out = arg("--out", "tools/multiserver/blank-visuals.json");
  // The pipeline's own published catalogue, not the app's copy of it: this tool
  // lives here now, so its default input has to be a path that exists here.
  // --items takes the app's public/db/foreign-costumes.json if you want that.
  const itemsFile = arg("--items", paths.catalogue());
  const doc = JSON.parse(readFileSync(itemsFile, "utf8"));
  // `costumes` is this pipeline's catalogue, `items` the app's build of it.
  const items = doc.costumes ?? doc.items;
  console.log(`${items.length} visuais de ${itemsFile}, contra ${base}`);
  const blank = await findBlank(items, { base, log: (m) => console.log(m) });
  writeFileSync(
    out,
    JSON.stringify(
      {
        note: "Visuais do catalogo que renderizam identicos ao personagem pelado, nos dois generos e em cinco poses. Gerado por find-blank-visuals.mjs; lido por stage5-catalogue.mjs.",
        checkedAt: new Date().toISOString().slice(0, 10),
        base,
        count: blank.length,
        // Keyed on what renders it -- origin, kind, view -- and not on the
        // synthetic app id, which is derived and can be renumbered.
        blank: blank.map(({ origin, view, kind, sprite, name }) => ({
          origin,
          view,
          viewKind: VIEW_PARAM[kind],
          sprite,
          name,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`${blank.length} em branco → ${out}`);
}
