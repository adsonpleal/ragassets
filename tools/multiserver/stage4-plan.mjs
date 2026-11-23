// Stage 4, planning half — decide WHAT to fetch and from WHERE before spending
// anybody's bandwidth.
//
// Two facts, both measured rather than assumed, make a planning pass worth its
// own module:
//
// 1. A sprite is usually in several origins' patch histories. Fetching per
//    origin, as the first cut of stage 4 did, downloads the same costume up to
//    six times: the per-origin archive counts add up to 789, while one archive
//    set that covers every reachable view is 191.
//
// 2. A patch is not a sprite. twRO's client patches run from 2 MB to 292 MB
//    (median 2.8, mean 60 in the sample already on disk), and the sprites we
//    want are a few hundred KB of that. A GRF entry carries its own offset and
//    compressed length, so the bytes of one sprite can be read on their own —
//    which is what `grf.mjs` already does for the file table.
//
// So the plan is a set cover: repeatedly take the (origin, archive) pair that
// resolves the most views still missing. Greedy is the right tool here — the
// optimum is NP-hard, greedy is within ln(n) of it, and the input is small.
//
// The plan is written to disk because it is the thing worth reviewing before a
// fetch runs: it names every archive, every byte range, and every view that no
// origin can supply.

import { isEffectTarget, normalizePath, targetsFor } from "./pathshapes.mjs";
import { slotRank } from "./slots.mjs";
import { paths, readRows, streamRows, writeRows } from "./store.mjs";

/** A shortlist row's stable key: the namespace plus the view id. */
export const rowKey = (r) => `${r.kind}:${Number(r.view)}`;

/**
 * Which shortlist rows a fetch should try to satisfy.
 *
 * Equipment the client itself flags as `no` is skipped by default: 153 of the
 * missing views are things like the Adventurer's Backpack, which the app leaves
 * out on purpose. A row with no flag is kept — only kRO and jRO views lack one,
 * and "unknown" is not "no".
 */
export function wantedRows({ includeEquipment = false } = {}) {
  const rows = readRows(paths.shortlist());
  if (!rows.length) throw new Error("no shortlist on disk — run stage 3 first");
  return rows.filter(
    (r) => r.need === "yes" && r.sprite && (includeEquipment || r.costume !== "no"),
  );
}

/**
 * Split a wanted row into the path prefixes that satisfy it, tagged by how
 * badly each is needed.
 *
 * `core` is the costume itself: the two headgear sprites, or the garment
 * folder. `effect` is the animated aura that some hats carry — real content,
 * but a whole folder of frames, and it is what makes the byte total swing by a
 * factor of ten. Tagging them lets a caller fetch the costumes first and decide
 * about effects with the numbers in hand.
 */
export function targetsOf(row) {
  return targetsFor(row.kind, row.sprite).map((prefix) => ({
    prefix,
    key: rowKey(row),
    tier: isEffectTarget(prefix) ? "effect" : "core",
  }));
}

/**
 * The archives stage 1 could list but not read, from its own ledger.
 *
 * Planning around these is not an optimisation. The first full fetch lost 209
 * of 732 views, every one of them to a v0x300 archive on jRO or kRO — the
 * planner had picked the newest copy of each path without noticing that the
 * newest copy was unreadable. Skipping them makes the plan fall back to the
 * newest *readable* copy, and where an origin has none, the set cover hands the
 * view to an origin that does.
 */
export function blockedFrom(rows) {
  return new Set(rows.filter((r) => r.status === "blocked").map((r) => r.file));
}

/**
 * Walk one origin's path index and keep, for every wanted file, the newest
 * archive that carries it.
 *
 * Newest wins because patches carry whole files: the last patch to ship a
 * sprite is the one a live client would be running.
 */
/**
 * The substrings a path must contain to be worth matching against the targets.
 *
 * `/sprite/` alone was the gate, and it is why adding `effectTargets` to the
 * path shapes changed nothing on its own: a `.str` effect lives under
 * `/texture/effect/efst_<sprite>/`, which no `/sprite/` gate ever lets through,
 * so the plan came out with the same 4 effect rows as before. The second gate
 * is narrow on purpose — `/texture/effect/` is 26,501 rows in iRO's index and
 * 30,817 in twRO's, while `/texture/effect/efst_` is 1,798 and 2,014.
 */
export const GATES = ["/sprite/", "/texture/effect/efst_"];

export async function resolveOrigin(
  originId,
  targets,
  { blocked = new Set(), onProgress, gate = GATES, match } = {},
) {
  // `match` and `gate` are what the icon pass needs: it wants exact paths under
  // /texture/ rather than sprite-folder prefixes, and the scan itself — stream
  // the index, skip the unreadable archives, keep the newest copy — is the part
  // worth having in one place.
  const find = match ?? ((norm) => targets.find((t) => norm.includes(t.prefix)));
  const gates = gate ? (Array.isArray(gate) ? gate : [gate]) : null;
  const best = new Map(); // normalized path -> {seq, archive, path, uncompSize, key, tier}
  let scanned = 0;
  for await (const r of streamRows(paths.pathsFile(originId))) {
    if (++scanned % 250_000 === 0) onProgress?.({ msg: `  ${originId}: ${scanned} paths scanned` });
    // An archive we cannot read is not a candidate, however new it is.
    if (blocked.has(r.file)) continue;
    const norm = normalizePath(r.path);
    // Cheap gate first: an index is mostly textures, maps and lua, and matching
    // every row against ~1,600 prefixes would dominate the run.
    if (gates && !gates.some((g) => norm.includes(g))) continue;
    const hit = find(norm);
    if (!hit) continue;
    const seq = Number(r.seq);
    const prev = best.get(norm);
    if (!prev || seq > prev.seq) {
      best.set(norm, {
        seq,
        archive: r.file,
        path: r.path,
        uncompSize: Number(r.uncompSize) || 0,
        key: hit.key,
        tier: hit.tier,
      });
    }
  }
  return best;
}

/**
 * Can this origin render this view, given the paths it carries for it?
 *
 * The planner needs this because its choice of origin is driven by how many
 * files an archive supplies, which is not the same as supplying the right ones.
 * Measured on the first path-covered plan: `robe:132 C_2022RTC_V_Coat4` went to
 * iRO, which has no `.spr` for it at all, while twRO has 343; `acc:1931
 * _C_Dullahan_Mask` went to kRO Zero, which has one sex, while twRO has both.
 * Both would have been fetched, stored, and found undrawable one stage later.
 *
 * What each namespace needs is what `stage5-catalogue.mjs` asks the tree for,
 * and the two have to agree or the plan promises what the catalogue rejects:
 *
 *   acc    both sex `.spr` files — a headgear half the players cannot see is
 *          not a costume.
 *   robe   at least one `.spr` anywhere in the folder. The `.act` files alone
 *          are animation data for artwork that never arrives.
 */
export function originCanDraw(kind, normalizedPaths) {
  const sprites = normalizedPaths.filter((p) => p.endsWith(".spr"));
  if (!sprites.length) return false;
  if (kind !== "acc") return true;
  const base = (p) => p.slice(p.lastIndexOf("/") + 1);
  // The sex is the first character of the file name, not a folder we can trust:
  // the same sprite sits under 악세사리/남/ and 악세사리/여/.
  return (
    sprites.some((p) => base(p).startsWith("남")) && sprites.some((p) => base(p).startsWith("여"))
  );
}

/** The most wanted slot among the views a step covers — the step's own rank. */
export function bestSlotOfStep(step, slotOf) {
  let best = null;
  for (const f of step.files) {
    const slot = slotOf.get(f.key);
    if (slot && (best === null || slotRank(slot) < slotRank(best))) best = slot;
  }
  return best;
}

/**
 * Greedy set cover over (origin, archive) pairs.
 *
 * `tiers` picks which target tiers count: `["core"]` plans the costumes alone,
 * `["core","effect"]` the auras too. Only files in the chosen tiers are
 * counted, so the byte total of a plan is the byte total of what it fetches.
 *
 * **The cover is over paths, not views.** The first version of this counted a
 * view as covered the moment one chosen archive supplied *any* of its files,
 * which is wrong whenever a costume's files are split across patches: Gravity
 * ships a garment's `.act` files in one patch and its `.spr` in another often
 * enough that 29 of 665 costumes arrived as animation data with no artwork, and
 * two kRO Zero hats arrived with one sex. Those costumes cannot draw, so the
 * plan looked complete while the mirror was not.
 *
 * **But a costume still comes from exactly one origin.** `origin` below pins a
 * view to the first origin that supplies part of it, and later archives from
 * other origins stop counting toward it. That is not tidiness: 282 `.act` files
 * differ in content between origins, so a garment assembled half from twRO and
 * half from iRO would animate against the wrong offsets. One origin per costume
 * keeps a costume internally consistent; which origin is the greedy's choice.
 *
 * The greedy therefore has one real degree of freedom — who supplies a
 * contested view — and once that is settled the archives are forced, since
 * `resolveOrigin` already keeps one archive per path.
 */
export function coverPlan(byOrigin, wantedKeys, { tiers = ["core", "effect"], slotOf = null } = {}) {
  const tierSet = new Set(tiers);
  const wanted = new Set(wantedKeys);

  // Every candidate, grouped by the origin and the view, so an origin that
  // cannot render a view can be dropped before it competes for it.
  const candidates = new Map(); // "<origin>|<view key>" -> {key, files}
  for (const [originId, best] of byOrigin) {
    for (const [norm, hit] of best) {
      if (!tierSet.has(hit.tier) || !wanted.has(hit.key)) continue;
      const k = `${originId}|${hit.key}`;
      let group = candidates.get(k);
      if (!group) candidates.set(k, (group = { key: hit.key, files: [] }));
      // `id` is what the cover counts. A path is unique within an origin, and
      // the same path in another origin is a different file with different
      // bytes, so the origin belongs in the identity.
      group.files.push({ ...hit, norm, originId, id: `${originId}|${norm}` });
    }
  }

  // "<origin>|<archive>" -> the files it would supply
  const buckets = new Map();
  for (const group of candidates.values()) {
    const kind = group.key.slice(0, group.key.indexOf(":"));
    if (!originCanDraw(kind, group.files.map((f) => f.norm))) continue;
    for (const f of group.files) {
      const k = `${f.originId}|${f.archive}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(f);
    }
  }

  const origin = new Map(); // view key -> the origin that supplies it, once decided
  const taken = new Set(); // file ids already assigned to a step
  // A file is still needed when nothing has fetched it and its view either has
  // no origin yet or has this one.
  const needed = (f) => {
    if (taken.has(f.id)) return false;
    const chosen = origin.get(f.key);
    return chosen === undefined || chosen === f.originId;
  };

  const steps = [];
  for (;;) {
    let pick = null;
    let gain = 0;
    for (const [k, files] of buckets) {
      let g = 0;
      for (const f of files) if (needed(f)) g++;
      if (g > gain) {
        gain = g;
        pick = k;
      }
    }
    if (!pick) break;
    // Take every needed file this archive carries, not just one per view: a
    // headgear needs both sexes, a garment a whole folder.
    const files = buckets.get(pick).filter(needed);
    const [originId, archive] = pick.split("|");
    for (const f of files) {
      taken.add(f.id);
      origin.set(f.key, f.originId);
    }
    steps.push({ originId, archive, seq: Math.min(...files.map((f) => f.seq)), files });
    buckets.delete(pick);
  }
  // A view no origin can *render* — either nobody carries it, or everybody
  // carries only part of it. Reporting it here is the point: fetching a
  // headgear with one sex costs bytes and still yields a costume the catalogue
  // throws away. Everything else is reachable by construction: while a needed
  // file is left, its bucket has a positive gain and gets picked.
  const uncovered = wantedKeys.filter((k) => !origin.has(k));

  // Order the steps. Ascending sequence by default, so a later patch overwrites
  // an earlier one — but that only matters when two steps write the same file,
  // and none do: `resolveOrigin` keeps one archive per path, each path lands in
  // exactly one step, and each origin mirrors into its own tree. So the
  // order is free, and `slotOf` spends it on fetching the most wanted costumes
  // first, since a full run takes hours and can be interrupted.
  steps.sort(
    (a, b) =>
      (slotOf ? slotRank(bestSlotOfStep(a, slotOf)) - slotRank(bestSlotOfStep(b, slotOf)) : 0) ||
      a.seq - b.seq,
  );
  return { steps, unreachable: [...uncovered] };
}

/** Totals worth printing, and the per-origin and per-tier split behind them. */
export function planStats({ steps, unreachable }, wantedKeys) {
  const perOrigin = {};
  const perTier = {};
  let files = 0;
  let bytes = 0;
  for (const s of steps) {
    perOrigin[s.originId] = (perOrigin[s.originId] ?? 0) + 1;
    for (const f of s.files) {
      files++;
      bytes += f.uncompSize;
      perTier[f.tier] = (perTier[f.tier] ?? 0) + f.uncompSize;
    }
  }
  return {
    wanted: wantedKeys.length,
    covered: wantedKeys.length - unreachable.length,
    unreachable: unreachable.length,
    archives: steps.length,
    files,
    bytes,
    perOrigin,
    perTier,
  };
}

/**
 * Run the whole planning pass and write `plan.tsv`.
 *
 * `slotOf` is a "kind:view" -> slot map, injected rather than read here: the
 * slot index is built from the raw item tables and so reaches the ragassets
 * extractor, which would drag this module — and the tests that cover it — into
 * needing a ragassets checkout.
 */
export async function planFetch({
  origins,
  includeEquipment = false,
  tiers = ["core", "effect"],
  slotOf = null,
  onProgress,
} = {}) {
  const wanted = wantedRows({ includeEquipment });
  const targets = wanted.flatMap(targetsOf).filter((t) => tiers.includes(t.tier));
  const wantedKeys = [...new Set(wanted.map(rowKey))];

  const byOrigin = new Map();
  for (const origin of origins) {
    const blocked = blockedFrom(readRows(paths.archives(origin.id)));
    onProgress?.({
      msg: `scanning ${origin.id}${blocked.size ? ` (${blocked.size} unreadable archive(s) skipped)` : ""}`,
    });
    byOrigin.set(origin.id, await resolveOrigin(origin.id, targets, { blocked, onProgress }));
  }

  const plan = coverPlan(byOrigin, wantedKeys, { tiers, slotOf });
  const stats = planStats(plan, wantedKeys);
  if (slotOf) {
    stats.perSlot = {};
    for (const s_ of plan.steps) {
      for (const f of s_.files) {
        const slot = slotOf.get(f.key) ?? "?";
        stats.perSlot[slot] = (stats.perSlot[slot] ?? 0) + f.uncompSize;
      }
    }
  }

  writeRows(
    paths.plan(),
    ["origin", "archive", "seq", "slot", "kind", "view", "tier", "path", "uncompSize"],
    plan.steps.flatMap((s) =>
      s.files.map((f) => {
        const [kind, view] = f.key.split(":");
        return [
          s.originId,
          s.archive,
          s.seq,
          slotOf?.get(f.key) ?? "",
          kind,
          view,
          f.tier,
          f.path,
          f.uncompSize,
        ];
      }),
    ),
  );

  return { ...stats, unreachableKeys: plan.unreachable };
}
