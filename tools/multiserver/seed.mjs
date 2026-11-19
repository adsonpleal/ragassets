// Seed a catalogue from the tables this project already extracted by hand.
//
// docs/data/<origin>-accessories.tsv holds `view \t sprite \t ACCESSORY_key`
// rows produced during the exploration, one file per client. Stage 2 would
// rebuild them, but only after stage 1 has walked far enough back to find that
// origin's AccName.lub — LATAM's newest copy sits ~350 archives deep, which is
// an hour of polite range reads to rediscover something already on disk.
//
// This is a shortcut for state, not a source of truth: stage 2 overwrites
// views.tsv whenever it runs, and a seeded catalogue carries no item names.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths, ensureDir, writeRows } from "./store.mjs";
import { ORIGINS } from "./origins.mjs";

export function seedOrigin(originId, file) {
  if (!ORIGINS[originId]) throw new Error(`unknown origin ${originId}`);
  if (!existsSync(file)) return null;
  const rows = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [view, sprite, key] = line.split("\t");
    const v = Number(view);
    if (!Number.isInteger(v)) continue;
    rows.push([v, sprite ?? "", key ?? ""]);
  }
  if (!rows.length) return null;
  ensureDir(paths.catalogDir(originId));
  writeRows(join(paths.catalogDir(originId), "views.tsv"), ["view", "sprite", "accessoryKey"], rows);
  return { origin: originId, views: rows.length, from: file };
}

/** Seed every origin that has a docs/data/<id>-accessories.tsv. */
export function seedAll(dir = "docs/data") {
  const out = [];
  for (const id of Object.keys(ORIGINS)) {
    const r = seedOrigin(id, join(dir, `${id}-accessories.tsv`));
    if (r) out.push(r);
  }
  return out;
}
