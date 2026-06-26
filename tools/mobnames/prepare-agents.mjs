// Turn unresolved.json into agent task files: one shared unused-jobID pool + N row bands.
// The skill then spawns one agent per band; each writes agent-tasks/band<N>.answer.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve as rpath } from "node:path";
import { REPO, extractNpcIdentity } from "./lib.mjs";

const DIR = rpath(REPO, "tools/mobnames/agent-tasks");
mkdirSync(DIR, { recursive: true });
const unresolved = JSON.parse(readFileSync(rpath(REPO, "tools/mobnames/unresolved.json"), "utf8"));
const mobs = JSON.parse(readFileSync(rpath(REPO, "mobs.json"), "utf8"));
const dpPath = rpath(REPO, "tools/mobnames/dp_cache.json");
const dp = existsSync(dpPath) ? JSON.parse(readFileSync(dpPath, "utf8")) : {};
const { id2aegis } = extractNpcIdentity();

const used = new Set(Object.keys(mobs).map(Number));
const unused = [...id2aegis.keys()].filter(id => id >= 1000 && id < 40000 && !used.has(id)).sort((a, b) => a - b);
const dn = id => { const o = dp[id]; return o && o.name && !o.missing ? o.name : ""; };
writeFileSync(rpath(DIR, "pool.txt"), unused.map(id => `jobID ${id} aegis=${id2aegis.get(id)}${dn(id) ? ` dp="${dn(id)}"` : ""}`).join("\n"));

const PER = Number(process.env.BAND_SIZE || 140);
const bands = Math.max(1, Math.ceil(unresolved.length / PER));
const rows = unresolved.slice().sort((a, b) => a.strId - b.strId);
for (let b = 0; b < bands; b++) {
  const slice = rows.slice(b * PER, (b + 1) * PER);
  if (!slice.length) continue;
  const lines = slice.map(r => `strId ${r.strId} | EN="${r.en}" | PT="${r.pt}" | ES="${r.es}" | hint:[${(r.candidates || []).map(c => `${c.jobID}:${c.aegis}`).join(", ")}]`);
  writeFileSync(rpath(DIR, `band${b + 1}.txt`), lines.join("\n"));
}
writeFileSync(rpath(DIR, "manifest.json"), JSON.stringify({ bands, rows: unresolved.length, poolSize: unused.length }, null, 1));
console.log(`unresolved rows: ${unresolved.length} -> ${bands} band file(s) of <=${PER}`);
console.log(`unused-jobID pool: ${unused.length}  (agent-tasks/pool.txt)`);
console.log(`DP names available for pool: ${unused.filter(id => dn(id)).length}`);
console.log(`bands: ${[...Array(bands)].map((_, i) => `band${i + 1}.txt`).join(", ")}`);
