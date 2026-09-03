#!/usr/bin/env node
// Download the LATAM patches newer than a given sequence and unpack them into
// one directory, in order.
//
// Patches carry whole copies of the files they change, never binary deltas, so
// applying a run of them is just extracting each in sequence and letting later
// ones overwrite earlier ones. That is why this is a copy rather than a merge,
// and why the result is a valid overlay for the paths it touches.
//
// It does NOT decide what to do with the result — that is the workflow's job.
// The two containers a patch release ships are both handled: .gpf carries the
// data.grf tree, .rgz carries the loose client files (System/**, RagHash.dat,
// Ragexe), and extracting both into one directory reproduces the client's own
// layout.
//
// Usage:
//   node tools/apply-patches.mjs --out <dir> --from-seq <n> [--to-seq <n>]
//   node tools/apply-patches.mjs --out <dir> --files a.gpf,b.rgz
//   node tools/apply-patches.mjs --list-only --from-seq <n>
//
// Writes a JSON report to <out>/../patch-report.json describing what arrived.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const PATCH_INFO = "https://ro1patch.gnjoylatam.com/LIVE/patchinfo/patch.txt";
const PATCH_FILE = "https://ro1patch.gnjoylatam.com/LIVE/patchfile";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--from-seq") out.fromSeq = Number(argv[++i]);
    else if (a === "--to-seq") out.toSeq = Number(argv[++i]);
    else if (a === "--files") out.files = argv[++i].split(",").filter(Boolean);
    else if (a === "--list-only") out.listOnly = true;
    else if (a === "--max") out.max = Number(argv[++i]);
  }
  return out;
}

// Mirrors the parser in worker/shim.mjs. A tab-indented line prefixed with // is
// a patch that was pulled after release; the official patcher skips those and so
// do we, though the files usually still exist on the CDN.
function parsePatchList(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*\/\//.test(raw)) continue;
    const m = raw.match(/^\s*(\d+)[\s\t]+(\S+)\s*$/);
    if (m) out.push({ seq: Number(m[1]), file: m[2] });
  }
  return out;
}

async function fetchPatchList() {
  // No conditional request and no cache: this runs once per job and must see
  // the current index, not a cached one.
  const res = await fetch(PATCH_INFO, { cache: "no-store" });
  if (!res.ok) throw new Error(`patch.txt: HTTP ${res.status}`);
  return parsePatchList(await res.text());
}

async function download(file, dest) {
  const res = await fetch(`${PATCH_FILE}/${file}`);
  if (!res.ok) {
    // A retracted patch can 404 while still being listed. That is expected and
    // must not fail the run.
    return { ok: false, status: res.status };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return { ok: true, bytes: buf.length };
}

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(p.slice(base.length + 1).split("\\").join("/"));
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const list = await fetchPatchList();
  const maxSeq = list.reduce((m, p) => Math.max(m, p.seq), 0);

  let wanted;
  if (args.files?.length) {
    wanted = args.files.map((f) => ({ seq: list.find((p) => p.file === f)?.seq ?? 0, file: f }));
  } else {
    const from = args.fromSeq ?? 0;
    const to = args.toSeq ?? maxSeq;
    wanted = list.filter((p) => p.seq > from && p.seq <= to);
  }
  wanted.sort((a, b) => a.seq - b.seq);
  if (args.max) wanted = wanted.slice(0, args.max);

  console.error(`patch index: ${list.length} active, head at seq ${maxSeq}`);
  console.error(`to apply: ${wanted.length} patch(es)`);
  if (args.listOnly) {
    for (const p of wanted) console.error(`  ${p.seq}\t${p.file}`);
    console.log(JSON.stringify({ maxSeq, count: wanted.length, patches: wanted }, null, 2));
    return;
  }
  if (!args.out) throw new Error("--out is required");
  if (!wanted.length) {
    console.error("nothing to apply");
    writeFileSync("patch-report.json", JSON.stringify({ maxSeq, applied: [], files: [] }, null, 2));
    return;
  }

  const out = resolve(args.out);
  mkdirSync(out, { recursive: true });
  const tmp = join(dirname(out), "_patchdl");
  mkdirSync(tmp, { recursive: true });

  const applied = [];
  const skipped = [];
  for (const p of wanted) {
    const dest = join(tmp, p.file);
    const dl = await download(p.file, dest);
    if (!dl.ok) {
      console.error(`  ${p.seq}\t${p.file}\tHTTP ${dl.status}, skipped`);
      skipped.push({ ...p, status: dl.status });
      continue;
    }
    // Extract in sequence order into the same directory. Later patches
    // legitimately overwrite earlier ones — that IS the merge.
    try {
      execFileSync(process.execPath, ["extract-grf.mjs", "--extract", out, "--grf", dest], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      console.error(`  ${p.seq}\t${p.file}\t${(dl.bytes / 1048576).toFixed(2)} MB`);
      applied.push({ ...p, bytes: dl.bytes });
    } catch (e) {
      // One unreadable patch should not abandon the rest; the report records it
      // so the workflow can decide.
      console.error(`  ${p.seq}\t${p.file}\tEXTRACT FAILED: ${String(e.stderr ?? e).slice(0, 200)}`);
      skipped.push({ ...p, error: String(e.stderr ?? e).slice(0, 400) });
    }
    rmSync(dest, { force: true });
  }
  rmSync(tmp, { recursive: true, force: true });

  const files = existsSync(out) ? walk(out) : [];
  const byTop = {};
  for (const f of files) {
    const k = f.split("/").slice(0, 2).join("/");
    byTop[k] = (byTop[k] || 0) + 1;
  }

  const report = {
    maxSeq,
    applied: applied.map((p) => p.seq),
    skipped: skipped.map((p) => ({ seq: p.seq, file: p.file, status: p.status ?? null })),
    fileCount: files.length,
    bytes: files.reduce((n, f) => n + statSync(join(out, f)).size, 0),
    byPrefix: byTop,
    files,
  };
  writeFileSync("patch-report.json", JSON.stringify(report, null, 2));

  console.error(`\napplied ${applied.length}, skipped ${skipped.length}`);
  console.error(`${files.length} distinct file(s), ${(report.bytes / 1048576).toFixed(1)} MB`);
  for (const [k, n] of Object.entries(byTop).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.error(`  ${String(n).padStart(6)}  ${k}`);
  }
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
