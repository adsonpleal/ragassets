// The LATAM patch index, and how to read it.
//
// Shared by the two halves of the update pipeline, which must agree exactly:
// worker/shim.mjs polls this index and decides which sequences are new, then
// tools/apply-patches.mjs independently decides which sequences to fetch. If the
// two parsers ever disagree, the run either downloads nothing (a green workflow
// that updated no assets) or advances last_seq past a patch that was never
// applied — which the poll can then never revisit, because it matches on seq.
//
// Plain ESM with no dependencies, so wrangler's esbuild bundles it into the
// Worker and Node imports it directly.

export const PATCH_INDEX = "https://ro1patch.gnjoylatam.com/LIVE/patchinfo/patch.txt";
export const PATCH_FILE = "https://ro1patch.gnjoylatam.com/LIVE/patchfile";

// parsePatchList reads the index: "<seq> <filename>" per line. A tab-indented
// line prefixed with // is a patch that was pulled after release — the official
// patcher skips those and so do we, though the files often still exist on the
// CDN.
export function parsePatchList(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*\/\//.test(raw)) continue;
    const m = raw.match(/^\s*(\d+)[\s\t]+(\S+)\s*$/);
    if (m) out.push({ seq: Number(m[1]), file: m[2] });
  }
  return out;
}
