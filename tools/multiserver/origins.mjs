// The official Ragnarok Online servers that still run a Gravity-style patch
// service, and where each one keeps its patch index and its file store.
//
// Every endpoint here was verified from Brazil on 2026-11-17 with a GET on the
// index and a `Range: bytes=0-45` on one archive. They came out of the RO
// Patcher Lite bundle: its binaries embed the patch config for every server it
// supports (`WebSite`, `WebPath`, `WebList`, `FtpSite`), and
// `doc/rsu-ai-rag-lite.sample.ini` documents the field names. See
// docs/multi-server-extraction-plan.md §2.
//
// Case matters on these CDNs in ways that look like geo-blocking and are not:
// kRO serves the index under /PatchInfo/ and the files under /Patch/, while its
// Zero branch uses /Patchinfo_Zero/ and /Patchfile_Zero/. A wrong prefix answers
// 403 AccessDenied (S3), not 404.

import { PATCH_FILE, PATCH_INDEX, parsePatchList } from "../patchlist.mjs";

// Every server's index has the same format and the same `//` convention, so the
// parser is tools/patchlist.mjs — the one the LATAM patch cycle already runs.
// Re-exported so a caller reading an index keeps one import.
export { parsePatchList };

/**
 * @typedef {object} Origin
 * @property {string} id         short key used on disk and on the CLI
 * @property {string} label      human name
 * @property {string} badge      2-5 chars, for the UI badge later
 * @property {string} index      URL of the patch index (`<seq>\t<file>` lines)
 * @property {string} files      base URL of the file store (no trailing slash)
 * @property {string} encoding   how that client encodes its item-name tables
 * @property {string} [note]
 */

/** @type {Record<string, Origin>} */
export const ORIGINS = {
  latam: {
    id: "latam",
    label: "RO LATAM",
    badge: "LATAM",
    // The same two URLs the patch cycle polls, not a second copy of them: a
    // divergence here would mean this tool and tools/patch-cycle.mjs were
    // reading different clients and calling both "ours".
    index: PATCH_INDEX,
    files: PATCH_FILE,
    encoding: "windows-1252",
    note: "ours; already in the ragassets pipeline, here for comparison",
  },
  iro: {
    id: "iro",
    label: "iRO (International)",
    badge: "iRO",
    // FTP only for the file store. The index is also readable over HTTP at
    // http://patch1.playragnarok.com/patch02/patch3.txt, but the archives are
    // not served there (404), so there is no point splitting protocols.
    index: "ftp://ropatch2.gravityus.com/patch/patchlist/patch3.txt",
    files: "ftp://ropatch2.gravityus.com/patch",
    encoding: "windows-1252",
  },
  kro: {
    id: "kro",
    label: "kRO",
    badge: "kRO",
    index: "https://ropatch.gnjoy.com/PatchInfo/patch2.txt",
    files: "https://ropatch.gnjoy.com/Patch",
    encoding: "euc-kr",
    note: "ships .gsf/.gef (v0x300) since 2025-12-04 — those archives list but do not extract",
  },
  krozero: {
    id: "krozero",
    label: "kRO Zero",
    badge: "kROZ",
    index: "https://ropatch.gnjoy.com/Patchinfo_Zero/patch2.txt",
    files: "https://ropatch.gnjoy.com/Patchfile_Zero",
    encoding: "euc-kr",
  },
  jro: {
    id: "jro",
    label: "jRO",
    badge: "jRO",
    // Index and files live on different hosts; asking the index host for an
    // archive answers 403.
    index: "http://httppatch.ragnarokonline.jp/patch30/patchbbs/patch2.txt",
    files: "http://patch2.gungho.jp/pub/dl-gunghoftp/roftp",
    encoding: "shift_jis",
    note: "v0x103 .gpf (needs the ragassets fix) and .gsf (v0x300) since 2026-04-07",
  },
  twro: {
    id: "twro",
    label: "twRO",
    badge: "twRO",
    index: "https://twcdn.gnjoy.com.tw/ragnarok/patchinfo/patch3.txt",
    files: "https://twcdn.gnjoy.com.tw/ragnarok/patchfile",
    encoding: "big5",
    note: "still v0x102, patches weekly, furthest-ahead accessory table",
  },
  twrozero: {
    id: "twrozero",
    label: "twRO Zero",
    badge: "twROZ",
    index: "https://rollive-patch.gnjoy.com.tw/patchinfo/patch.txt",
    files: "https://rollive-patch.gnjoy.com.tw/patchfile",
    encoding: "big5",
  },
};

/** Every origin except ours, which is where the new costumes would come from. */
export const FOREIGN = Object.values(ORIGINS).filter((o) => o.id !== "latam");

export function origin(id) {
  const o = ORIGINS[id];
  if (!o) {
    throw new Error(`unknown origin "${id}" — have ${Object.keys(ORIGINS).join(", ")}`);
  }
  return o;
}

/** Resolve a --origin flag: a comma list, "all", or "foreign". */
export function selectOrigins(spec) {
  if (!spec || spec === "all") return Object.values(ORIGINS);
  if (spec === "foreign") return FOREIGN;
  return spec.split(",").map((s) => origin(s.trim()));
}

// Archive extensions that carry a GRF file table (and so can be listed with two
// range reads). `.rgz` is a gzip stream of loose files with no table at all, so
// it has to be downloaded whole to be read — recorded separately by the indexer.
export const GRF_EXT = /\.(gpf|gsf|gef|grf)$/i;
export const RGZ_EXT = /\.rgz$/i;

/**
 * A .rgz has no file table, so finding a file inside one costs a whole
 * download. Ordering the candidates is therefore the difference between one
 * request and a hundred: a client-side table update ships in a
 * `*_live_client_*.rgz` (twRO) or `*main02.rgz` (jRO) patch, while
 * `*_Raghash_*.rgz` carries only RagHash.dat and `*Ragexe.rgz` is an 18 MB
 * executable. Newest first within each group, because the newest copy of a
 * table is the one worth having.
 */
export function rgzProbeOrder(rows) {
  const bySeq = [...rows].sort((a, b) => Number(b.seq) - Number(a.seq));
  const rank = (f) => (/ragexe|raghash/i.test(f) ? 2 : /client|main/i.test(f) ? 0 : 1);
  return bySeq.sort((a, b) => rank(a.file) - rank(b.file));
}
