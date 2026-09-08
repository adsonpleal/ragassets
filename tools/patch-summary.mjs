#!/usr/bin/env node
// Turn "a patch was applied" into "here is what actually changed for a player".
//
// patch-report.json only knows file paths — 400 sprites, 12 textures. That is
// true and nearly useless to a reader: nobody browsing #novidades cares how many
// .spr files moved, they care whether there are new items, maps or costumes.
//
// The semantic answer only exists as a before/after difference of the DERIVED
// stores, because the client ships no changelog. So the cycle snapshots a
// handful of small tables before rebuilding and diffs them after.
//
// Deliberately counts, not lists. A maintenance can add hundreds of items and an
// embed that names them all is unreadable and hits Discord's 4096-char limit;
// the site itself is the place to browse detail.
//
// Usage:
//   node tools/patch-summary.mjs --before <dir> --after <resources dir> \
//        [--report patch-report.json] [--out summary.json]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Each source: where it lives, how to pull comparable ids out of it, and what to
// call it. Shapes genuinely differ — three of these are arrays of objects, one is
// an array of strings, one is a plain map — so the reader is per-source rather
// than one clever generic walk that would break silently when a shape changes.
const SOURCES = [
  { key: "items",   path: "raw/items.json",     ids: (d) => byId(d),        one: "item",       many: "itens" },
  { key: "classes", path: "raw/classes.json",   ids: (d) => byId(d),        one: "classe",     many: "classes" },
  { key: "jobs",    path: "raw/jobs.json",      ids: (d) => byId(d),        one: "profissão",  many: "profissões" },
  { key: "skills",  path: "raw/skills.json",    ids: (d) => byId(d),        one: "habilidade", many: "habilidades" },
  { key: "maps",    path: "maps/index.json",    ids: (d) => byName(d.maps), one: "mapa",       many: "mapas" },
  { key: "bgm",     path: "bgm/index.json",     ids: (d) => byKey(d.maps),  one: "trilha",     many: "trilhas" },
  { key: "effects", path: "effects/index.json", ids: (d) => byId(d.items),  one: "efeito",     many: "efeitos" },
];

const byId = (arr) => new Map((arr ?? []).map((e) => [String(e.id), e]));
const byName = (arr) => new Map((arr ?? []).map((n) => [String(n), n]));
const byKey = (obj) => new Map(Object.entries(obj ?? {}));

// Raw file buckets worth mentioning alongside the semantic counts, because a
// patch that only redraws sprites changes no table at all and would otherwise
// look like nothing happened.
const FILE_BUCKETS = [
  ["sprites", "data/sprite/"],
  ["effectTextures", "data/texture/effect/"],
  ["palettes", "data/palette/"],
  ["imf", "data/imf/"],
];

function load(dir, rel) {
  const p = join(dir, rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // a half-written snapshot must not fail the cycle
  }
}

export function diff(beforeDir, afterDir, report) {
  const added = {};
  const changed = {};
  const missing = [];

  for (const src of SOURCES) {
    const b = load(beforeDir, src.path);
    const a = load(afterDir, src.path);
    // No "after" means the store was not rebuilt this cycle — not zero change,
    // simply unknown, and reporting 0 would be a lie. No "before" means this is
    // the first run; everything would look new, so say nothing.
    if (a === null || b === null) {
      if (a !== null && b === null) missing.push(src.key);
      continue;
    }
    const bm = src.ids(b);
    const am = src.ids(a);
    let nAdded = 0;
    let nChanged = 0;
    for (const [id, av] of am) {
      if (!bm.has(id)) {
        nAdded++;
      } else if (JSON.stringify(bm.get(id)) !== JSON.stringify(av)) {
        nChanged++;
      }
    }
    if (nAdded) added[src.key] = nAdded;
    if (nChanged) changed[src.key] = nChanged;
  }

  const files = {};
  for (const [key, prefix] of FILE_BUCKETS) {
    const n = (report?.files ?? []).filter((f) => f.startsWith(prefix)).length;
    if (n) files[key] = n;
  }

  const seqs = report?.applied ?? [];
  return {
    seq: seqs.length ? { from: Math.min(...seqs), to: Math.max(...seqs) } : null,
    maxSeq: report?.maxSeq ?? null,
    skipped: report?.skipped?.length ?? 0,
    added,
    changed,
    files,
    firstRun: missing,
    generatedAt: new Date().toISOString(),
  };
}

export function labelFor(key, n) {
  const src = SOURCES.find((s) => s.key === key);
  if (!src) return key;
  return n === 1 ? src.one : src.many;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--before") out.before = argv[++i];
    else if (a === "--after") out.after = argv[++i];
    else if (a === "--report") out.report = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else throw new Error(`unknown flag ${a}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, "/") ||
    process.argv[1]?.endsWith("patch-summary.mjs")) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.before || !args.after) {
    console.error("--before <dir> and --after <dir> are required");
    process.exit(1);
  }
  const report = args.report && existsSync(args.report)
    ? JSON.parse(readFileSync(args.report, "utf8"))
    : null;
  const summary = diff(args.before, args.after, report);
  const text = JSON.stringify(summary, null, 2);
  if (args.out) writeFileSync(args.out, text + "\n");
  else console.log(text);
}
