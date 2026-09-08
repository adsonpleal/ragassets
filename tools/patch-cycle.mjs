#!/usr/bin/env node
// One client-update cycle, end to end, on the machine that serves the assets.
//
// This replaces a chain that used to span three services: a Cloudflare Worker
// cron polled the patch index and kept its position in KV, fired a
// repository_dispatch, and a GitHub runner did the extraction. The runner was
// the problem. It is stateless, and the derived stores — icons, illust, effects,
// raw, maps, bgm, sounds — cannot be rebuilt from a patch alone; they need the
// whole merged client (see the header of extract-grf.mjs). So a patch that added
// an item shipped its sprite and never its icon. A box with the mirror on local
// disk simply does not have that problem, and once the extraction lives here the
// poll may as well too.
//
// Usage:
//   node tools/patch-cycle.mjs                  a cycle; the timer runs this
//   node tools/patch-cycle.mjs --seed           record the current head, do nothing else
//   node tools/patch-cycle.mjs --dry-run        report what a cycle would do
//   node tools/patch-cycle.mjs --force-seq <n>  start from n, ignoring the state file
//   node tools/patch-cycle.mjs --max <n>        cap how many patches to apply
//   node tools/patch-cycle.mjs --skip-maps      skip the 5.8 GB rebuild
//
// The working directory must be the repo root: apply-patches.mjs writes
// patch-report.json relative to the CWD and spawns extract-grf.mjs by a relative
// path. The systemd unit sets WorkingDirectory for this reason.
//
// Exit codes: 0 = the cycle completed or had nothing to do (including a handled
// failure that left the work pending). 1 = a bug or a broken invariant, which
// should page a human rather than be retried silently.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { PATCH_INDEX, parsePatchList } from "./patchlist.mjs";

const REPO = process.cwd();
const STATE = process.env.RAGASSETS_STATE || "/var/lib/ragassets/patch-state.json";
const MIRROR = process.env.RAGASSETS_MIRROR || join(REPO, "mirror");
const DERIVED = process.env.RAGASSETS_DERIVED || join(REPO, "resources");
const LOOSE = dirname(MIRROR); // System/ and BGM/ sit beside the mirror, as in a client install
const ROBE_INDEX = process.env.RAGASSETS_ROBE_INDEX || "/var/lib/ragassets/robe-index.json";
const GATEWAY_UNIT = process.env.RAGASSETS_GATEWAY_UNIT || "ragassets-gateway.service";

// A cycle that keeps failing would otherwise re-download the same archives every
// ten minutes forever. The Worker never had to think about this: it dispatched
// and forgot. Back off after three, and let an hour of silence clear it — long
// enough to be quiet, short enough that a transient CDN outage heals itself.
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_MS = 60 * 60 * 1000;

// --maps rebuilds its whole 5.8 GB / 21.4k-file tree from scratch. Gating it on
// "did this patch touch map inputs" is not enough on its own, because a run of
// patches over one maintenance can each touch a texture. Once a day is plenty
// for geometry that changes a few times a year.
const MAPS_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

function log(...a) {
  console.error(`[${new Date().toISOString()}]`, ...a);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") out.seed = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--skip-maps") out.skipMaps = true;
    else if (a === "--force-seq") out.forceSeq = Number(argv[++i]);
    else if (a === "--max") out.max = Number(argv[++i]);
    else throw new Error(`unknown flag ${a}`);
  }
  return out;
}

function readState() {
  if (!existsSync(STATE)) return null;
  return JSON.parse(readFileSync(STATE, "utf8"));
}

// Written last and only on success, atomically. The invariant this protects came
// from the Worker and has not changed: a failed cycle must leave the work
// pending, or the patch is skipped forever — the next poll would see the same
// index, match on seq, and do nothing.
function writeState(next) {
  mkdirSync(dirname(STATE), { recursive: true });
  const tmp = `${STATE}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, STATE);
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: REPO, stdio: ["ignore", "inherit", "inherit"], ...opts });
}

function node(args) {
  run(process.execPath, args);
}

async function fetchIndex(prevETag) {
  // cache: "no-store" is not belt-and-braces. patch.txt ships
  // Cache-Control: public, max-age=3600, so anything that honours it would turn
  // a ten-minute poll into an hourly one — silently, with every poll logging
  // success. The Worker passed cf: {cacheTtl: 0} for exactly this reason.
  const res = await fetch(PATCH_INDEX, {
    cache: "no-store",
    headers: prevETag ? { "If-None-Match": prevETag } : {},
  });
  return res;
}

// Which derived stores a patch's file list makes stale.
//
// Keyed off report.files — the flat list — and never report.byPrefix, which
// buckets to two path segments and so cannot tell data/texture/effect from
// data/texture/유저인터페이스. post-novidades.mjs makes the same choice for the
// same reason.
//
// The gate is what makes a ten-minute timer affordable. The game patches two or
// three times a day, but only a maintenance touches the inputs of the derived
// stores; the common patch is sprites alone, and its whole cycle is download,
// overlay, prune, restart. Order matters too: cheapest first, so a failure
// surfaces before hours of work, and so /raw — which sibling projects poll on
// every client update — goes live first.
const REBUILDS = [
  {
    name: "raw",
    out: () => join(DERIVED, "raw"),
    flag: "--raw",
    touched: (f) => /^System\/.*\.lub$/i.test(f),
  },
  {
    name: "icons",
    out: () => join(DERIVED, "icons"),
    flag: "--icons",
    touched: (f) =>
      /^System\/iteminfo/i.test(f) ||
      /^data\/texture\/[^/]+\/(item|collection|basic_interface)\//i.test(f),
  },
  {
    name: "illust",
    out: () => join(DERIVED, "illust"),
    flag: "--illust",
    touched: (f) =>
      /^data\/texture\/[^/]+\/cardbmp\//i.test(f) || /^data\/num2cardillustnametable\.txt$/i.test(f),
  },
  {
    name: "effects",
    out: () => join(DERIVED, "effects"),
    flag: "--effects",
    touched: (f) => /^System\/iteminfo/i.test(f) || /^data\/texture\/effect\//i.test(f),
  },
  {
    name: "sounds",
    out: () => join(DERIVED, "sounds"),
    flag: "--sounds",
    touched: (f) => /^data\/wav\//i.test(f),
  },
  {
    name: "bgm",
    out: () => join(DERIVED, "bgm"),
    flag: "--bgm",
    extra: () => ["--bgmsrc", join(LOOSE, "BGM")],
    touched: (f) => /^data\/mp3nametable\.txt$/i.test(f) || /^BGM\//i.test(f),
  },
  {
    name: "maps",
    out: () => join(DERIVED, "maps"),
    flag: "--maps",
    // Deliberately broad: a map is geometry plus everything it references, so a
    // model or a non-UI texture can change what a map looks like without the
    // .rsw changing at all.
    touched: (f) =>
      /^data\/model\//i.test(f) ||
      /^data\/[^/]+\.(rsw|gnd|gat)$/i.test(f) ||
      (/^data\/texture\//i.test(f) && !/^data\/texture\/[^/]+\/(item|collection|basic_interface|cardbmp)\//i.test(f)),
  },
];

// --iteminfo is always passed explicitly. extract-grf.mjs resolves it as
// dirname(resolve(--grf))/System, which for a mirror at ~/ragassets/mirror lands
// on ~/ragassets/System — correct here, but only by coincidence of layout, and
// far too subtle to leave implicit in an unattended job.
function itemInfoPath() {
  return join(LOOSE, "System", "iteminfo_new.lub");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let state = readState();
  if (!state && !args.seed && args.forceSeq === undefined) {
    // Never default to 0. That asks for the entire archive history, which
    // apply-patches.mjs would correctly refuse at MAX_PATCHES — but refusing
    // every ten minutes forever is not a useful failure mode.
    throw new Error(
      `no state at ${STATE}. Run \`node tools/patch-cycle.mjs --seed\` once to ` +
        `record the current head before enabling the timer.`,
    );
  }
  state ??= { etag: null, seq: 0, consecutiveFailures: 0 };

  const failures = state.consecutiveFailures ?? 0;
  if (failures >= MAX_CONSECUTIVE_FAILURES && !args.seed) {
    const since = Date.now() - Date.parse(state.updatedAt ?? 0);
    if (since < BACKOFF_MS) {
      log(`backing off: ${failures} consecutive failures, last error: ${state.lastError}`);
      return;
    }
    log(`backoff elapsed after ${failures} failures; retrying`);
  }

  // The whole poll, and on the overwhelming majority of runs the whole cycle:
  // one process start, one conditional GET, no body, no disk write. Seeding and
  // an explicit --force-seq deliberately ask for the body.
  const conditional = state.etag && !args.seed && args.forceSeq === undefined;
  const res = await fetchIndex(conditional ? state.etag : null);
  if (res.status === 304) {
    log(`304, unchanged (seq ${state.seq})`);
    return;
  }
  if (!res.ok) {
    // A CDN hiccup is not a cycle failure and must not consume a backoff slot;
    // leave seq and etag exactly as they were and try again in ten minutes.
    log(`patch.txt: HTTP ${res.status}; leaving state at seq ${state.seq}`);
    return;
  }

  const list = parsePatchList(await res.text());
  const head = list.reduce((m, p) => Math.max(m, p.seq), 0);
  const etag = res.headers.get("etag");

  if (args.seed) {
    writeState({
      etag,
      seq: head,
      updatedAt: new Date().toISOString(),
      consecutiveFailures: 0,
      lastError: null,
    });
    log(`seeded at seq ${head}; the next cycle applies only what comes after it`);
    return;
  }

  const fromSeq = args.forceSeq ?? state.seq;
  const fresh = list.filter((p) => p.seq > fromSeq);
  if (!fresh.length) {
    // The index changed but carries nothing newer — a retraction, or a rewrite.
    // Record the new validator so the next poll is a cheap 304 again.
    log(`index changed but nothing newer than seq ${fromSeq}`);
    if (!args.dryRun) {
      writeState({ ...state, etag, updatedAt: new Date().toISOString() });
    }
    return;
  }
  log(`${fresh.length} new patch(es): seq ${fresh[0].seq}..${head}`);

  if (args.dryRun) {
    for (const p of fresh) log(`  would apply ${p.seq}\t${p.file}`);
    return;
  }

  let result;
  try {
    result = await cycle({ fromSeq, head, args, state });
  } catch (e) {
    // Record the failure without advancing seq or etag, so the same work is
    // still pending on the next run.
    writeState({
      ...state,
      consecutiveFailures: failures + 1,
      lastError: String(e?.message ?? e).slice(0, 500),
      updatedAt: new Date().toISOString(),
    });
    log(`CYCLE FAILED (${failures + 1} in a row): ${e?.stack ?? e}`);
    return;
  }

  writeState({
    etag,
    seq: head,
    updatedAt: new Date().toISOString(),
    consecutiveFailures: 0,
    lastError: null,
    lastMapsRebuildAt: result.mapsRebuiltAt ?? state.lastMapsRebuildAt ?? null,
  });
  log(`cycle complete; at seq ${head}`);
}

async function cycle({ fromSeq, head, args, state }) {
  // A crashed previous run can leave these behind; a stale patchfiles/ would be
  // overlaid onto the mirror a second time. Harmless (patches carry whole files)
  // but it would make the report lie about what this cycle changed.
  for (const d of ["patchfiles", "patch-report.json", "_patchdl"]) {
    rmSync(join(REPO, d), { recursive: true, force: true });
  }

  const applyArgs = ["tools/apply-patches.mjs", "--out", "patchfiles", "--from-seq", String(fromSeq)];
  if (args.max) applyArgs.push("--max", String(args.max));
  node(applyArgs);

  const report = JSON.parse(readFileSync(join(REPO, "patch-report.json"), "utf8"));
  const files = report.files ?? [];
  if (!files.length) {
    // Every listed patch 404'd — the documented outcome for a run of retracted
    // patches. There is nothing to overlay, but the sequence really is consumed.
    log(`no files arrived (${report.skipped?.length ?? 0} skipped); advancing to ${head}`);
    return {};
  }
  log(`${files.length} file(s) arrived`);

  // Patches carry whole copies of the files they change, never deltas, so
  // copy-with-overwrite is not an approximation of the merge — it is the merge.
  // -a keeps the CDN's mtimes, which matter: fileETag is mtime+size, so an
  // overwritten icon only gets a new validator because its mtime moved.
  for (const [src, dst] of [
    [join(REPO, "patchfiles", "data"), join(MIRROR, "data")],
    [join(REPO, "patchfiles", "System"), join(LOOSE, "System")],
  ]) {
    if (!existsSync(src)) continue;
    mkdirSync(dst, { recursive: true });
    run("cp", ["-a", `${src}/.`, `${dst}/`]);
  }

  // Gravity copies the adventurer-backpack sprites into every robe folder, and a
  // patch re-introduces them. The index makes this ~0.2s instead of ~31s over
  // 56k sprites.
  if (existsSync(ROBE_INDEX)) {
    node(["extract-grf.mjs", "--prune-robes", MIRROR, "--index", ROBE_INDEX]);
  } else {
    log(`no robe index at ${ROBE_INDEX}; building one (slow, once)`);
    mkdirSync(dirname(ROBE_INDEX), { recursive: true });
    node(["extract-grf.mjs", "--robe-index", ROBE_INDEX, "--grf", MIRROR]);
    node(["extract-grf.mjs", "--prune-robes", MIRROR, "--index", ROBE_INDEX]);
  }

  // A patch that ships luafiles514 changes the id -> sprite-name tables that are
  // baked into the binary by cmd/gen-resolver and cmd/gen-tables. Rebuilding
  // those recompiles the renderer, which is a far larger blast radius than an
  // icon, so it stays a human decision — but it must be a visible one.
  if (files.some((f) => /^data\/luafiles514\//i.test(f))) {
    log("");
    log("*** this patch ships data/luafiles514 — the baked resolver tables are stale.");
    log("*** New headgear will render as nothing until someone re-runs");
    log("*** gateway/cmd/gen-resolver and gen-tables, rebuilds and restarts.");
    log("");
  }

  const mapsLast = Date.parse(state.lastMapsRebuildAt ?? 0) || 0;
  let mapsRebuiltAt = null;
  for (const r of REBUILDS) {
    if (!files.some(r.touched)) continue;
    if (r.name === "maps") {
      if (args.skipMaps) {
        log("maps inputs changed, but --skip-maps was given");
        continue;
      }
      if (Date.now() - mapsLast < MAPS_MIN_INTERVAL_MS) {
        log("maps inputs changed, but the tree was rebuilt within the last day");
        continue;
      }
    }
    log(`rebuilding ${r.name}`);
    const argv = ["extract-grf.mjs", r.flag, r.out(), "--grf", MIRROR, "--iteminfo", itemInfoPath()];
    if (r.extra) argv.push(...r.extra());
    node(argv);
    if (r.name === "maps") mapsRebuiltAt = new Date().toISOString();
  }

  // Mandatory, not hygiene. resource.Manager's parse caches are keyed by name
  // and resolve.Store's per-folder directory index is built once — so without a
  // restart a patched sprite serves from a stale parse and a *new* file in an
  // already-indexed effect folder 404s forever. Both doc comments say so.
  run("sudo", ["systemctl", "restart", GATEWAY_UNIT]);

  // Everything past here is announcement, not correctness. A failure must not
  // abort the cycle or block the state write, or a Discord outage would make the
  // box re-apply the same patch every ten minutes.
  try {
    await purgeCloudflare();
  } catch (e) {
    log(`cache purge failed (ignored): ${e?.message ?? e}`);
  }
  try {
    node(["tools/post-novidades.mjs", "--report", "patch-report.json"]);
  } catch (e) {
    log(`discord post failed (ignored): ${e?.message ?? e}`);
  }

  return { mapsRebuiltAt };
}

// Cloudflare's free plan gives purge-by-URL, capped at 30 URLs per call; prefix
// and tag purge are Enterprise. That rules out invalidating renders, and it does
// not matter: a patch that adds a sprite creates new ids and therefore new URLs,
// so nothing stale exists. A patch that *redraws* an existing sprite is the
// genuine gap — the URL and its query-derived ETag are unchanged, so the edge
// keeps the old pixels. Purge Everything is the only lever, at the cost of a
// fully cold render cache, and it is a human's call.
//
// What is purgeable is the handful of stably-named indexes that change on every
// patch and would otherwise sit behind their own Cache-Control until it expires.
const PURGE_PATHS = [
  "/raw/items.json",
  "/raw/mobs.json",
  "/raw/skills.json",
  "/raw/jobs.json",
  "/raw/classes.json",
  "/raw/status.json",
  "/raw/randomopt.json",
  "/raw/hair.json",
  "/effects/index.json",
  "/effects/stones.json",
  "/maps/index.json",
  "/bgm/index.json",
  "/effect/sound/index.json",
];

async function purgeCloudflare() {
  const zone = process.env.CF_ZONE_ID;
  const token = process.env.CF_PURGE_TOKEN;
  const origin = process.env.RAGASSETS_SITE_URL || "https://assets.latam-tools.com.br";
  if (!zone || !token) {
    log("no CF_ZONE_ID/CF_PURGE_TOKEN; skipping the cache purge");
    return;
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ files: PURGE_PATHS.map((p) => origin + p) }),
  });
  if (!res.ok) throw new Error(`purge: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  log(`purged ${PURGE_PATHS.length} index URL(s)`);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
