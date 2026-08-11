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

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
      "",
      "  --ids     candidate id list from `extract-grf.mjs --mobids` (required)",
      "  --out     output file (default: resources/raw/mobs.json)",
      "  --gateway RagnaPlace gateway slug (default: laro-pt)",
      "  --fresh   discard a leftover <out>.partial.jsonl and re-fetch every id",
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
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.ids) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const key = readApiKey();
  if (!key) {
    console.error("RAGNAPLACE_API_KEY is not set (environment or ./.env).");
    console.error("Request a key at https://ragnaplace.com/api — keys start pending until an admin approves them.");
    process.exit(1);
  }

  const gateway = args.gateway || DEFAULT_GATEWAY;
  const outPath = resolve(args.out ? args.out : resolve(REPO_ROOT, "resources/raw/mobs.json"));
  const partialPath = `${outPath}.partial.jsonl`;
  mkdirSync(dirname(outPath), { recursive: true });
  const concurrency = Number.isFinite(args.concurrency) && args.concurrency > 0 ? args.concurrency : 8;

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
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
