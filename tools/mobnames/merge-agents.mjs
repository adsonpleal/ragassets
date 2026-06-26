// Merge agent band answers back into mobs.json.
//   - only fills rows that are still unclaimed (never overrides navi/existing)
//   - refuses any assignment that would collide with a navi anchor or reuse a jobID
//   - re-validates navi integrity before writing
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve as rpath } from "node:path";
import { REPO, extractCsv, extractNavi, extractNpcIdentity } from "./lib.mjs";

const MOBS = rpath(REPO, "mobs.json");
const DIR = rpath(REPO, "tools/mobnames/agent-tasks");
const mobs = JSON.parse(readFileSync(MOBS, "utf8"));
const csv = extractCsv();
const csvByStrId = new Map(csv.map(r => [r.strId, r]));
const navi = extractNavi();
const { id2aegis, aegis2id } = extractNpcIdentity();
const naviStrToJob = new Map();
for (const [a, s] of navi) { const id = aegis2id.get(a); if (id != null && !naviStrToJob.has(s)) naviStrToJob.set(s, id); }

const claimedStr = new Set(Object.values(mobs).map(e => e.strId));
const usedJob = new Set(Object.keys(mobs).map(Number));

let applied = 0, skipNull = 0, skipUsed = 0, skipClaimed = 0, skipNavi = 0;
const answers = existsSync(DIR) ? readdirSync(DIR).filter(f => /\.answer\.json$/.test(f)) : [];
for (const f of answers) {
  let arr; try { arr = JSON.parse(readFileSync(rpath(DIR, f), "utf8")); } catch { continue; }
  for (const a of arr) {
    if (a.jobID == null) { skipNull++; continue; }
    if (claimedStr.has(a.strId)) { skipClaimed++; continue; }
    if (usedJob.has(a.jobID)) { skipUsed++; continue; }
    // a navi anchor for this strId fixes its jobID — never let an agent override it
    if (naviStrToJob.has(a.strId) && naviStrToJob.get(a.strId) !== a.jobID) { skipNavi++; continue; }
    const r = csvByStrId.get(a.strId); if (!r) continue;
    mobs[a.jobID] = { en: r.en, pt: r.pt, es: r.es, aegis: id2aegis.get(a.jobID), strId: a.strId, source: "agent", confidence: a.confidence || "med" };
    claimedStr.add(a.strId); usedJob.add(a.jobID); applied++;
  }
}

// validate
let broken = 0; for (const [s, j] of naviStrToJob) { const e = mobs[j]; if (e && e.strId !== s) broken++; }
console.log(`agent answer files: ${answers.length}`);
console.log(`applied ${applied}; skipped: null ${skipNull}, row-already-claimed ${skipClaimed}, jobID-already-used ${skipUsed}, navi-conflict ${skipNavi}`);
console.log(`mobs.json now: ${Object.keys(mobs).length} jobIDs, ${claimedStr.size}/${csv.length} rows`);
console.log(`navi integrity broken: ${broken} (must be 0)`);
if (broken) { console.error("ABORT: navi integrity broken — not writing."); process.exit(1); }
const ordered = {}; for (const id of Object.keys(mobs).map(Number).sort((a, b) => a - b)) ordered[id] = mobs[id];
writeFileSync(MOBS, JSON.stringify(ordered, null, 1));
console.log("wrote mobs.json");
