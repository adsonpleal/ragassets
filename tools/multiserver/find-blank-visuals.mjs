// Renders every foreign costume once and records the ones that draw nothing.
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
// Only a costume that fails the first pose pays for the others, so the sweep
// stays a little over one request per costume.
//
// The output is committed (blank-visuals.json) and read by
// export-app-catalogue.mjs, so the catalogue the app ships has no dead tiles
// and the reason each one went is in the repo rather than in someone's memory.
//
//   node tools/multiserver/find-blank-visuals.mjs [--base <url>] [--out <file>]

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE = "https://assets.latam-tools.com.br";
/** Everything but the pose: fixed so two runs compare, and framed wide enough
 *  that nothing is cropped away. */
const BODY = "job=0&head=1&frame=0&canvas=248x232%2B124%2B184";
/** `action` is type*8 + direction, so these are the first frame of the first
 *  five action types facing south: standing, walking, sitting, and the two
 *  beyond them that some costumes draw in when the earlier ones are empty. */
const ACTIONS = [0, 8, 16, 24, 32];
const GENDERS = ["male", "female"];
/** Tried in order; the first is the pose the grid thumbnails use, so almost
 *  every costume is settled by one request. */
const POSES = [
  ...ACTIONS.map((action) => ({ gender: "male", action })),
  ...ACTIONS.map((action) => ({ gender: "female", action })),
];

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

export const posePrefix = ({ gender, action }) => `${BODY}&gender=${gender}&action=${action}`;

/** The query the app would send for this one costume in this pose, and nothing
 *  else -- the comparison is only honest if the two URLs differ by the costume. */
export function renderQuery(item, pose) {
  const view = item.view;
  const p = item.viewKind === "garment" ? "garment" : "headgear";
  const sprite = `${view}:${item.sprite}`;
  return (
    `${posePrefix(pose)}&origin=${encodeURIComponent(item.origin)}` +
    `&${p}=${view}&${p}Sprite=${encodeURIComponent(sprite)}`
  );
}

async function fetchHash(base, query) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}/image?${query}`);
    if (res.ok) return sha(Buffer.from(await res.arrayBuffer()));
    // A 5xx here is usually the box under load, not a verdict about the
    // costume. Calling it blank on a failed request would silently delete it.
    if (attempt >= 3) throw new Error(`${res.status} for ${query}`);
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
}

/** Runs `work` over `items` with a fixed number in flight. */
async function pooled(items, width, work) {
  let next = 0;
  const runners = Array.from({ length: width }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(runners);
}

export async function findBlank(items, { base = DEFAULT_BASE, width = 5, log = () => {} } = {}) {
  // The same character wearing nothing, once per pose. Everything is compared
  // against these, so they are fetched up front and shared.
  const bare = new Map();
  for (const pose of POSES) bare.set(posePrefix(pose), await fetchHash(base, posePrefix(pose)));
  log(`${bare.size} poses do personagem pelado`);

  // Grouped by origin so the gateway's per-origin engine cache stays warm
  // instead of being evicted and rebuilt a few hundred times.
  const ordered = [...items].sort((a, b) => a.origin.localeCompare(b.origin) || a.view - b.view);
  const blank = [];
  let done = 0;
  let extra = 0;
  await pooled(ordered, width, async (item) => {
    let drew = null;
    for (const [i, pose] of POSES.entries()) {
      if (i > 0) extra++;
      if ((await fetchHash(base, renderQuery(item, pose))) !== bare.get(posePrefix(pose))) {
        drew = pose; // one pose drawing is enough to keep it
        break;
      }
    }
    if (!drew) blank.push(item);
    if (++done % 50 === 0) log(`${done}/${ordered.length}… ${blank.length} em branco`);
  });
  log(`${ordered.length + extra} renderizações no total`);
  blank.sort(
    (a, b) => a.origin.localeCompare(b.origin) || a.viewKind.localeCompare(b.viewKind) || a.view - b.view,
  );
  return blank;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = arg("--base", DEFAULT_BASE);
  const out = arg("--out", "tools/multiserver/blank-visuals.json");
  const items = JSON.parse(readFileSync("public/db/foreign-costumes.json", "utf8")).items;
  console.log(`${items.length} visuais, contra ${base}`);
  const blank = await findBlank(items, { base, log: (m) => console.log(m) });
  writeFileSync(
    out,
    JSON.stringify(
      {
        note: "Visuais estrangeiros que renderizam identicos ao personagem pelado, nos dois generos. Gerado por find-blank-visuals.mjs; lido por export-app-catalogue.mjs.",
        checkedAt: new Date().toISOString().slice(0, 10),
        base,
        count: blank.length,
        // Keyed on what renders it -- origin, kind, view -- and not on the
        // synthetic app id, which is derived and can be renumbered.
        blank: blank.map(({ origin, view, viewKind, sprite, name }) => ({
          origin,
          view,
          viewKind,
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
