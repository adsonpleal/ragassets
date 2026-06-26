// Incremental, tiered resolver.  mobs.json is the source of truth.
//   1. reconcile existing entries against the current client CSV (keep valid, drop stale)
//   2. resolve still-unmapped rows by certainty:  navi token -> ordered-fill -> grouped/shadow
//   3. write the updated mobs.json + unresolved.json (rows that need the agent stage)
//
// Usage:  node tools/mobnames/resolve.mjs            (writes mobs.json, prints report)
//         node tools/mobnames/resolve.mjs --dry      (report only, no write)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve as rpath } from "node:path";
import { REPO, extractCsv, extractNavi, extractNpcIdentity, aegisKey, norm } from "./lib.mjs";

const MOBS = rpath(REPO, "mobs.json");
const UNRESOLVED = rpath(REPO, "tools/mobnames/unresolved.json");
const dry = process.argv.includes("--dry");

const csv = extractCsv();
const navi = extractNavi();                       // AEGIS -> strId
const { id2aegis, aegis2id } = extractNpcIdentity();
const allMon = [...id2aegis.keys()].filter(id => id >= 1000 && id < 40000).sort((a, b) => a - b);
const csvByStrId = new Map(csv.map(r => [r.strId, r]));

// invert navi: strId -> jobID  (the exact static bridge)
const naviStrToJob = new Map();
for (const [aegis, strId] of navi) { const id = aegis2id.get(aegis); if (id != null && !naviStrToJob.has(strId)) naviStrToJob.set(strId, id); }

// --- load existing mobs.json (source of truth) ---
const existing = existsSync(MOBS) ? JSON.parse(readFileSync(MOBS, "utf8")) : {};

// --- step 1: reconcile. keep entries whose strId still maps to the same EN; refresh pt/es. ---
const mobs = {};               // jobID -> entry
const claimedStr = new Set();  // strIds already assigned
let kept = 0, stale = 0, refreshed = 0;
for (const [jobId, e] of Object.entries(existing)) {
  const row = csvByStrId.get(e.strId);
  if (row && norm(row.en) === norm(e.en)) {
    const ne = { ...e, pt: row.pt, es: row.es };
    if (ne.pt !== e.pt || ne.es !== e.es) refreshed++;
    mobs[jobId] = ne; claimedStr.add(e.strId); kept++;
  } else stale++;  // strId reassigned by a client update -> drop, re-resolve below
}
const usedJob = new Set(Object.keys(mobs).map(Number));
const allRowStrIds = csv.map(r => r.strId).sort((a, b) => a - b);

function put(strId, jobId, source, conf) {
  const r = csvByStrId.get(strId);
  mobs[jobId] = { en: r.en, pt: r.pt, es: r.es, aegis: id2aegis.get(jobId), strId, source, confidence: conf };
  claimedStr.add(strId); usedJob.add(jobId);
}
const unusedHas = id => !usedJob.has(id);

// --- TIER 1: navi token (exact, game-file) ---
let t1 = 0;
for (const r of csv) { if (claimedStr.has(r.strId)) continue; const j = naviStrToJob.get(r.strId); if (j != null && unusedHas(j)) { put(r.strId, j, "navi", "exact"); t1++; } }

// --- TIER 2: ordered-fill between claimed anchors (by strId<->jobID), exact-count gaps ---
let t2 = 0;
const railList = Object.entries(mobs).map(([j, e]) => ({ s: e.strId, j: Number(j) })).sort((a, b) => a.s - b.s);
for (let i = 0; i + 1 < railList.length; i++) {
  const A = railList[i], B = railList[i + 1];
  const gap = allRowStrIds.filter(s => s > A.s && s < B.s && !claimedStr.has(s));
  const cand = allMon.filter(id => id > A.j && id < B.j && unusedHas(id));
  if (gap.length && gap.length === cand.length) for (let k = 0; k < gap.length; k++) { put(gap[k], cand[k], "fill", "high"); t2++; }
}

// --- TIER 3a: grouped-variant fill (N same-name rows <-> N same-aegisKey unused jobIDs, in order) ---
let t3 = 0;
const byName = new Map();
for (const r of csv) { if (claimedStr.has(r.strId)) continue; const k = norm(r.en); if (k.length < 3) continue; (byName.get(k) ?? byName.set(k, []).get(k)).push(r); }
for (const [k, rows] of byName) {
  const cand = allMon.filter(id => unusedHas(id) && aegisKey(id2aegis.get(id)) === k).sort((a, b) => a - b);
  if (cand.length && cand.length === rows.length) { rows.sort((a, b) => a.strId - b.strId); rows.forEach((r, i) => { put(r.strId, cand[i], "group", "med"); t3++; }); }
}

// --- TIER 3b: shadow — un-rowed jobIDs whose aegisKey equals an assigned row EN share that name ---
let t3b = 0;
const byEn = new Map(); for (const e of Object.values(mobs)) if (!byEn.has(norm(e.en))) byEn.set(norm(e.en), e);
for (const id of allMon) {
  if (usedJob.has(id)) continue;
  const m = byEn.get(aegisKey(id2aegis.get(id)));
  if (m && aegisKey(id2aegis.get(id)).length >= 4) { mobs[id] = { en: m.en, pt: m.pt, es: m.es, aegis: id2aegis.get(id), strId: m.strId, source: "shadow", confidence: "low" }; usedJob.add(id); t3b++; }
}

// --- residual: rows still unclaimed -> agent stage ---
const unresolved = csv.filter(r => !claimedStr.has(r.strId)).map(r => ({
  strId: r.strId, en: r.en, pt: r.pt, es: r.es,
  candidates: allMon.filter(id => {
    if (!unusedHas(id)) return false;
    const ak = aegisKey(id2aegis.get(id));
    return ak.length >= 3 && (norm(r.en).includes(ak) || norm(r.pt).includes(ak) || ak.includes(norm(r.en)));
  }).map(id => ({ jobID: id, aegis: id2aegis.get(id) })).slice(0, 40),
}));

// --- validate navi integrity (no entry may contradict a navi anchor) ---
let broken = 0;
for (const [s, j] of naviStrToJob) { const e = mobs[j]; if (e && e.strId !== s) broken++; }

console.log("=== mob-name resolve ===");
console.log(`CSV rows: ${csv.length} | navi anchors: ${naviStrToJob.size} | client mob ids: ${allMon.length}`);
console.log(`reconcile: kept ${kept} (refreshed pt/es ${refreshed}), dropped stale ${stale}`);
console.log(`tier1 navi(exact): +${t1}  tier2 fill(high): +${t2}  tier3 group(med): +${t3}  shadow(low): +${t3b}`);
console.log(`resolved total: ${Object.keys(mobs).length} jobIDs, ${claimedStr.size}/${csv.length} rows`);
console.log(`UNRESOLVED rows -> agents: ${unresolved.length}`);
console.log(`navi integrity broken: ${broken} (must be 0)`);
if (broken) { console.error("ABORT: navi integrity broken — not writing."); process.exit(1); }

if (!dry) {
  const ordered = {}; for (const id of Object.keys(mobs).map(Number).sort((a, b) => a - b)) ordered[id] = mobs[id];
  writeFileSync(MOBS, JSON.stringify(ordered, null, 1));
  writeFileSync(UNRESOLVED, JSON.stringify(unresolved, null, 1));
  console.log(`\nwrote mobs.json (${Object.keys(ordered).length}) and tools/mobnames/unresolved.json (${unresolved.length})`);
} else console.log("\n--dry: nothing written");
