#!/usr/bin/env node
// Rebuild resources/raw/mobs.json (monster stats) from the RagnaPlace Public API.
//
//   node tools/scrape-mobs.mjs --ids mobids.json
//   node tools/scrape-mobs.mjs --ids mobids.json --gateway laro-es --out mobs-es.json
//
// The output lands in resources/raw/ (gitignored, like every other extracted
// asset) and the gateway serves it at /raw/mobs.json. It used to be committed at
// the repo root; consumers now fetch it over HTTP instead of from GitHub raw.
//
// The API (https://api.ragnaplace.com, spec at https://ro.ragnaplace.com/v1/openapi.json)
// has no bulk mob endpoint — its /v1/<gateway>/search caps at 20 pages × 20 rows —
// so the only way to enumerate every monster is one GET per id against
// /v1/<gateway>/mob/<id>. The candidate id list therefore comes from the client:
//
//   node extract-grf.mjs --mobids mobids.json --grf path/to/data.grf
//
// Ids in that list that aren't monsters (NPC/job sprites) simply 404 and are
// skipped. Ids already in the existing output file are folded in too, so a mob
// the client drops from npcidentity.lub doesn't silently vanish from mobs.json.
//
// Authentication is the `x-api-key` header, read from RAGNAPLACE_API_KEY in the
// environment or in ./.env (gitignored). The key is never logged.
//
// Rate limits are per-key and advertised on every response via X-RateLimit-*;
// the run throttles itself off those headers rather than a hardcoded rate.
// Raw records are appended to <out>.partial.jsonl as they arrive so an interrupted
// run resumes instead of re-spending the whole quota; it is removed on success, so
// every completed run is fresh data rather than a replay of an old cache.
//
// ## The second source
//
// RagnaPlace has no `res`/`mres` field — the 4th-job resistances — for any
// monster, so those come from tools/crawl-divine-pride.mjs and are merged in
// here. The split of authority is deliberate:
//
//   RagnaPlace  identity (id, aegisId) and the pt-BR `name`. It is the LATAM
//               client's own vocabulary; divine-pride serves the Korean name.
//   divine-pride  `res`/`mres`, which exist nowhere else.
//
// Every field the two sources *both* publish is cross-checked, and a
// disagreement stops the run rather than picking a winner — see checkAgainstDp().
// A monster with no divine-pride page publishes res/mres **null**, never 0:
// most pre-4th-job monsters really are 0, and conflating "zero" with "unknown"
// is what made a level 224 MVP simulate as having no resistance at all.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_BASE = "https://api.ragnaplace.com";
const DEFAULT_GATEWAY = "laro-pt";
// Leave this much of the window's quota unspent before parking, so the in-flight
// requests can't overshoot into a 429.
const RATE_FLOOR = 4;
const MAX_ATTEMPTS = 4;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ids") out.ids = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--gateway") out.gateway = argv[++i];
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a === "--fresh") out.fresh = true;
    else if (a === "--dp") out.dp = argv[++i];
    else if (a === "--no-dp") out.noDp = true;
    else if (a === "--allow-partial-dp") out.allowPartialDp = true;
    else if (a === "--merge-only") out.mergeOnly = true;
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

function usage() {
  console.error(
    [
      "Rebuild resources/raw/mobs.json from the RagnaPlace Public API.",
      "",
      "  node tools/scrape-mobs.mjs --ids <mobids.json> [--out mobs.json]",
      "                             [--gateway laro-pt] [--concurrency 8] [--fresh]",
      "                             [--dp _scratch/dp-stats.json | --no-dp]",
      "",
      "  --ids     candidate id list from `extract-grf.mjs --mobids` (required)",
      "  --out     output file (default: resources/raw/mobs.json)",
      "  --gateway RagnaPlace gateway slug (default: laro-pt)",
      "  --fresh   discard a leftover <out>.partial.jsonl and re-fetch every id",
      "  --dp      divine-pride stats from tools/crawl-divine-pride.mjs; supplies",
      "            res/mres and cross-checks every shared field",
      "            (default: _scratch/dp-stats.json)",
      "  --no-dp   publish res/mres as null for every monster. Only for a first",
      "            run, when there is no mobs.json for the crawler to walk yet.",
      "  --allow-partial-dp  accept a dp-stats.json that does not cover every",
      "            monster (a --limit sample); the rest publish res/mres null",
      "  --merge-only  don't touch the RagnaPlace API at all: re-merge and",
      "            re-cross-check divine-pride into the existing --out file.",
      "            Use after re-running the crawler; costs no API quota.",
      "",
      "  Needs RAGNAPLACE_API_KEY in the environment or in ./.env",
    ].join("\n"),
  );
}

// Minimal .env reader — the repo has no dependencies and this only ever needs to
// find one key. Ignores comments/blank lines and strips surrounding quotes.
function readApiKey() {
  if (process.env.RAGNAPLACE_API_KEY) return process.env.RAGNAPLACE_API_KEY.trim();
  const envPath = resolve(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return null;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?RAGNAPLACE_API_KEY\s*=\s*(.*)$/.exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

// One shared budget for all workers: every response republishes the window's
// remaining quota, and when it runs low everyone parks until the window resets.
class RateGate {
  constructor() {
    this.until = 0; // epoch ms to wait for; 0 = go
  }
  observe(res) {
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(remaining) && Number.isFinite(reset) && remaining <= RATE_FLOOR) {
      // `reset` is seconds until the window rolls over; +1s of slack for clock skew.
      this.until = Math.max(this.until, Date.now() + (reset + 1) * 1000);
    }
  }
  backoff(res, attempt) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const secs = Number.isFinite(retryAfter) ? retryAfter : Number.isFinite(reset) ? reset : 2 ** attempt;
    this.until = Math.max(this.until, Date.now() + (secs + 1) * 1000);
  }
  async wait() {
    while (this.until > Date.now()) {
      await new Promise((r) => setTimeout(r, this.until - Date.now()));
    }
  }
}

// Returns the Mob object, or null when the id isn't a monster (404).
async function fetchMob(gateway, id, key, gate) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await gate.wait();
    let res;
    try {
      res = await fetch(`${API_BASE}/v1/${gateway}/mob/${id}`, {
        headers: { "x-api-key": key, accept: "application/json" },
      });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS - 1) throw err;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      continue;
    }
    gate.observe(res);

    if (res.status === 200) return res.json();
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      gate.backoff(res, attempt);
      continue;
    }
    // 401/403 are terminal: a bad, pending or unapproved key won't fix itself.
    throw new Error(`GET /v1/${gateway}/mob/${id} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error(`GET /v1/${gateway}/mob/${id} failed after ${MAX_ATTEMPTS} attempts`);
}

// The API's Mob is much richer than mobs.json needs; this is the projection the
// file has always carried.
//
// `class` is "Boss" for mini-bosses (Ghostring, Angeling) *and* MVPs, so it alone
// can't set `mvp`, and the API exposes no rAthena-style `modes` field. No single
// field reproduces that old value, so `mvp` is the union of three signals:
//
//   1. AI `type` 301 (300 on everything else) — the game's own MVP marker, and the
//      same value the client's navigation/navi_mob_br.lub packs per spawn. The two
//      agree on every mob present in both, including the negatives that trip up
//      looser rules (Ghostring, Angeling and Mysteltainn are 300, not MVPs).
//      `type` is a *string* in the schema ("301"), so compare numerically —
//      `=== 301` silently never matches and quietly costs ~70 MVPs.
//   2. `exp.mvp` set — unambiguous, but null on many real MVPs.
//   3. An MVP-only drop table on a Boss-class mob. This is what catches the MVPs
//      that carry `type: 300`/null and no MVP exp (Naght Sieger, Entweihen, the
//      event/echo boss variants). The Boss-class guard matters: an MVP drop alone
//      over-fires on event mobs like the Event-class E_ANOPHELES.
function isMvp(m) {
  if (Number(m.type) === 301 || m.exp?.mvp != null) return true;
  return m.class === "Boss" && (m.drops || []).some((d) => d.isMvpDrop);
}

function toRecord(m) {
  const mvp = isMvp(m);
  return {
    id: m.id,
    aegisId: m.sprite,
    name: m.name,
    // Upstream leaves `class` null (missing, not "not a boss") on a lot of
    // instance MVPs, so fold `mvp` in to keep the mvp ⊆ boss invariant the file
    // has always had — an MVP is boss-class by definition.
    boss: m.class === "Boss" || mvp,
    mvp,
    level: m.level,
    baseExp: m.exp?.base ?? null,
    jobExp: m.exp?.job ?? null,
    mvpExp: m.exp?.mvp ?? null,
    hp: m.hp,
    def: m.def ?? null,
    mdef: m.mdef ?? null,
    attack: m.attack ?? null,
    str: m.stats?.str ?? null,
    agi: m.stats?.agi ?? null,
    vit: m.stats?.vit ?? null,
    int: m.stats?.int ?? null,
    dex: m.stats?.dex ?? null,
    luk: m.stats?.luk ?? null,
    race: m.race,
    size: m.size,
    property: m.element,
    // Kept separate rather than folded into `property` as "Dark 3" — consumers
    // that want the combined form can join them, but not the other way round.
    propertyLevel: m.elementLevel ?? null,
    // Appended, never inserted: existing consumers read by name, and keeping the
    // shared fields byte-identical makes a diff against the previous file show
    // only the two new keys.
    //
    // null means "divine-pride has no page for this monster", NOT zero. Most
    // pre-4th-job monsters genuinely are 0 and are published as 0.
    res: null,
    mres: null,
  };
}

// ---------------------------------------------------------------------------
// divine-pride cross-check and merge
// ---------------------------------------------------------------------------

// Fields both sources publish, and therefore fields a disagreement can be found
// in. `attack` is deliberately *not* here: RagnaPlace returns the database's raw
// attack, divine-pride renders the computed renewal attack range — Baphomet is
// 2520 upstream and "2,721 - 3,981" on the page. They are different quantities,
// not a divergence, and cross-checking them fires on ~95% of the catalogue.
// divine-pride's matk/range/hit/flee have no RagnaPlace counterpart at all.
export const CROSS_CHECKED = [
  ["level", (d) => d.level],
  ["hp", (d) => d.hp],
  ["def", (d) => d.def],
  ["mdef", (d) => d.mdef],
  ["str", (d) => d.str],
  ["agi", (d) => d.agi],
  ["vit", (d) => d.vit],
  ["int", (d) => d.int],
  ["dex", (d) => d.dex],
  ["luk", (d) => d.luk],
  ["size", (d) => d.size],
  ["property", (d) => d.property],
  ["propertyLevel", (d) => d.propertyLevel],
  ["race", (d) => d.race, canonRace],
];

// The two databases name two of the races differently and neither is wrong:
// kRO renamed Demi-Human to Human, and "fantasma" is the untranslated pt-BR
// label for Formless that the laro-pt gateway leaks on 449 rows (documented in
// the update-mob-stats skill — it is RagnaPlace's own dirt, not a transit bug).
// Canonicalising both sides keeps a vocabulary difference from masquerading as
// a data difference, which would bury the real ones.
const RACE_ALIASES = new Map([
  ["fantasma", "formless"],
  ["demihuman", "human"],
  ["demi-human", "human"],
]);
export function canonRace(v) {
  const k = String(v).toLowerCase();
  return RACE_ALIASES.get(k) ?? k;
}

function loadDpStats(path) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(
        `! no divine-pride stats at ${path}.\n` +
          `  res/mres come only from there, and publishing them as null for every monster\n` +
          `  would silently undo the reason this second source exists. Run:\n\n` +
          `      node tools/crawl-divine-pride.mjs\n\n` +
          `  or pass --no-dp if you genuinely want a res/mres-less file (a first run,\n` +
          `  before there is a mobs.json for the crawler to walk).`,
      );
      process.exit(1);
    }
    throw err;
  }
  // The file records which of the page's per-server stat tables it was built
  // from. Anything but the LATAM one is another server's monsters wearing the
  // right shape, so refuse it here rather than cross-checking LATAM records
  // against, say, iRO's and reporting the difference as a data divergence.
  if (doc.block !== "alternatestats_default") {
    console.error(
      `! ${path} was built from the "${doc.block}" stat block, not "alternatestats_default".\n` +
        `  That is a different server's data. Re-run tools/crawl-divine-pride.mjs --fresh.`,
    );
    process.exit(1);
  }
  if (!Array.isArray(doc.monsters) || !doc.monsters.length) {
    console.error(`! ${path} holds no monsters. Re-run tools/crawl-divine-pride.mjs.`);
    process.exit(1);
  }
  const byId = new Map(doc.monsters.map((m) => [m.id, m]));
  return { doc, byId, missing: new Set(doc.missing || []) };
}

// The acknowledgement ledger. An entry matches only while both recorded values
// still hold, so a re-review is forced the moment either source moves.
export function loadDivergenceLedger() {
  const path = resolve(REPO_ROOT, "tools/dp-divergences.json");
  const accepted = new Map(); // `${id}:${field}` -> entry
  // Monsters whose divine-pride record a human has judged to describe something
  // else entirely — a dummy row, a different episode. Its `res`/`mres` are then
  // not a measurement of anything, so they publish null. Zero would be a claim.
  const untrustedResistances = new Set();
  if (!existsSync(path)) return { path, accepted, untrustedResistances };
  for (const e of JSON.parse(readFileSync(path, "utf8")).accepted || []) {
    accepted.set(`${e.id}:${e.field}`, e);
    if (e.resistances === "unknown") untrustedResistances.add(e.id);
  }
  return { path, accepted, untrustedResistances };
}

// Compares one monster against its divine-pride block. Returns the unacknowledged
// disagreements, and applies the acknowledged ones' `prefer` to `record`.
export function checkAgainstDp(record, dp, ledger) {
  const problems = [];
  for (const [field, get, canon] of CROSS_CHECKED) {
    const mine = record[field];
    const theirs = get(dp);
    // Either side not knowing isn't a disagreement. RagnaPlace leaves race/size/
    // property null on a handful of rows; there is nothing to contradict.
    if (mine == null || theirs == null) continue;
    const norm = canon || ((v) => String(v));
    if (norm(mine) === norm(theirs)) continue;

    const ack = ledger.accepted.get(`${record.id}:${field}`);
    if (ack && String(ack.ragnaplace) === String(mine) && String(ack.divinePride) === String(theirs)) {
      if (ack.prefer === "divine-pride") record[field] = theirs;
      continue;
    }
    problems.push({ id: record.id, aegisId: record.aegisId, field, ragnaplace: mine, divinePride: theirs, stale: !!ack });
  }
  return problems;
}

// One line accounting for where every record's res/mres came from. Worth being
// precise about: the counts are how you notice a crawl went stale, and "null"
// covers three different reasons that must not be allowed to blur together.
function describeDpMerge(records, stats) {
  const nonZero = records.filter((r) => r.res > 0 || r.mres > 0).length;
  const nulls = [
    [stats.absent, "no divine-pride data"],
    [stats.untrusted, "divine-pride record not trusted (see the ledger)"],
    [stats.uncovered, "not crawled — partial run"],
  ].filter(([n]) => n > 0);
  return (
    `res/mres: ${stats.merged} from divine-pride (${nonZero} non-zero, ${stats.merged - nonZero} a real 0)` +
    (nulls.length ? `, ${nulls.map(([n, why]) => `${n} null — ${why}`).join(", ")}` : "")
  );
}

export function mergeDp(records, dp, allowPartial) {
  const ledger = loadDivergenceLedger();
  const problems = [];
  let merged = 0;
  let absent = 0;
  let uncovered = 0;
  let untrusted = 0;

  for (const r of records) {
    const block = dp.byId.get(r.id);
    if (!block) {
      // Explicit null rather than an absent key: consumers must be able to tell
      // "unknown" from 0, and --merge-only starts from records that have neither.
      r.res = null;
      r.mres = null;
      // No page on divine-pride (recorded by the crawler) vs never crawled are
      // very different: the first is a real null, the second is a hole in the run.
      if (dp.missing.has(r.id)) absent++;
      else uncovered++;
      continue;
    }
    problems.push(...checkAgainstDp(r, block, ledger));
    if (ledger.untrustedResistances.has(r.id)) {
      r.res = null;
      r.mres = null;
      untrusted++;
      continue;
    }
    r.res = block.res;
    r.mres = block.mres;
    merged++;
  }

  if (uncovered && !allowPartial) {
    console.error(
      `\n! the divine-pride crawl covers ${merged + absent} of ${records.length} monsters; ` +
        `${uncovered} were never fetched.\n` +
        `  Those would publish res/mres null, which consumers read as "unknown" — the same\n` +
        `  ambiguity this source exists to remove. Finish the crawl:\n\n` +
        `      node tools/crawl-divine-pride.mjs\n\n` +
        `  (it resumes from its cache), or pass --allow-partial-dp to accept the holes.`,
    );
    process.exit(1);
  }

  if (problems.length) {
    console.error(
      `\n! ${problems.length} field(s) disagree between RagnaPlace and divine-pride.\n` +
        `  Neither source is silently preferred: a disagreement means either the crawler\n` +
        `  broke or the two databases genuinely differ, and only a human can tell those\n` +
        `  apart. mobs.json was NOT written.\n`,
    );
    for (const p of problems) {
      console.error(
        `    ${String(p.id).padStart(5)} ${(p.aegisId || "").padEnd(24)} ${p.field.padEnd(14)}` +
          ` ragnaplace=${JSON.stringify(p.ragnaplace)}  divine-pride=${JSON.stringify(p.divinePride)}` +
          `${p.stale ? "   (an entry exists in the ledger but records different values — re-review it)" : ""}`,
      );
      console.error(`          https://www.divine-pride.net/database/monster/${p.id}`);
    }
    console.error(
      `\n  After checking them by hand, record each one in ${ledger.path}:\n\n` +
        JSON.stringify(
          problems.slice(0, 2).map((p) => ({
            id: p.id,
            aegisId: p.aegisId,
            field: p.field,
            ragnaplace: p.ragnaplace,
            divinePride: p.divinePride,
            prefer: "ragnaplace",
            reviewed: new Date().toISOString().slice(0, 10),
            why: "…",
          })),
          null,
          2,
        )
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
    );
    process.exit(1);
  }

  return { merged, absent, uncovered, untrusted };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.ids && !args.mergeOnly)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (args.mergeOnly && args.noDp) {
    console.error("--merge-only --no-dp would do nothing.");
    process.exit(1);
  }

  const outPath = resolve(args.out ? args.out : resolve(REPO_ROOT, "resources/raw/mobs.json"));
  const partialPath = `${outPath}.partial.jsonl`;
  mkdirSync(dirname(outPath), { recursive: true });
  const concurrency = Number.isFinite(args.concurrency) && args.concurrency > 0 ? args.concurrency : 8;

  // Loaded up front, before spending the API quota, so a missing or malformed
  // crawl is an instant failure rather than one discovered an hour later.
  const dpPath = resolve(args.dp ? args.dp : resolve(REPO_ROOT, "_scratch/dp-stats.json"));
  const dp = args.noDp ? null : loadDpStats(dpPath);
  if (dp) {
    console.error(
      `divine-pride: ${dp.byId.size} stat blocks from ${dpPath}` +
        ` (crawled ${dp.doc.crawledAt || "?"}, block ${dp.doc.block || "?"})`,
    );
  } else {
    console.error("! --no-dp: res/mres will be null for every monster");
  }

  // Re-merging a fresh crawl into a file the API already produced. The records
  // in mobs.json *are* the RagnaPlace projection, so they cross-check exactly as
  // well as freshly fetched ones — and re-fetching 2700 monsters to update two
  // fields would burn the whole key quota for nothing.
  if (args.mergeOnly) {
    if (!existsSync(outPath)) {
      console.error(`! --merge-only needs an existing ${outPath}; run a full scrape first.`);
      process.exit(1);
    }
    const existing = JSON.parse(readFileSync(outPath, "utf8"));
    const stats = mergeDp(existing, dp, args.allowPartialDp);
    writeFileSync(outPath, `${JSON.stringify(existing, null, 2)}\n`);
    console.error(
      `\nmerged divine-pride into ${existing.length} existing records in ${outPath}\n` +
        `  ${describeDpMerge(existing, stats)}`,
    );
    return;
  }

  const key = readApiKey();
  if (!key) {
    console.error("RAGNAPLACE_API_KEY is not set (environment or ./.env).");
    console.error("Request a key at https://ragnaplace.com/api — keys start pending until an admin approves them.");
    process.exit(1);
  }
  const gateway = args.gateway || DEFAULT_GATEWAY;

  // Candidate ids: the client's list, plus whatever the current output already
  // knows about (an id the client stops shipping shouldn't drop out silently).
  const idFile = JSON.parse(readFileSync(resolve(args.ids), "utf8"));
  const candidates = new Set((idFile.mobs || []).map((m) => m.id));
  const fromClient = candidates.size;
  let carried = 0;
  if (existsSync(outPath)) {
    for (const m of JSON.parse(readFileSync(outPath, "utf8"))) {
      if (!candidates.has(m.id)) { candidates.add(m.id); carried++; }
    }
  }

  // Resume: replay whatever a previous run already paid for. It holds the *raw*
  // API record rather than the projection, so editing toRecord()/isMvp() mid-run
  // still applies to ids already fetched.
  const done = new Map(); // id -> raw Mob | null (null = confirmed not a monster)
  if (args.fresh) rmSync(partialPath, { force: true });
  else if (existsSync(partialPath)) {
    for (const line of readFileSync(partialPath, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const { id, mob } = JSON.parse(line);
        done.set(id, mob);
      } catch { /* truncated final line from an interrupted write */ }
    }
  }

  const todo = [...candidates].sort((a, b) => a - b).filter((id) => !done.has(id));
  console.error(
    `gateway ${gateway} → ${outPath}\n` +
      `  candidates: ${candidates.size} (${fromClient} from the client, ${carried} carried from the existing file)\n` +
      `  already fetched: ${done.size}, to fetch: ${todo.length}, concurrency ${concurrency}`,
  );

  const gate = new RateGate();
  let fetched = 0;
  let missing = 0;
  let next = 0;
  const started = Date.now();

  async function worker() {
    while (next < todo.length) {
      const id = todo[next++];
      const mob = await fetchMob(gateway, id, key, gate);
      done.set(id, mob);
      appendFileSync(partialPath, `${JSON.stringify({ id, mob })}\n`);
      if (mob) fetched++; else missing++;
      const seen = fetched + missing;
      if (seen % 200 === 0 || seen === todo.length) {
        const secs = Math.round((Date.now() - started) / 1000);
        console.error(`  ${seen}/${todo.length} — ${fetched} monsters, ${missing} not monsters (${secs}s)`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

  const records = [...done.values()].filter(Boolean).map(toRecord).sort((a, b) => a.id - b.id);
  if (!records.length) {
    console.error("! no monsters resolved — refusing to overwrite the output file");
    process.exit(1);
  }
  // Before the write, so a cross-check failure leaves both the previous
  // mobs.json and the resume file intact — the API quota is not lost.
  const dpStats = dp ? mergeDp(records, dp, args.allowPartialDp) : null;

  writeFileSync(outPath, `${JSON.stringify(records, null, 2)}\n`);
  rmSync(partialPath, { force: true });

  const mvps = records.filter((r) => r.mvp).length;
  const bosses = records.filter((r) => r.boss).length;
  const holes = records.filter((r) => r.hp == null || r.level == null).length;
  // How many `boss` flags came from folding in `mvp` rather than from upstream —
  // i.e. instance MVPs whose `class` the API leaves null. Counted off the raw
  // records, since `boss` in the projection already includes them.
  const classFilledIn = [...done.values()].filter((m) => m && m.class !== "Boss" && isMvp(m)).length;
  console.error(
    `\nwrote ${records.length} monsters to ${outPath}\n` +
      `  ${bosses} boss-class, ${mvps} MVP (${classFilledIn} boss flags filled in from mvp — null upstream class)\n` +
      `  ${holes} with a null hp/level (upstream gaps)\n` +
      `  ${done.size - records.length} candidate ids were not monsters`,
  );
  if (dpStats) {
    console.error(`  ${describeDpMerge(records, dpStats)}`);
  } else {
    console.error(`  res/mres: null on all ${records.length} (--no-dp)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
