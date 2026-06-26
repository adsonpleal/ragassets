// Audit mobs.json: coverage, confidence mix, navi integrity, ground-truth spot check.
import { readFileSync } from "node:fs";
import { resolve as rpath } from "node:path";
import { REPO, extractCsv, extractNavi, extractNpcIdentity, norm } from "./lib.mjs";

const mobs = JSON.parse(readFileSync(rpath(REPO, "mobs.json"), "utf8"));
const csv = extractCsv();
const navi = extractNavi();
const { aegis2id } = extractNpcIdentity();
const naviStrToJob = new Map(); for (const [a, s] of navi) { const id = aegis2id.get(a); if (id != null && !naviStrToJob.has(s)) naviStrToJob.set(s, id); }

const usedStr = new Set(Object.values(mobs).map(e => e.strId));
const rows = csv.filter(r => usedStr.has(r.strId)).length;
const conf = {}, src = {};
for (const e of Object.values(mobs)) { conf[e.confidence] = (conf[e.confidence] || 0) + 1; src[e.source] = (src[e.source] || 0) + 1; }
let broken = 0; for (const [s, j] of naviStrToJob) { const e = mobs[j]; if (e && e.strId !== s) broken++; }

console.log(`mobs.json: ${Object.keys(mobs).length} jobIDs | rows covered ${rows}/${csv.length} (${(100 * rows / csv.length).toFixed(1)}%)`);
console.log(`by confidence: ${JSON.stringify(conf)}`);
console.log(`by source: ${JSON.stringify(src)}`);
console.log(`navi integrity broken: ${broken} (must be 0)`);

const GT = { 1001: ["Scorpion", "Escorpião"], 1002: ["Poring", "Poring"], 1003: ["Thief Bug Egg", "Ovo de Besouro-Ladrão"], 1004: ["Hornet", "Zangão"], 1025: ["Boa", "Jiboia"], 1038: ["Osiris", "Osíris"], 1039: ["Baphomet", "Bafomé"], 20620: ["Red Pepper", "Pimentinha"], 20621: ["Red Pepper", "Pimentão"] };
let g = 0; const fails = [];
for (const [id, [en, pt]] of Object.entries(GT)) { const m = mobs[id]; const ok = m && m.en === en && norm(m.pt) === norm(pt); if (ok) g++; else fails.push(`${id}: ${m ? `${m.en}/${m.pt}` : "MISSING"} (want ${en}/${pt})`); }
console.log(`ground truth: ${g}/${Object.keys(GT).length}` + (fails.length ? "  FAILS: " + fails.join(" ; ") : " ✓"));
process.exit(broken ? 1 : 0);
