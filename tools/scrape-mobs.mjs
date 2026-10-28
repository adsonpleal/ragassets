#!/usr/bin/env node
// Rebuild resources/raw/mobs.json (monster stats) from the RagnaPlace Public API.
//
//   node tools/scrape-mobs.mjs --ids mobids.json
//   node tools/scrape-mobs.mjs --ids mobids.json --no-langs   # pt-BR only
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

// ## The other two locales
//
// The server runs in three locales and so does this file: mobs.json stays pt-BR
// and mobs_en.json / mobs_es.json are published beside it, exactly as
// extract-grf.mjs --raw publishes the client's tables. Nothing that already
// fetches /raw/mobs.json changes.
//
// The client is not the source. It ships no monster-name table in any locale:
// the only monster file under data/english/ and data/spanish/ is
// adventureguide/guide_monster.lub, and all three copies are byte-identical
// apart from the compile-time path in the header — it holds ids, no strings.
// npcidentity.lub is id -> JT_ constant and jobname.lub is sprite folders. RO
// sends monster names from the server, which is why this file is scraped at all.
//
// So the locales come from the same place the pt-BR name does: RagnaPlace serves
// the LATAM server under one gateway per locale (laro-pt / laro-es / laro-en),
// and the *same id* in another gateway is the same monster with its name in that
// language. Association is by id, never by matching text.
//
// A locale's file is the pt-BR records with `name` replaced, so every locale is
// indexable by the pt-BR table's ids and the numbers cannot drift between them —
// only the text differs. Where a locale has no name for an id, the pt-BR wording
// is kept rather than the row vanishing. See localizeRecords().

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
    else if (a === "--no-langs") out.noLangs = true;
    else if (a === "--langs-only") out.langsOnly = true;
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
      "                             [--no-langs | --langs-only]",
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
      `  --no-langs  write only the pt-BR file, not the ${MOB_LANGS.map((l) => `_${l}`).join("/")} copies beside it.`,
      "            Those then keep the previous run's wording and miss any new",
      "            monster, so use it only when you are coming back to finish them.",
      "  --langs-only  leave the pt-BR file alone and (re)build only the locale",
      "            files from it. What --no-langs leaves to come back to, and the",
      "            way a locale is added or repaired without re-scraping pt-BR.",
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

function requireApiKey() {
  const key = readApiKey();
  if (!key) {
    console.error("RAGNAPLACE_API_KEY is not set (environment or ./.env).");
    console.error("Request a key at https://ragnaplace.com/api — keys start pending until an admin approves them.");
    process.exit(1);
  }
  return key;
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

// The fetch protocol every pass shares: replay whatever an interrupted run
// already paid for, fan out over the rest against one rate budget, and append
// each result the moment it lands so nothing is ever re-bought.
//
// `fetchOne(id)` returns the value to keep. `null` is a real value — the id is
// not a monster, or the locale has no name for it — and is recorded so a resume
// does not re-fetch it. `field` is the key it is stored under in the .jsonl,
// which is part of that file's documented shape: the pt-BR pass's `mob` records
// are what the update-mob-stats skill's post-client-update recipe reads back.
//
// Deleting the resume file is deliberately **not** done here. Every caller has
// work left that can still fail — the divine-pride cross-check, a locale's
// thresholds — and the whole point of the file is that such a failure costs no
// quota. Callers drop it once their output is on disk.
//
// Returns the id -> value Map, replayed entries included.
async function fetchAll({ ids, partialPath, field, fresh, concurrency, fetchOne, label, every, progress }) {
  const done = new Map();
  if (fresh) rmSync(partialPath, { force: true });
  else if (existsSync(partialPath)) {
    for (const line of readFileSync(partialPath, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        done.set(rec.id, rec[field]);
      } catch { /* truncated final line from an interrupted write */ }
    }
  }

  const todo = ids.filter((id) => !done.has(id));
  console.error(
    `\n${label}\n` +
      `  ${ids.length} ids, already fetched: ${done.size}, to fetch: ${todo.length}, concurrency ${concurrency}`,
  );

  let next = 0;
  let seen = 0;
  const started = Date.now();
  async function worker() {
    while (next < todo.length) {
      const id = todo[next++];
      const value = await fetchOne(id);
      done.set(id, value);
      appendFileSync(partialPath, `${JSON.stringify({ id, [field]: value })}\n`);
      if (++seen % every === 0 || seen === todo.length) {
        const secs = Math.round((Date.now() - started) / 1000);
        console.error(`  ${seen}/${todo.length}${progress ? ` — ${progress()}` : ""} (${secs}s)`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

  return done;
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

// ---------------------------------------------------------------------------
// The other two locales
// ---------------------------------------------------------------------------

// The locales published beside the pt-BR file. The same two extract-grf.mjs
// --raw writes, and a file's suffix is spelled the same way there — the test
// asserts this list and its suffixes still agree with that module's RAW_LANGS,
// because nothing downstream would notice them drifting: the gateway's /raw
// route matches any lowercase name, so a misspelled locale is served happily
// and fetched by nobody.
export const MOB_LANGS = ["en", "es"];

// RagnaPlace serves one gateway per locale of the same server, named
// <family>-<lang> — laro-pt, laro-es, laro-en (and rola-pt/-es/-en for
// Landverse). The locale's gateway is therefore the base one with its trailing
// language swapped. That is the third party's convention, not ours, so this
// only *proposes* a slug; checkLangGateways confirms it against the API's own
// list before any quota is spent on it. A base slug with no trailing language
// has no sibling to derive, and guessing one would scrape another server.
export function langGateway(base, lang) {
  if (!/-[a-z]{2}$/.test(base)) return null;
  return base.replace(/-[a-z]{2}$/, `-${lang}`);
}

// mobs.json -> mobs_es.json, beside it.
export function langOutPath(outPath, lang) {
  return outPath.replace(/(\.json)?$/, `_${lang}$1`);
}

// A last sanity check on the published file, after checkLangGateways has already
// established the gateway is the right one. They catch a locale that is real but
// is not what it claims — a gateway serving a different catalogue (everything
// falls back, so the file is Portuguese under an _es name), or one that answers
// with the pt-BR wording for everything. Measured 2026-10-27 across all 2,732
// monsters: 2 missing in en and 4 in es, and 79% of en names and 75% of es
// names differ from pt-BR. Both floors sit far below that, because genuinely
// shared names (Poring, Argiope, Marse) are normal and not a fault.
const MAX_MISSING = 0.05;
const MIN_TRANSLATED = 0.25;

// One locale's file: the pt-BR records with `name` replaced. Everything else —
// the stats, res/mres, the boss/mvp flags — is copied rather than re-read from
// the locale's gateway, so a locale can only ever differ from pt-BR in its text
// and every locale stays indexable by the pt-BR table's ids.
//
// `names` is id -> that locale's name. An id it has no entry for, or an entry
// that is blank, keeps the pt-BR wording: a row that vanished would break the
// indexable-by-pt-BR-ids contract, and an empty string is worse than Portuguese.
export function localizeRecords(ptbr, names) {
  let translated = 0;
  let same = 0;
  let missing = 0;
  const records = ptbr.map((r) => {
    const name = names.get(r.id);
    if (!name || !String(name).trim()) {
      missing++;
      return { ...r };
    }
    if (name === r.name) same++;
    else translated++;
    return { ...r, name };
  });
  // No `total`: it is translated + same + missing by construction, and a fourth
  // number is a fourth thing that can disagree with the other three.
  return { records, stats: { translated, same, missing } };
}

// Reports why a locale is unpublishable, or null when it is fine. Split out from
// localizeRecords so the thresholds can be tested without a gateway.
export function checkLocale(lang, { translated, same, missing }) {
  const total = translated + same + missing;
  if (missing > total * MAX_MISSING) {
    return (
      `${lang}: ${missing} of ${total} monsters have no name in that locale ` +
      `(over ${Math.round(MAX_MISSING * 100)}%). Those fall back to the pt-BR wording, so the ` +
      `file would be largely Portuguese under an _${lang} name.`
    );
  }
  const named = translated + same;
  if (named && translated < named * MIN_TRANSLATED) {
    return (
      `${lang}: only ${translated} of ${named} names differ from pt-BR ` +
      `(under ${Math.round(MIN_TRANSLATED * 100)}%). A locale gateway that returns the pt-BR ` +
      `wording for everything is the pt-BR gateway.`
    );
  }
  return null;
}

// Writes one locale's file next to the pt-BR one, and accounts for it.
function writeLocale(lang, outPath, ptbr, names) {
  const { records, stats } = localizeRecords(ptbr, names);
  const problem = checkLocale(lang, stats);
  if (problem) {
    console.error(`\n! ${problem}\n  Nothing was written for this locale.`);
    process.exit(1);
  }
  const path = langOutPath(outPath, lang);
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
  console.error(
    `  ${path}: ${records.length} monsters — ${stats.translated} translated, ` +
      `${stats.same} the same word as pt-BR, ${stats.missing} fell back to pt-BR`,
  );
}

// Publishes every locale beside the pt-BR file. `getNames(lang)` supplies that
// locale's { names } — fetched from its gateway or read back from the file it
// already wrote — plus an optional `settled` to call once the file is on disk;
// null means that locale has no file to rebuild from. The three callers differ
// in nothing but that.
async function publishLocales(langs, outPath, ptbr, getNames) {
  for (const lang of langs) {
    const got = await getNames(lang);
    if (!got) {
      console.error(`  ${langOutPath(outPath, lang)}: not written yet — \`--langs-only\` creates it`);
      continue;
    }
    writeLocale(lang, outPath, ptbr, got.names);
    // Only now. writeLocale exits on a threshold, and the resume file is what
    // keeps that from costing the locale's whole 2,732 requests.
    got.settled?.();
  }
}

// Fetches one locale's names for exactly the ids the pt-BR records carry.
//
// Those ids, and not the candidate list, because the pt-BR pass has already
// settled which of the ~4,600 candidates are monsters — re-probing the ~1,900
// that are not would spend a third of the quota per locale on 404s, and the row
// set has to match pt-BR's anyway.
//
// Only `name` is kept. `sprite` is read to assert the gateway serves the same
// monster under that id; hp/level are deliberately not compared, because they
// are not published here (the pt-BR numbers are) and a locale lagging a balance
// patch would fail a run over a field nothing reads.
async function fetchLocaleNames(lang, gateway, ptbr, key, outPath, { gate, concurrency, fresh }) {
  const byId = new Map(ptbr.map((r) => [r.id, r.aegisId]));
  const partialPath = `${langOutPath(outPath, lang)}.partial.jsonl`;
  const mismatched = [];

  const names = await fetchAll({
    ids: ptbr.map((r) => r.id),
    partialPath,
    field: "name",
    label: `${lang}: gateway ${gateway}`,
    every: 500,
    concurrency,
    fresh,
    fetchOne: async (id) => {
      const mob = await fetchMob(gateway, id, key, gate);
      if (mob && mob.sprite !== byId.get(id)) {
        mismatched.push({ id, ptbr: byId.get(id), locale: mob.sprite });
      }
      // null is a real answer: the locale's gateway doesn't carry this monster.
      // Recorded as such so a resume doesn't re-fetch it, and so the fallback is
      // counted as missing rather than leaving a silent hole.
      return mob ? mob.name : null;
    },
  });

  if (mismatched.length) {
    console.error(
      `\n! ${mismatched.length} id(s) are a different monster on the ${lang} gateway than on pt-BR.\n` +
        `  The locale files are keyed by the pt-BR ids, so this would file one monster's\n` +
        `  name under another's. Nothing was written.\n`,
    );
    for (const m of mismatched.slice(0, 20)) {
      console.error(`    ${String(m.id).padStart(5)}  pt-BR ${m.ptbr}  ${lang} ${m.locale}`);
    }
    process.exit(1);
  }
  return { names, settled: () => rmSync(partialPath, { force: true }) };
}

// The names a locale's existing file already carries, for --merge-only: it
// refreshes res/mres without touching the API, and the locale files hold copies
// of those same numbers, so they go stale the moment mobs.json moves.
function readLocaleNames(outPath, lang) {
  const path = langOutPath(outPath, lang);
  if (!existsSync(path)) return null;
  return { names: new Map(JSON.parse(readFileSync(path, "utf8")).map((r) => [r.id, r.name])) };
}

// The locales to publish this run. Which locales, only — whether their gateways
// exist is checkLangGateways' job, and --merge-only must reach neither.
function resolveLangs(args) {
  return args.noLangs ? [] : MOB_LANGS;
}

// Confirms each locale's gateway is real before a single id is fetched against
// it. langGateway only proposes a slug from a naming convention; one request to
// the API's own list settles it, instead of letting a wrong slug be discovered
// 2,732 requests later by a threshold. Returns lang -> slug.
async function checkLangGateways(langs, base, key) {
  const slugs = new Map(langs.map((l) => [l, langGateway(base, l)]));
  const underivable = langs.filter((l) => !slugs.get(l));
  if (underivable.length) {
    console.error(
      `! --gateway ${base} has no trailing language, so its ${underivable.join("/")} sibling` +
        ` can't be derived.\n  Pass --no-langs, or a gateway named <family>-<lang> (laro-pt, rola-pt).`,
    );
    process.exit(1);
  }
  const res = await fetch(`${API_BASE}/v1/gateways`, { headers: { "x-api-key": key, accept: "application/json" } });
  if (!res.ok) {
    console.error(`! GET /v1/gateways → ${res.status}: can't confirm the locale gateways exist.`);
    process.exit(1);
  }
  const known = new Set((await res.json()).gateways.map((g) => g.slug));
  const unknown = langs.filter((l) => !known.has(slugs.get(l)));
  if (unknown.length) {
    console.error(
      `! ${unknown.map((l) => `${slugs.get(l)} (${l})`).join(", ")} is not a RagnaPlace gateway.\n` +
        `  /v1/gateways lists the real ones. Nothing was fetched.`,
    );
    process.exit(1);
  }
  return slugs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.ids && !args.mergeOnly && !args.langsOnly)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (args.mergeOnly && args.noDp) {
    console.error("--merge-only --no-dp would do nothing.");
    process.exit(1);
  }
  if (args.langsOnly && args.noLangs) {
    console.error("--langs-only --no-langs would do nothing.");
    process.exit(1);
  }
  if (args.langsOnly && args.mergeOnly) {
    console.error("--langs-only and --merge-only rebuild different files; run them one at a time.");
    process.exit(1);
  }

  const outPath = resolve(args.out ? args.out : resolve(REPO_ROOT, "resources/raw/mobs.json"));
  const partialPath = `${outPath}.partial.jsonl`;
  mkdirSync(dirname(outPath), { recursive: true });
  const concurrency = Number.isFinite(args.concurrency) && args.concurrency > 0 ? args.concurrency : 8;

  // Rebuilding the locale files from the pt-BR file already on disk. Its records
  // are the pt-BR projection with divine-pride already merged, and a locale file
  // is those records with one field replaced, so there is nothing for the base
  // pass or the crawl to contribute — only the names have to be fetched.
  if (args.langsOnly) {
    if (!existsSync(outPath)) {
      console.error(`! --langs-only needs an existing ${outPath}; run a full scrape first.`);
      process.exit(1);
    }
    const key = requireApiKey();
    const gateway = args.gateway || DEFAULT_GATEWAY;
    const langs = resolveLangs(args);
    const slugs = await checkLangGateways(langs, gateway, key);
    const gate = new RateGate();
    const concurrency = Number.isFinite(args.concurrency) && args.concurrency > 0 ? args.concurrency : 8;
    const ptbr = JSON.parse(readFileSync(outPath, "utf8"));
    console.error(`${outPath}: ${ptbr.length} monsters — the pt-BR file is read, not rewritten`);
    await publishLocales(langs, outPath, ptbr, (lang) =>
      fetchLocaleNames(lang, slugs.get(lang), ptbr, key, outPath, { gate, concurrency, fresh: args.fresh }),
    );
    return;
  }

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
    // The locale files carry the same numbers, so they go stale the moment this
    // one moves. Their names are already on disk, so re-deriving them costs no
    // API quota and no gateway — which is the whole point of --merge-only.
    await publishLocales(resolveLangs(args), outPath, existing, (lang) => readLocaleNames(outPath, lang));
    return;
  }

  const key = requireApiKey();
  const gateway = args.gateway || DEFAULT_GATEWAY;
  const gate = new RateGate(); // one budget for the whole run, every pass
  // Up front, with the divine-pride load: a locale whose gateway doesn't exist
  // should fail before the pt-BR pass spends an hour of quota, not after.
  const langs = resolveLangs(args);
  const langSlugs = langs.length ? await checkLangGateways(langs, gateway, key) : new Map();

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

  let fetched = 0;
  let missing = 0;
  // The resume file holds the *raw* API record rather than the projection, so
  // editing toRecord()/isMvp() mid-run still applies to ids already fetched.
  const done = await fetchAll({
    ids: [...candidates].sort((a, b) => a - b),
    partialPath,
    field: "mob", // id -> raw Mob | null (null = confirmed not a monster)
    label:
      `gateway ${gateway} → ${outPath}\n` +
      `  candidates: ${candidates.size} (${fromClient} from the client, ${carried} carried from the existing file)`,
    every: 200,
    concurrency,
    fresh: args.fresh,
    fetchOne: async (id) => {
      const mob = await fetchMob(gateway, id, key, gate);
      if (mob) fetched++; else missing++;
      return mob;
    },
    progress: () => `${fetched} monsters, ${missing} not monsters`,
  });

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

  // After the pt-BR file is on disk, so an interrupted locale pass leaves a
  // complete mobs.json behind. `--langs-only` then resumes from here without
  // re-buying the ~4,600-id pt-BR pass.
  if (langs.length) {
    // ~4,600 raw API records with their drop tables, tens of MB, and nothing
    // below reads them. The locale passes run for another ~14 minutes.
    done.clear();
    await publishLocales(langs, outPath, records, (lang) =>
      fetchLocaleNames(lang, langSlugs.get(lang), records, key, outPath, { gate, concurrency, fresh: args.fresh }),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
