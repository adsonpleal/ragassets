#!/usr/bin/env node
// gen-effect-tables.mjs — regenerate the skill/effect lookup tables the
// /effect/skill-map and /effect/table endpoints serve.
//
// SOURCE: roBrowserLegacy (https://github.com/MrAntares/roBrowserLegacy), the
// actively-maintained roBrowser fork, whose plain-data modules cover ~1000 skills
// (vs. the ~63 in the original vthibault/roBrowser SkillEffect this used to port):
//
//   src/DB/Skills/SkillConst.js   skill-name const  -> numeric skill id
//   src/DB/Skills/SkillEffect.js  skill id          -> { effectId?, hitEffectId?, groundEffectId?, ... }
//   src/DB/Effects/EffectTable.js effect id         -> [ { type, file, min, wav, attachedEntity, rand, ... } ]
//
// Why roBrowserLegacy and not the client's own lua?  The task's premise was that
// the client's data/luafiles514/.../skilleffectinfo/skilleffectinfolist.lub is the
// authoritative full table.  It is not: that .lub is a *scripted-override* table
// for ~66 special skills (all KO_* / Kagerou-Oboro, which need custom LaunchZC_*
// registration); every other skill's visual is hardcoded in the packed client EXE,
// not in lua.  roBrowserLegacy's SkillEffect is the community's reconstruction of
// that hardcoded mapping in exactly this endpoint's JSON contract, so it is both
// far broader and directly usable.  (The .lub was decoded and cross-checked; it
// adds nothing over Legacy's coverage.)
//
// NUMBERING: the effect-id space shifted between old roBrowser and Legacy (e.g.
// old EF #249 = twohand, Legacy #249 = shield-boomerang; ~130 of 318 ids differ).
// SkillEffect ids only mean anything against the EffectTable from the *same*
// source, so BOTH files here come from Legacy — one consistent universe.  Skill
// ids themselves (SkillConst) are the AEGIS/server ids the client sends in the
// ZC_USESKILL* packets, which the replay viewer queries by; they match rAthena and
// the client SKID for the classic range (verified: SM_BASH=5, WZ_STORMGUST=89).
//
// These are ES modules (import .. / export default ..); we strip the imports,
// stub the runtime deps (renderer classes etc., only referenced inside procedural
// FUNC callbacks we drop anyway), turn `export default` into a return, and run the
// body in a Function sandbox so the returned data object falls out.  SkillEffect's
// SkillConst import is bound to the real SK map so SkillEffect[SK.NAME] keys resolve
// to numeric skill ids.
//
// The contract is single numeric ids per field; roBrowserLegacy sometimes uses
// arrays (multi-effect), named-string effects ('quake_magnum', 'ef_anklesnare'),
// or one job-conditional function.  fold() keeps the first numeric of each contract
// field and drops non-numeric ones (the endpoint's effect_table is numeric-keyed,
// so a named/function effect isn't servable anyway).  effectId also absorbs
// on-caster/on-success variants so buff skills (whose only effect is a successEffect)
// still render — matching how the original table collapsed them into effectId.
//
// CLASSIC_OVERRIDES restores the handful of long-mapped classic skills whose entry
// Legacy's SkillEffect happens to drop, but whose effect its EffectTable still
// defines at the same id — so pre-existing coverage never regresses.  Each is
// asserted at build time to resolve to a STR part.
//
// Usage:
//   node tools/gen-effect-tables.mjs [--src <dir>] [--out <dir>]
// With no --src the roBrowserLegacy sources are fetched from GitHub (master); with
// --src <dir> they are read from that directory (files by basename).  --out defaults
// to gateway/internal/effect/data.
//
// This is a manual maintenance step (like cmd/gen-resolver): re-run only when the
// upstream roBrowserLegacy tables change.  The committed JSON is the source of truth
// for the running gateway.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://raw.githubusercontent.com/MrAntares/roBrowserLegacy/master";
const FILES = {
  SkillConst: "src/DB/Skills/SkillConst.js",
  SkillEffect: "src/DB/Skills/SkillEffect.js",
  EffectTable: "src/DB/Effects/EffectTable.js",
};

// Skills whose roBrowserLegacy SkillEffect entry is empty/flag-only, but whose
// effect its EffectTable still defines — so we point the skill at that effect id
// directly. Restores coverage that would otherwise silently vanish. Each id is
// validated to resolve to a STR part below (build fails otherwise).
//   12   MG_SAFETYWALL      -> 315 safetywall   (classic, Legacy dropped it)
//   57   KN_BRANDISHSPEAR   -> 144 brandish2    (classic, Legacy dropped it)
//   61   KN_AUTOCOUNTER     -> 131 autocounter  (classic, Legacy dropped it)
//   2214 WL_CHAINLIGHTNING  -> 734 chainlight   (cast id is empty in Legacy; 734 is
//                                                the effect its _ATK twin uses)
const CLASSIC_OVERRIDES = {
  12: { effectId: 315 },
  57: { effectId: 144 },
  61: { effectId: 131 },
  2214: { effectId: 734 },
};

function parseArgs(argv) {
  const a = { src: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--src") a.src = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") a.help = true;
  }
  return a;
}

async function loadSource(name, srcDir) {
  if (srcDir) return readFileSync(join(srcDir, FILES[name].split("/").pop()), "utf8");
  const url = `${REPO}/${FILES[name]}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  return await res.text();
}

// A callable, self-returning stub for any roBrowserLegacy dependency a module
// imports (renderer classes, managers, DB helpers). They are only referenced from
// inside procedural FUNC callbacks — which we drop — so the stub is never invoked
// to produce table data.
const STUB = new Proxy(function () {}, {
  get: () => STUB,
  apply: () => STUB,
  construct: () => STUB,
});

// evalModule runs an ES-module data file (`export default <expr>`) and returns the
// exported value. It strips `import ... from '...'` statements, declares each
// imported binding (STUB unless overridden by `overrides[localName]`), rewrites
// `export default` to a return, drops any other `export ` keyword, and evaluates
// the result in a Function sandbox.
function evalModule(src, overrides = {}) {
  const names = new Set();
  const IMPORT = /import\s+([^;]+?)\s+from\s+['"][^'"]+['"];?/gs;
  src.replace(IMPORT, (_, clause) => {
    clause = clause.trim();
    let m;
    if ((m = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)/))) {
      names.add(m[1]);
    } else {
      const def = clause.match(/^([A-Za-z_$][\w$]*)/);
      if (def && !clause.startsWith("{")) names.add(def[1]);
      const braces = clause.match(/\{([^}]*)\}/);
      if (braces)
        braces[1].split(",").forEach((p) => {
          p = p.trim();
          if (!p) return;
          const as = p.split(/\s+as\s+/);
          names.add((as[1] || as[0]).trim());
        });
    }
    return "";
  });
  let body = src
    .replace(IMPORT, "")
    .replace(/export\s+default\s+/, "return ")
    .replace(/^\s*export\s+/gm, "");
  const params = [...names];
  const args = params.map((n) => (overrides[n] !== undefined ? overrides[n] : STUB));
  // eslint-disable-next-line no-new-func
  const run = new Function(...params, "__stub__", body);
  return run(...args, STUB);
}

// Flag FUNC parts and drop unserializable callbacks. roBrowserLegacy marks a part
// procedural either with type:'FUNC' or by giving it a render/init/func callback; we
// normalize to type:'FUNC' so the client can tell served (STR/SPR) parts from ones
// it must render itself. All function values are dropped (not serializable, not ours
// to run); non-STR types (2D/3D/CYLINDER/SPR/RSM/...) are kept as-is and the client
// skips them.
function cleanEffectTable(table) {
  const out = {};
  for (const [id, parts] of Object.entries(table)) {
    if (!Array.isArray(parts)) continue;
    out[id] = parts.map((part) => {
      const p = {};
      let hasFunc = false;
      for (const [k, v] of Object.entries(part)) {
        if (typeof v === "function") {
          if (k === "func" || k === "render" || k === "init") hasFunc = true;
          continue; // callbacks aren't serializable and aren't ours to run
        }
        if (v === STUB || v === undefined) continue;
        p[k] = v;
      }
      if (hasFunc && !p.type) p.type = "FUNC";
      return p;
    });
  }
  return out;
}

// Pick the first finite number from a value that may be a number or an array
// (roBrowserLegacy uses arrays like [77, 140] or [254, 'quake'] for multi-effects).
function firstNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v)) for (const x of v) if (typeof x === "number" && Number.isFinite(x)) return x;
  return undefined;
}

// Reduce a roBrowserLegacy SkillEffect entry to the endpoint's 3-field contract.
// effectId (played on the caster) absorbs the on-caster/on-success variants so
// buff-style skills still resolve to a visible effect.
const CASTER_FIELDS = ["effectId", "effectIdOnCaster", "successEffectIdOnCaster", "successEffectId"];
function fold(entry) {
  const out = {};
  if (!entry || typeof entry !== "object") return out;
  for (const k of CASTER_FIELDS) {
    const n = firstNum(entry[k]);
    if (n !== undefined) {
      out.effectId = n;
      break;
    }
  }
  const hit = firstNum(entry.hitEffectId);
  if (hit !== undefined) out.hitEffectId = hit;
  const ground = firstNum(entry.groundEffectId);
  if (ground !== undefined) out.groundEffectId = ground;
  return out;
}

// Does an effect id resolve to at least one STR part in the effect table?
function hasStr(effectTable, effId) {
  const parts = effectTable[effId];
  return Array.isArray(parts) && parts.some((p) => p.type === "STR");
}

// Emit a skill entry with the contract fields in canonical order.
function orderEntry(e) {
  const o = {};
  if (e.effectId !== undefined) o.effectId = e.effectId;
  if (e.hitEffectId !== undefined) o.hitEffectId = e.hitEffectId;
  if (e.groundEffectId !== undefined) o.groundEffectId = e.groundEffectId;
  return o;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node tools/gen-effect-tables.mjs [--src <dir>] [--out <dir>]");
    return;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = args.out || join(here, "..", "gateway", "internal", "effect", "data");
  mkdirSync(outDir, { recursive: true });

  const [skillConstSrc, skillEffectSrc, effectTableSrc] = await Promise.all([
    loadSource("SkillConst", args.src),
    loadSource("SkillEffect", args.src),
    loadSource("EffectTable", args.src),
  ]);

  const SK = evalModule(skillConstSrc); // { NAME: numericSkillId }
  const skillEffect = evalModule(skillEffectSrc, { SK }); // SkillEffect[SK.NAME] -> raw entry
  const effectTable = cleanEffectTable(evalModule(effectTableSrc));

  // Fold every numeric-keyed skill entry; keep only skills with a contract field.
  const skillMap = {};
  for (const [id, entry] of Object.entries(skillEffect)) {
    if (!/^\d+$/.test(id)) continue;
    const f = fold(entry);
    if (Object.keys(f).length) skillMap[id] = f;
  }

  // Restore classic skills Legacy dropped; assert each resolves to a STR.
  for (const [id, over] of Object.entries(CLASSIC_OVERRIDES)) {
    const merged = { ...(skillMap[id] || {}) };
    for (const [k, v] of Object.entries(over)) {
      if (merged[k] === undefined) merged[k] = v;
      if (!hasStr(effectTable, v))
        throw new Error(`CLASSIC_OVERRIDES skill ${id} ${k}=${v} does not resolve to a STR in effect_table`);
    }
    skillMap[id] = merged;
  }

  const skillOut = {};
  for (const id of Object.keys(skillMap).map(Number).sort((a, b) => a - b)) {
    skillOut[id] = orderEntry(skillMap[id]);
  }

  writeFileSync(join(outDir, "skill_map.json"), JSON.stringify(skillOut) + "\n");
  writeFileSync(join(outDir, "effect_table.json"), JSON.stringify(effectTable) + "\n");

  // Report coverage.
  const strEffects = Object.keys(effectTable).filter((id) => hasStr(effectTable, id)).length;
  let skillsWithStr = 0;
  for (const e of Object.values(skillOut)) {
    if ([e.effectId, e.hitEffectId, e.groundEffectId].some((x) => x !== undefined && hasStr(effectTable, x)))
      skillsWithStr++;
  }
  const withGround = Object.values(skillOut).filter((e) => e.groundEffectId !== undefined).length;
  console.error(
    `wrote ${outDir}:\n` +
      `  skill_map.json:    ${Object.keys(skillOut).length} skills ` +
      `(${skillsWithStr} resolve to a STR effect, ${withGround} with a groundEffectId)\n` +
      `  effect_table.json: ${Object.keys(effectTable).length} effect ids (${strEffects} with a STR part)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
