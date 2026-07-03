#!/usr/bin/env node
// gen-effect-tables.mjs — regenerate the skill/effect lookup tables the
// /effect/skill-map and /effect/table endpoints serve, ported verbatim from
// roBrowser's plain-data source modules:
//
//   src/DB/Skills/SkillConst.js   skill-name const  -> numeric skill id
//   src/DB/Skills/SkillEffect.js  skill id          -> { effectId?, hitEffectId?, groundEffectId? }
//   src/DB/Effects/EffectTable.js effect id         -> [ { type, file, min, wav, attachedEntity, rand, ... } ]
//
// These are AMD modules (define(...)); we execute them with stub define/require
// so their returned data objects fall out, then emit them as JSON for go:embed.
// Function-valued parts (roBrowser's type:'FUNC' renderers) can't be serialized,
// so a part carrying a `func` is flagged type:'FUNC' and the callback dropped —
// the client renders those itself; ragassets only needs the metadata + STR/SPR
// file names (see the task spec: STR is served; FUNC/SPR/CYLINDER are flagged).
//
// Usage:
//   node tools/gen-effect-tables.mjs [--src <dir>] [--out <dir>]
// With no --src the roBrowser sources are fetched from GitHub (master). --out
// defaults to gateway/internal/effect/data.
//
// This is a manual maintenance step (like cmd/gen-resolver): re-run only when the
// upstream roBrowser tables change. The committed JSON is the source of truth for
// the running gateway.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://raw.githubusercontent.com/vthibault/roBrowser/master";
const FILES = {
  SkillConst: "src/DB/Skills/SkillConst.js",
  SkillEffect: "src/DB/Skills/SkillEffect.js",
  EffectTable: "src/DB/Effects/EffectTable.js",
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

// A callable, self-returning stub for any roBrowser dependency an AMD factory
// asks for (via require or a deps array). Nothing here runs at data-construction
// time, so the stub is never actually invoked to produce table data.
const stub = new Proxy(function () {}, {
  get: () => stub,
  apply: () => stub,
  construct: () => stub,
});

// runAMD executes an AMD module's source and returns whatever its factory
// returns. Supports define(factory) and define(deps, factory); the factory's
// require/deps are stubbed.
function runAMD(src) {
  let result;
  const define = (a, b) => {
    const factory = typeof a === "function" ? a : b;
    const deps = Array.isArray(a) ? a : null;
    const args = deps ? deps.map(() => stub) : [() => stub /* require */];
    result = factory(...args);
  };
  // eslint-disable-next-line no-new-func
  const run = new Function("define", "require", src);
  run(define, () => stub);
  return result;
}

// Flag FUNC parts and drop unserializable callbacks. roBrowser marks a part as a
// procedural effect either with type:'FUNC' or by giving it a `func` callback; we
// normalize both to type:'FUNC' so the client can tell served (STR/SPR) parts
// from ones it must render itself.
function cleanEffectTable(table) {
  const out = {};
  for (const [id, parts] of Object.entries(table)) {
    if (!Array.isArray(parts)) continue;
    out[id] = parts.map((part) => {
      const p = {};
      let hasFunc = false;
      for (const [k, v] of Object.entries(part)) {
        if (typeof v === "function") {
          if (k === "func") hasFunc = true;
          continue; // callbacks aren't serializable and aren't ours to run
        }
        if (v === stub || v === undefined) continue;
        p[k] = v;
      }
      if (hasFunc && !p.type) p.type = "FUNC";
      return p;
    });
  }
  return out;
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

  // SkillConst returns a { NAME: id } map; SkillEffect's factory takes it as SK
  // and returns SkillEffect keyed by the numeric id (SK.NAME).
  const SK = runAMD(skillConstSrc);
  let skillMap;
  {
    let result;
    const define = (a, b) => {
      const factory = typeof a === "function" ? a : b;
      result = factory(SK); // deps: ['./SkillConst'] -> [SK]
    };
    const run = new Function("define", "require", skillEffectSrc);
    run(define, () => stub);
    skillMap = result;
  }
  // Normalize skill-map keys to strings and drop any that didn't resolve to a
  // numeric skill id (guards against a missing SkillConst entry).
  const skillOut = {};
  for (const [id, eff] of Object.entries(skillMap)) {
    if (!/^\d+$/.test(id)) continue;
    skillOut[id] = eff;
  }

  const effectTable = cleanEffectTable(runAMD(effectTableSrc));

  writeFileSync(join(outDir, "skill_map.json"), JSON.stringify(skillOut) + "\n");
  writeFileSync(join(outDir, "effect_table.json"), JSON.stringify(effectTable) + "\n");

  const strCount = Object.values(effectTable).filter((parts) =>
    parts.some((p) => p.type === "STR")
  ).length;
  console.error(
    `wrote ${outDir}:\n` +
      `  skill_map.json:    ${Object.keys(skillOut).length} skills\n` +
      `  effect_table.json: ${Object.keys(effectTable).length} effect ids (${strCount} with a STR part)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
