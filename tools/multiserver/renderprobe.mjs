// Ask our own gateway to render something and decide whether it drew anything.
//
// `/image` answers **200 with the bare character** whenever the thing you asked
// for contributed no pixels, and that happens for two quite different reasons:
// the resolver does not know the view id at all, or it knows it and the sprite
// is genuinely empty in the pose you asked for. Either way the status code, the
// content type and the PNG are all perfectly valid, so the only test that works
// is to render the bare character too and compare the bytes.
//
// Two tools in this directory need that, asking different questions:
//
//   * `probeRenderable` — does the resolver know this view id? Drives
//     `/image?headgear=<view>` with **no sprite override**, so the resolver's
//     own table has to supply the art. Produces renderable.tsv, which stage 3
//     reads to decide what LATAM already draws.
//   * `find-blank-visuals.mjs` — does this costume draw, given that we already
//     know where its art is? Passes the sprite explicitly.
//
// **One pose is not enough, and that is the whole reason this module exists.**
// The first version of the blank sweep asked for the standing pose alone and
// called 47 costumes blank; 5 of them draw perfectly well once the character
// moves (iRO's `_low_pony_bu` is empty standing, sitting and walking and draws
// from action type 3 on). The renderable probe this repo inherited had the same
// shape — one pose, one gender — so it could not tell "the resolver has never
// heard of this view" from "the sprite defines no frames this early", and only
// the first of those means the art is missing. A view the resolver does not
// know is bare in *every* pose, so escalating through the ladder separates them.
//
// Only an item that looks blank pays for the extra poses, so a sweep stays a
// little over one request per item.

import { createHash } from "node:crypto";

/** Overridable because the probe is also how you check a box you just deployed. */
export const DEFAULT_BASE = process.env.RAGASSETS ?? "https://assets.latam-tools.com.br";

/** `action` is type*8 + direction, so these are the first frame of the first
 *  five action types facing south: standing, walking, sitting, and the two
 *  beyond them that some sprites draw in when the earlier ones are empty. */
export const ACTIONS = [0, 8, 16, 24, 32];
export const GENDERS = ["male", "female"];

/**
 * The ladder of bare-character queries for a given body, tried in order. The
 * first entry is the pose the grid thumbnails use, which is why almost every
 * item is settled by one request.
 *
 * A pose is just the query string of the character without the thing being
 * probed; `queryFor` appends to it. Keeping it a string rather than a
 * `{gender, action}` pair is what lets one ladder serve two different bodies.
 */
export const poseLadder = (body) =>
  GENDERS.flatMap((gender) => ACTIONS.map((action) => `${body}&gender=${gender}&action=${action}`));

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/** One render, as bytes we can compare. Retries, because a 5xx here is the box
 *  under load and not a verdict — calling something blank on a failed request
 *  would silently delete a costume. */
export async function fetchRender(base, query) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}/image?${query}`);
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      return { hash: sha(buf), bytes: buf.length, status: res.status };
    }
    if (attempt >= 3) throw new Error(`${res.status} for ${query}`);
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
}

export const fetchHash = async (base, query) => (await fetchRender(base, query)).hash;

/** Runs `work` over `items` with a fixed number in flight. */
export async function pooled(items, width, work) {
  let next = 0;
  const runners = Array.from({ length: width }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(runners);
}

/** The bare character once per pose. Everything is compared against these, so
 *  they are fetched up front and shared across the whole sweep. */
export async function bareHashes(base, ladder) {
  const bare = new Map();
  for (const pose of ladder) bare.set(pose, await fetchHash(base, pose));
  return bare;
}

/**
 * For each item, the first pose in `ladder` whose render differs from the bare
 * character — or null if none of them do, which is the verdict "this draws
 * nothing". The shared half of both probes.
 *
 * @param queryFor (item, pose) => query string for that item in that pose
 * @returns {Promise<{drew: Map, extra: number, errors: number}>} `drew` maps
 *   each item to `{pose, bytes}`, to `null` when every pose matched the bare
 *   character, or to `{error}` when the request could not be made at all.
 */
export async function firstPoseThatDraws({
  items,
  queryFor,
  base = DEFAULT_BASE,
  ladder,
  width = 5,
  log = () => {},
}) {
  const bare = await bareHashes(base, ladder);
  log(`${bare.size} poses of the bare character`);

  const drew = new Map();
  let done = 0;
  let extra = 0;
  let errors = 0;
  let blank = 0;
  await pooled(items, width, async (item) => {
    let hit = null;
    for (const [i, pose] of ladder.entries()) {
      if (i > 0) extra++;
      let r;
      try {
        r = await fetchRender(base, queryFor(item, pose));
      } catch (err) {
        errors++;
        drew.set(item, { error: err.message });
        done++;
        return;
      }
      if (r.hash !== bare.get(pose)) {
        hit = { pose, bytes: r.bytes };
        break;
      }
    }
    drew.set(item, hit);
    if (!hit) blank++;
    if (++done % 100 === 0) {
      log(`  ${done}/${items.length} — drew ${done - blank - errors}, blank ${blank}, errors ${errors}`);
    }
  });
  return { drew, extra, errors };
}

/** The body the renderable probe renders, pose aside. `job` is a real class id
 *  rather than the novice the blank sweep uses, because this probe is about the
 *  resolver's accessory table and a class that owns a head sprite exercises it. */
export const renderableBody = (job) => `job=${job}&frame=0`;

/**
 * Which of these view ids does the resolver actually know?
 *
 * Deliberately asks with a bare `headgear=<view>` and no sprite name: that is
 * the question. A view id the resolver cannot map renders the character with no
 * headgear, byte for byte the same as asking for no headgear at all.
 *
 * @param views [{view, sprite}] — sprite is carried through to the output only
 * @returns rows [{view, sprite, result, pose, bytes}] where result is
 *   `drew` | `blank` | `error:<message>`
 */
export async function probeRenderable(views, { base = DEFAULT_BASE, job = 4054, width = 4, log } = {}) {
  const ladder = poseLadder(renderableBody(job));
  const { drew, extra, errors } = await firstPoseThatDraws({
    items: views,
    ladder,
    base,
    width,
    log,
    queryFor: (v, pose) => `${pose}&headgear=${v.view}`,
  });

  const rows = views.map((v) => {
    const d = drew.get(v);
    if (d?.error) return { ...v, result: `error:${d.error}`, pose: "", bytes: 0 };
    if (!d) return { ...v, result: "blank", pose: "", bytes: 0 };
    // Which pose settled it is worth keeping: a view that only draws from
    // action type 3 on is a different fact from one that draws standing, and
    // without the column the next person re-learns it by re-probing.
    return { ...v, result: "drew", pose: d.pose.split("&").slice(-2).join("&"), bytes: d.bytes };
  });
  const counts = { drew: 0, blank: 0, error: 0 };
  for (const r of rows) counts[r.result.startsWith("error") ? "error" : r.result]++;
  return { rows, counts, extra, errors, poses: ladder.length };
}
