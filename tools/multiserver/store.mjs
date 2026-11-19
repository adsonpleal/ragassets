// Where the pipeline keeps its state on disk, and the two file formats it uses.
//
// Nothing lands in the repo: these trees get large (the path index is hundreds
// of MB across six origins, and an extracted sprite tree is GBs). Default root
// is ~/ro-multiserver, overridable with MULTISERVER_DIR.
//
//   index/<origin>/archives.tsv   one row per archive — the resume ledger
//   index/<origin>/paths.tsv      one row per file inside every archive
//   index/<origin>/rgz.tsv        archives with no file table, deferred
//   cache/<origin>/<archive>      downloaded archives
//   catalog/<origin>/*.tsv        view/item/name tables for that client
//   mirror/<origin>/data/...      extracted assets, newest patch wins
//   shortlist.tsv                 what is missing from LATAM, and where to get it

import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// The extractor, for the two stages that shell out to its `--extract` mode
// rather than importing it: unpacking a whole 292 MB patch is a job for its own
// process, and `--extract` is a CLI mode, not an exported function. Resolved
// from this module's own URL so it works whatever the cwd is.
export const EXTRACTOR = fileURLToPath(new URL("../../extract-grf.mjs", import.meta.url));

export const ROOT = process.env.MULTISERVER_DIR ?? join(homedir(), "ro-multiserver");

export const paths = {
  root: ROOT,
  indexDir: (o) => join(ROOT, "index", o),
  archives: (o) => join(ROOT, "index", o, "archives.tsv"),
  pathsFile: (o) => join(ROOT, "index", o, "paths.tsv"),
  rgz: (o) => join(ROOT, "index", o, "rgz.tsv"),
  cacheDir: (o) => join(ROOT, "cache", o),
  catalogDir: (o) => join(ROOT, "catalog", o),
  mirrorDir: (o) => join(ROOT, "mirror", o),
  shortlist: () => join(ROOT, "shortlist.tsv"),
  plan: () => join(ROOT, "plan.tsv"),
  iconPlan: () => join(ROOT, "icons-plan.tsv"),
  slots: () => join(ROOT, "slots.tsv"),
  catalogue: () => join(ROOT, "foreign-costumes.json"),
  iconsDir: () => join(ROOT, "icons"),
  // The two inputs that are the *app's* and not this pipeline's: what it
  // already lists, and which LATAM views its probe saw render. They live under
  // the state root rather than in this repository because they describe the
  // consumer, and ragassets does not own the consumer — stage 3 says so when
  // they are missing instead of quietly deciding everything is needed.
  appDir: () => join(ROOT, "app"),
  appCostumes: () => join(ROOT, "app", "costumes.json"),
  renderProbe: () => join(ROOT, "app", "renderable.tsv"),
};

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Append TSV rows, writing `header` first if the file is new. */
export function appendRows(file, header, rows) {
  if (!rows.length) return;
  ensureDir(join(file, ".."));
  const fresh = !existsSync(file);
  const body = rows.map((r) => r.join("\t")).join("\n") + "\n";
  appendFileSync(file, fresh ? `${header.join("\t")}\n${body}` : body, "utf8");
}

export function writeRows(file, header, rows) {
  ensureDir(join(file, ".."));
  writeFileSync(file, [header.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n") + "\n", "utf8");
}

/** Read a TSV written by appendRows/writeRows into objects keyed by header. */
export function readRows(file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return [];
  const header = lines[0].split("\t");
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cells[c] ?? "";
    out.push(row);
  }
  return out;
}

/**
 * Stream a big TSV line by line. paths.tsv runs to hundreds of MB across six
 * origins, which is past what belongs in a single string, so this reads it
 * through a stream rather than readFileSync.
 */
export async function* streamRows(file) {
  if (!existsSync(file)) return;
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!line) continue;
    if (!header) {
      header = line.split("\t");
      continue;
    }
    const cells = line.split("\t");
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cells[c] ?? "";
    yield row;
  }
}

export const ARCHIVE_HEADER = [
  "seq",
  "file",
  "kind",
  "version",
  "layout",
  "entries",
  "tableBytes",
  "status",
  "note",
];

export const PATH_HEADER = ["seq", "file", "path", "uncompSize", "flags"];
