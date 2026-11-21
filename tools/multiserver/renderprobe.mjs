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
//     `/image?headgear=<view>` or `/image?garment=<view>` with **no sprite
//     override**, so the resolver's own table has to supply the art. Produces
//     renderable.tsv, which stage 3 reads to decide what LATAM already draws.
//   * `find-blank-visuals.mjs` — does this costume draw, given that we already
//     know where its art is? Passes the sprite explicitly.
//
// **Both namespaces, or the answer is silently half an answer.** Until
// 2026-11-20 this probe drove `headgear=` only and renderable.tsv had no `kind`
// column, so stage 3 read every row as an accessory view and no garment view
// was ever asked about. The shortlist could therefore never say `draws` or
// `blank` for a garment — all 338 of its `robe` rows read `listed`, `unprobed`
// or `absent` — and anyone counting "views we already draw and do not list"
// off that column got zero garments by construction. Asking `garment=` for
// LATAM's 330 garment views: 223 draw, and 76 of those are views the consumer
// does not list.
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

/** The two sprite tables `/image` can be asked about, and the parameter that
 *  drives each. They are separate numberings — LATAM's 8 is a surgical mask as
 *  a headgear and Rudra's wings as a garment — so a key is `<kind>:<view>`
 *  everywhere downstream and a row without its kind is unreadable. */
export const VIEW_PARAM = { acc: "headgear", robe: "garment" };
export const KINDS = Object.keys(VIEW_PARAM);

/** The ladder is the same for both namespaces, and that was worth checking.
 *
 *  A garment is a *folder* — one sprite pair per class and sex, ~624 files —
 *  so a costume whose client shipped only some classes is invisible on the
 *  wrong body, a way of looking blank that a headgear (two files, worn by every
 *  class) cannot have. That argues for walking several classes before calling a
 *  garment blank. Measured over all 330 of LATAM's garment views: **every one
 *  of the 223 that draws is settled on the asked-for class**, and adding two
 *  more changed no verdict while tripling what each blank costs. It does not
 *  apply here because this probe asks our *own* resolver, whose tree is
 *  complete; the partial-art case belongs to find-blank-visuals.mjs, which
 *  renders a foreign mirror.
 *
 *  The *pose* half of the ladder does earn its keep: 11 of those 223 draw
 *  nothing standing and only appear from action type 1 or 3 on — the school
 *  bags and the Poring bag among them. */
export const ladderFor = (kind, job) => poseLadder(renderableBody(job));

/**
 * Which of these view ids does the resolver actually know?
 *
 * Deliberately asks with a bare `headgear=<view>` / `garment=<view>` and no
 * sprite name: that is the question. A view id the resolver cannot map renders
 * the character with nothing equipped, byte for byte the same as asking for
 * nothing at all.
 *
 * One sweep per namespace. The two tables are unrelated numberings and each
 * gets its own ladder from `ladderFor` — which happens to return the same one
 * today, for the reason recorded there.
 *
 * @param views [{kind, view, sprite}] — kind defaults to "acc"; sprite is
 *   carried through to the output only
 * @returns rows [{kind, view, sprite, result, pose, bytes}] where result is
 *   `drew` | `blank` | `error:<message>`
 */
export async function probeRenderable(views, { base = DEFAULT_BASE, job = 4054, width = 4, log } = {}) {
  const withKind = views.map((v) => ({ ...v, kind: v.kind ?? "acc" }));
  const results = new Map();
  let extra = 0;
  let errors = 0;
  let poses = 0;
  for (const kind of KINDS) {
    const items = withKind.filter((v) => v.kind === kind);
    if (!items.length) continue;
    const ladder = ladderFor(kind, job);
    poses = Math.max(poses, ladder.length);
    log?.(`${items.length} ${kind} view(s), up to ${ladder.length} poses each`);
    const r = await firstPoseThatDraws({
      items,
      ladder,
      base,
      width,
      log,
      queryFor: (v, pose) => `${pose}&${VIEW_PARAM[v.kind]}=${v.view}`,
    });
    for (const [item, d] of r.drew) results.set(item, d);
    extra += r.extra;
    errors += r.errors;
  }

  const rows = withKind.map((v) => {
    const d = results.get(v);
    if (d?.error) return { ...v, result: `error:${d.error}`, pose: "", bytes: 0 };
    if (!d) return { ...v, result: "blank", pose: "", bytes: 0 };
    // Which pose settled it is worth keeping: a view that only draws from
    // action type 3 on is a different fact from one that draws standing, and
    // without the column the next person re-probes to re-learn it. The class
    // stays in too — it is what `--job` was set to, and a verdict is only ever
    // about the body it was measured on. Only `frame=`, which never varies,
    // comes out.
    const pose = d.pose
      .split("&")
      .filter((p) => !p.startsWith("frame="))
      .join("&");
    return { ...v, result: "drew", pose, bytes: d.bytes };
  });
  const counts = { drew: 0, blank: 0, error: 0 };
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { drew: 0, blank: 0, error: 0 }]));
  for (const r of rows) {
    const bucket = r.result.startsWith("error") ? "error" : r.result;
    counts[bucket]++;
    byKind[r.kind][bucket]++;
  }
  return { rows, counts, byKind, extra, errors, poses };
}
