// The LATAM patch index, and how to read it.
//
// Shared by the two halves of the update pipeline, which must agree exactly:
// tools/patch-cycle.mjs polls this index and decides which sequences are new,
// then tools/apply-patches.mjs independently decides which sequences to fetch.
// If the two parsers ever disagree, the run either downloads nothing (a green
// cycle that updated no assets) or advances the recorded sequence past a patch
// that was never applied — which the poll can then never revisit, because it
// matches on seq.
//
// Plain ESM with no dependencies.

export const PATCH_INDEX = "https://ro1patch.gnjoylatam.com/LIVE/patchinfo/patch.txt";
export const PATCH_FILE = "https://ro1patch.gnjoylatam.com/LIVE/patchfile";

// parsePatchList reads the index: "<seq> <filename>" per line. A tab-indented
// line prefixed with // is a patch that was pulled after release — the official
// patcher skips those and so do we, though the files often still exist on the
// CDN, which is why `includePulled` exists: tools/multiserver walks a whole
// patch history looking for the one archive that still carries an old table,
// and a pulled patch is a copy like any other there.
//
// The format and the `//` convention are the same on every official server
// checked — LATAM, iRO, kRO, kRO Zero, jRO, twRO and twRO Zero — which is why
// this one parser serves both the LATAM patch cycle and the multi-server
// extraction. Each row carries `pulled` so a caller that asked for them can
// still tell them apart.
export function parsePatchList(text, { includePulled = false } = {}) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const pulled = /^\s*\/\//.test(raw);
    if (pulled && !includePulled) continue;
    const m = raw.replace(/^\s*\/\//, "").match(/^\s*(\d+)[\s\t]+(\S+)\s*$/);
    if (m) out.push({ seq: Number(m[1]), file: m[2], pulled });
  }
  return out;
}
