// Divine Pride name fetcher (oracle for the agent stage). Cached + resumable + rate-limited.
//   node tools/mobnames/dp.mjs            # fetch DP names for the current UNUSED jobID pool
//   node tools/mobnames/dp.mjs --all      # fetch every client mob id (slow; DP throttles ~after 2.8k)
//   node tools/mobnames/dp.mjs 1039 20620 # fetch specific ids
// Key is read from the git-ignored .env (DIVINE_PRIDE_API_KEY). DP has no laRO Portuguese;
// it returns iRO English (Korean fallback for LATAM-exclusive) + dbname(=aegis) — used only to
// *confirm identity*, never as the displayed name (that always comes from the client CSV).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve as rpath } from "node:path";
import { REPO, extractNpcIdentity } from "./lib.mjs";

const env = Object.fromEntries(readFileSync(rpath(REPO, ".env"), "utf8").split(/\r?\n/).filter(l => l.includes("=") && !l.startsWith("#")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const KEY = env.DIVINE_PRIDE_API_KEY;
if (!KEY) { console.error("missing DIVINE_PRIDE_API_KEY in .env"); process.exit(1); }
const CACHE = rpath(REPO, "tools/mobnames/dp_cache.json");
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};

let ids;
const args = process.argv.slice(2);
const nums = args.filter(a => /^\d+$/.test(a)).map(Number);
if (nums.length) ids = nums;
else {
  const { id2aegis } = extractNpcIdentity();
  const all = [...id2aegis.keys()].filter(id => id >= 1000 && id < 40000).sort((a, b) => a - b);
  if (args.includes("--all")) ids = all;
  else { // default: the unused pool (jobIDs not yet in mobs.json)
    const mobs = JSON.parse(readFileSync(rpath(REPO, "mobs.json"), "utf8"));
    const used = new Set(Object.keys(mobs).map(Number));
    ids = all.filter(id => !used.has(id));
  }
}
const todo = ids.filter(id => !(id in cache));
console.log(`requested ${ids.length}, cached ${ids.length - todo.length}, fetching ${todo.length}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ok = 0, miss = 0, done = 0;
for (const id of todo) {
  let attempt = 0;
  while (attempt < 3) {
    try {
      const r = await fetch(`https://www.divine-pride.net/api/database/Monster/${id}?apiKey=${KEY}`, { headers: { "Accept-Language": "en-US" } });
      if (r.status === 404) { cache[id] = { id, missing: true }; miss++; break; }
      if (r.status === 429) { await sleep(2500); attempt++; continue; }
      if (!r.ok) { attempt++; await sleep(600); continue; }
      const j = await r.json();
      cache[id] = { id, name: j.name, dbname: j.dbname, sprite: j.sprite, level: j.stats?.level, hp: j.stats?.health }; ok++; break;
    } catch { attempt++; await sleep(600); }
  }
  if (!(id in cache)) { cache[id] = { id, error: true }; miss++; }
  if (++done % 25 === 0) { writeFileSync(CACHE, JSON.stringify(cache)); console.error(`  ${done}/${todo.length} (ok=${ok} miss=${miss})`); }
  await sleep(200);
}
writeFileSync(CACHE, JSON.stringify(cache));
console.log(`done. ok=${ok} miss=${miss}. cache=${Object.keys(cache).length}`);
