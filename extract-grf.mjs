#!/usr/bin/env node
// extract-grf.mjs — standalone Ragnarok Online GRF/GPF extractor.
//
// Reads Gravity's GRF archive formats and writes the (decompressed, decrypted)
// files to disk. Handles GRF versions 0x101 / 0x103 / 0x200 AND the custom
// 0x300 "Event Horizon" fork used by recent official clients (e.g. ROLatam),
// including the per-entry custom DES encryption — which the standard zextractor
// tool cannot read.
//
// No dependencies beyond Node's stdlib (needs Node 18+ for the EUC-KR decoder).
//
// Usage:
//   node extract-grf.mjs --list   <file.grf>
//   node extract-grf.mjs --extract <out-dir> --grf <file.grf> [--match <regex>]
//   node extract-grf.mjs --dump   <file.grf>::<path>      # one file to stdout (fwd-slash path)
//   node extract-grf.mjs --icons  <out-dir> --grf <file.grf> [--iteminfo <path>]
//   node extract-grf.mjs --effects <out-dir> --grf <file.grf> [--iteminfo <path>]
//   node extract-grf.mjs --maps <out-dir> --grf <file.grf> [--map <name>]
//
// Examples:
//   # List every entry:
//   node extract-grf.mjs --list data.grf
//
//   # Extract just the resources zrenderer needs into ./resources:
//   node extract-grf.mjs --extract resources --grf data.grf \
//     --match "data\\(sprite|palette|imf|luafiles514)\\"
//
//   # The --match value is a JS regex tested (case-insensitive) against each
//   # stored filename. Stored names use BACKSLASH separators, so escape them.
//
//   # Extract item/collection/skill/job icons (keyed by numeric id) and
//   # char-creation UI elements (keyed by basename) as transparent PNGs
//   # (reads System/iteminfo_new.lub next to the GRF unless --iteminfo is given):
//   node extract-grf.mjs --icons resources/icons --grf data.grf
//
//   # Extract the "effect-only" costumes (auras / falling petals / spotlights —
//   # the costumes that have no character sprite, drawn by the client's ".str"
//   # world-effect system) as per-effect bundles (effect.json + texture PNGs) plus
//   # a catalogue, for the latamvisuais map simulator to fetch like /icons:
//   node extract-grf.mjs --effects resources/effects --grf data.grf
//
//   # Extract every world map (data/<name>.gat/.gnd/.rsw + the .rsm models and
//   # BMP/TGA textures they reference, converted to PNG, plus animated water and
//   # the shared cursor/grid UI) for the latamvisuais 3D map simulator. Models,
//   # textures, water and UI are de-duplicated into content-addressed shared
//   # stores (_t/_m/_w/_u); each map dir holds only its raw .gat/.gnd/.rsw and a
//   # manifest.json referencing the shared blobs. --map limits it to one map:
//   node extract-grf.mjs --maps resources/maps --grf data.grf
//   node extract-grf.mjs --maps resources/maps --grf data.grf --map prontera
//
// Credits: GRF reader, icon pipeline and the mini Lua 5.1 VM extracted from
// adsonpleal/ragreplaystats (tools/build-db.mjs + tools/lua51.mjs).
// The DES routine is ported from vthibault/grf-loader (MIT).

import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--grf") out.grf = argv[++i];
    else if (a === "--list") out.list = argv[++i];
    else if (a === "--dump") out.dump = argv[++i];
    else if (a === "--extract") out.extract = argv[++i];
    else if (a === "--match") out.match = argv[++i];
    else if (a === "--icons") out.icons = argv[++i];
    else if (a === "--effects") out.effects = argv[++i];
    else if (a === "--maps") out.maps = argv[++i];
    else if (a === "--map") out.map = argv[++i];
    else if (a === "--bgm") out.bgm = argv[++i];
    else if (a === "--bgmsrc") out.bgmsrc = argv[++i];
    else if (a === "--iteminfo") out.iteminfo = argv[++i];
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

function usage() {
  console.error(
    [
      "Ragnarok GRF extractor (incl. 0x300 'Event Horizon' + DES decryption)",
      "",
      "  node extract-grf.mjs --list    <file.grf>",
      "  node extract-grf.mjs --extract <out-dir> --grf <file.grf> [--match <regex>]",
      "  node extract-grf.mjs --dump    <file.grf>::<path>",
      "  node extract-grf.mjs --icons   <out-dir> --grf <file.grf> [--iteminfo <path>]",
      "",
      "  --match is a regex tested against stored names (backslash separators).",
      '  e.g. --match "data\\\\(sprite|palette|imf|luafiles514)\\\\"',
      "",
      "  --icons extracts item/collection/skill/job icons (keyed by numeric id)",
      "  and char-creation UI elements (keyed by basename) as transparent PNGs.",
      "  Reads System/iteminfo_new.lub next to the GRF unless --iteminfo points",
      "  at it explicitly.",
      "",
      "  --effects extracts the effect-only costumes (.str world effects: auras,",
      "  falling petals, spotlights) as per-effect bundles (effect.json + tex PNGs)",
      "  plus a catalogue (index.json). Also reads iteminfo_new.lub. It additionally",
      "  builds a bundle for every in-world map effect (.rsw type-4 .str, e.g.",
      "  bubble1..4) referenced by EFFECT_STR_TABLE (roBrowser's EffectTable.js).",
      "",
      "  --maps extracts every world map (or one, with --map <name>) for the map",
      "  simulator: per-map <name>/{<name>.gat,.gnd,.rsw,manifest.json} plus shared,",
      "  content-addressed model/texture/water/UI stores (_m/_t/_w/_u) and index.json.",
      "  The manifest's `effects` array lists the map's in-world .str effects.",
      "",
      "  --bgm extracts every map's background music: reads data/mp3nametable.txt",
      "  from the GRF and copies the referenced .mp3 files from the client BGM folder",
      "  (next to the GRF, or --bgmsrc <dir>) into <out>/, with index.json mapping",
      "  each map name → its mp3 basename.",
    ].join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.list && !args.extract && !args.dump && !args.icons && !args.effects && !args.maps && !args.bgm)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  if (args.list) {
    const grf = openGrf(args.list);
    for (const f of grf.files) {
      console.log(`${f.filename}\t${f.uncompSize}\tflags=0x${f.flags.toString(16)}`);
    }
    closeGrf(grf);
    process.exit(0);
  }

  if (args.extract) {
    if (!args.grf) {
      console.error("usage: --extract <out-dir> --grf <file.grf> [--match <regex>]");
      process.exit(1);
    }
    extractAll(args.grf, args.extract, args.match);
    process.exit(0);
  }

  if (args.dump) {
    const [grfPath, wantPath] = args.dump.split("::");
    if (!grfPath || !wantPath) {
      console.error("usage: --dump <file.grf>::<path>");
      process.exit(1);
    }
    const grf = openGrf(grfPath);
    try {
      const want = normalize(wantPath);
      const entry = findBestEntry(grf, want);
      if (!entry) {
        console.error(`Not found: ${wantPath}`);
        process.exit(1);
      }
      process.stdout.write(Buffer.from(extractFile(grf, entry)));
    } finally {
      closeGrf(grf);
    }
    process.exit(0);
  }

  if (args.icons) {
    if (!args.grf) {
      console.error("usage: --icons <out-dir> --grf <file.grf> [--iteminfo <path>]");
      process.exit(1);
    }
    extractIcons(args.grf, args.icons, args);
    process.exit(0);
  }

  if (args.effects) {
    if (!args.grf) {
      console.error("usage: --effects <out-dir> --grf <file.grf> [--iteminfo <path>]");
      process.exit(1);
    }
    extractEffects(args.grf, args.effects, args);
    process.exit(0);
  }

  if (args.maps) {
    if (!args.grf) {
      console.error("usage: --maps <out-dir> --grf <file.grf> [--map <name>]");
      process.exit(1);
    }
    extractMaps(args.grf, args.maps, args);
    process.exit(0);
  }

  if (args.bgm) {
    if (!args.grf) {
      console.error("usage: --bgm <out-dir> --grf <file.grf> [--bgmsrc <BGM-dir>]");
      process.exit(1);
    }
    extractBgm(args.grf, args.bgm, args);
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normalize(s) {
  return s.replace(/[\\/]+/g, "/").toLowerCase();
}

// The merged "Event Horizon" GRF carries several copies of the same logical
// path (patch layering, double-slash artifacts, etc.). normalize() collapses
// repeated slashes so they compare equal; among matches keep the largest by
// uncompressed size, which is the complete, non-truncated copy in practice.
function findBestEntry(grf, want) {
  let best = null;
  for (const f of grf.files) {
    if (!(f.flags & 0x01)) continue;
    if (!normalize(f.filename).endsWith(want)) continue;
    if (!best || f.uncompSize > best.uncompSize) best = f;
  }
  return best;
}

function sanitizePath(name) {
  let s = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (/^[A-Za-z]:/.test(s)) s = s.slice(2).replace(/^\/+/, "");
  if (!s) return null;
  for (const part of s.split("/")) {
    if (part === ".." || part === ".") return null;
  }
  return s;
}

function decodeName(bytes) {
  try {
    return new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// GRF reader (versions 0x101, 0x103, 0x200, and custom 0x300 forks)
// ---------------------------------------------------------------------------

function openGrf(path) {
  const fd = openSync(path, "r");
  const fileSize = fstatSync(fd).size;

  const header = Buffer.alloc(0x2e);
  readAt(fd, header, 0);
  const magic = header.toString("ascii", 0, 16).replace(/\0.*$/, "");
  console.error(`Magic: "${magic}"`);
  const filetableOffset = header.readUInt32LE(0x1e);
  const m1 = header.readUInt32LE(0x22);
  const m2 = header.readUInt32LE(0x26);
  const version = header.readUInt32LE(0x2a);
  const fileCount = m2 - m1 - 7;
  console.error(
    `GRF version 0x${version.toString(16)}, ${fileCount} files (~${(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB), table at 0x${filetableOffset.toString(16)}`,
  );

  let files;
  if (version === 0x200) {
    files = readFileTableV200(fd, 0x2e + filetableOffset);
  } else if (version === 0x300) {
    // Custom forks (Event Horizon etc.) — 4-byte gap before the compressed
    // table and a 21-byte entry trailer (extra u32 vs v0x200).
    files = readFileTableV200(fd, 0x32 + filetableOffset, 21);
  } else if (version === 0x103 || version === 0x101) {
    files = readFileTableV103(fd, 0x2e + filetableOffset, fileCount, fileSize);
  } else {
    closeSync(fd);
    throw new Error(`Unsupported GRF version 0x${version.toString(16)}`);
  }
  return { fd, fileSize, version, files };
}

function readAt(fd, buf, position) {
  let read = 0;
  while (read < buf.length) {
    const n = readSync(fd, buf, read, buf.length - read, position + read);
    if (n <= 0) break;
    read += n;
  }
  return read;
}

function readBytes(fd, length, position) {
  const buf = Buffer.alloc(length);
  readAt(fd, buf, position);
  return buf;
}

function readFileTableV200(fd, tableStart, entryTrailerBytes = 17) {
  const sizes = readBytes(fd, 8, tableStart);
  const compressedSize = sizes.readUInt32LE(0);
  const uncompressedSize = sizes.readUInt32LE(4);
  const compressed = readBytes(fd, compressedSize, tableStart + 8);
  const table = inflateSync(compressed);
  if (table.length !== uncompressedSize) {
    console.warn(`! filetable inflate size ${table.length} != expected ${uncompressedSize}`);
  }
  const files = [];
  let p = 0;
  while (p < table.length) {
    const nullIdx = table.indexOf(0, p);
    if (nullIdx < 0) break;
    const filename = decodeName(table.subarray(p, nullIdx));
    p = nullIdx + 1;
    if (p + entryTrailerBytes > table.length) break;
    const compSize = table.readUInt32LE(p);
    const compSizeAligned = table.readUInt32LE(p + 4);
    const uncompSize = table.readUInt32LE(p + 8);
    const flags = table.readUInt8(p + 12);
    // The 0x300 "Event Horizon" fork stores a 64-bit data offset (its 21-byte
    // trailer = the standard 17 + a high u32), so files appended past the 4 GB
    // mark — recent patches — resolve correctly. v0x200 is 32-bit.
    const offsetLow = table.readUInt32LE(p + 13);
    const offsetHigh = entryTrailerBytes >= 21 ? table.readUInt32LE(p + 17) : 0;
    const offset = offsetHigh * 0x100000000 + offsetLow;
    p += entryTrailerBytes;
    files.push({ filename, compSize, compSizeAligned, uncompSize, flags, offset });
  }
  return files;
}

function readFileTableV103(fd, tableStart, fileCount, fileSize) {
  const buf = readBytes(fd, fileSize - tableStart, tableStart);
  const files = [];
  let p = 0;
  for (let i = 0; i < fileCount && p < buf.length; i++) {
    const len = buf.readUInt32LE(p);
    p += 4;
    const filename = decodeName(buf.subarray(p + 2, p + 2 + len - 6));
    p += len;
    if (p + 17 > buf.length) break;
    const compSize = buf.readUInt32LE(p);
    const compSizeAligned = buf.readUInt32LE(p + 4);
    const uncompSize = buf.readUInt32LE(p + 8);
    const flags = buf.readUInt8(p + 12);
    const offset = buf.readUInt32LE(p + 13);
    p += 17;
    files.push({ filename, compSize, compSizeAligned, uncompSize, flags, offset });
  }
  return files;
}

// ---------------------------------------------------------------------------
// GRF DES decryption — Ragnarok's custom single-round DES with block cycling
// and a byte shuffle. Ported from grf-loader (vthibault/grf-loader, MIT).
// Encrypted entries are flagged ENC_MIXED (0x02 — header DES + periodic
// DES/shuffle) or ENC_HEADER (0x04 — first 20 blocks DES only). Both operate
// on the *compressed* bytes in place, before inflate.
// ---------------------------------------------------------------------------

const DES_MASK = new Uint8Array([0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01]);
const _t = new Uint8Array(8);
const _t2 = new Uint8Array(8);
const _zero = new Uint8Array(8);

// prettier-ignore
const DES_IP = new Uint8Array([
  58,50,42,34,26,18,10,2, 60,52,44,36,28,20,12,4,
  62,54,46,38,30,22,14,6, 64,56,48,40,32,24,16,8,
  57,49,41,33,25,17,9,1,  59,51,43,35,27,19,11,3,
  61,53,45,37,29,21,13,5, 63,55,47,39,31,23,15,7,
]);
// prettier-ignore
const DES_FP = new Uint8Array([
  40,8,48,16,56,24,64,32, 39,7,47,15,55,23,63,31,
  38,6,46,14,54,22,62,30, 37,5,45,13,53,21,61,29,
  36,4,44,12,52,20,60,28, 35,3,43,11,51,19,59,27,
  34,2,42,10,50,18,58,26, 33,1,41,9,49,17,57,25,
]);
// prettier-ignore
const DES_TP = new Uint8Array([
  16,7,20,21, 29,12,28,17, 1,15,23,26, 5,18,31,10,
  2,8,24,14,  32,27,3,9,   19,13,30,6,  22,11,4,25,
]);
// prettier-ignore
const DES_SBOX = [
  new Uint8Array([
    0xef,0x03,0x41,0xfd,0xd8,0x74,0x1e,0x47, 0x26,0xef,0xfb,0x22,0xb3,0xd8,0x84,0x1e,
    0x39,0xac,0xa7,0x60,0x62,0xc1,0xcd,0xba, 0x5c,0x96,0x90,0x59,0x05,0x3b,0x7a,0x85,
    0x40,0xfd,0x1e,0xc8,0xe7,0x8a,0x8b,0x21, 0xda,0x43,0x64,0x9f,0x2d,0x14,0xb1,0x72,
    0xf5,0x5b,0xc8,0xb6,0x9c,0x37,0x76,0xec, 0x39,0xa0,0xa3,0x05,0x52,0x6e,0x0f,0xd9,
  ]),
  new Uint8Array([
    0xa7,0xdd,0x0d,0x78,0x9e,0x0b,0xe3,0x95, 0x60,0x36,0x36,0x4f,0xf9,0x60,0x5a,0xa3,
    0x11,0x24,0xd2,0x87,0xc8,0x52,0x75,0xec, 0xbb,0xc1,0x4c,0xba,0x24,0xfe,0x8f,0x19,
    0xda,0x13,0x66,0xaf,0x49,0xd0,0x90,0x06, 0x8c,0x6a,0xfb,0x91,0x37,0x8d,0x0d,0x78,
    0xbf,0x49,0x11,0xf4,0x23,0xe5,0xce,0x3b, 0x55,0xbc,0xa2,0x57,0xe8,0x22,0x74,0xce,
  ]),
  new Uint8Array([
    0x2c,0xea,0xc1,0xbf,0x4a,0x24,0x1f,0xc2, 0x79,0x47,0xa2,0x7c,0xb6,0xd9,0x68,0x15,
    0x80,0x56,0x5d,0x01,0x33,0xfd,0xf4,0xae, 0xde,0x30,0x07,0x9b,0xe5,0x83,0x9b,0x68,
    0x49,0xb4,0x2e,0x83,0x1f,0xc2,0xb5,0x7c, 0xa2,0x19,0xd8,0xe5,0x7c,0x2f,0x83,0xda,
    0xf7,0x6b,0x90,0xfe,0xc4,0x01,0x5a,0x97, 0x61,0xa6,0x3d,0x40,0x0b,0x58,0xe6,0x3d,
  ]),
  new Uint8Array([
    0x4d,0xd1,0xb2,0x0f,0x28,0xbd,0xe4,0x78, 0xf6,0x4a,0x0f,0x93,0x8b,0x17,0xd1,0xa4,
    0x3a,0xec,0xc9,0x35,0x93,0x56,0x7e,0xcb, 0x55,0x20,0xa0,0xfe,0x6c,0x89,0x17,0x62,
    0x17,0x62,0x4b,0xb1,0xb4,0xde,0xd1,0x87, 0xc9,0x14,0x3c,0x4a,0x7e,0xa8,0xe2,0x7d,
    0xa0,0x9f,0xf6,0x5c,0x6a,0x09,0x8d,0xf0, 0x0f,0xe3,0x53,0x25,0x95,0x36,0x28,0xcb,
  ]),
];

const DES_SHUFFLE = (() => {
  const list = new Uint8Array([
    0x00, 0x2b, 0x6c, 0x80, 0x01, 0x68, 0x48,
    0x77, 0x60, 0xff, 0xb9, 0xc0, 0xfe, 0xeb,
  ]);
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) out[i] = i;
  for (let i = 0; i < list.length; i += 2) {
    out[list[i]] = list[i + 1];
    out[list[i + 1]] = list[i];
  }
  return out;
})();

function desInitialPerm(src, index) {
  for (let i = 0; i < 64; ++i) {
    const j = DES_IP[i] - 1;
    if (src[index + ((j >> 3) & 7)] & DES_MASK[j & 7]) _t[(i >> 3) & 7] |= DES_MASK[i & 7];
  }
  src.set(_t, index);
  _t.set(_zero);
}

function desFinalPerm(src, index) {
  for (let i = 0; i < 64; ++i) {
    const j = DES_FP[i] - 1;
    if (src[index + ((j >> 3) & 7)] & DES_MASK[j & 7]) _t[(i >> 3) & 7] |= DES_MASK[i & 7];
  }
  src.set(_t, index);
  _t.set(_zero);
}

function desTransposition(src, index) {
  for (let i = 0; i < 32; ++i) {
    const j = DES_TP[i] - 1;
    if (src[index + (j >> 3)] & DES_MASK[j & 7]) _t[(i >> 3) + 4] |= DES_MASK[i & 7];
  }
  src.set(_t, index);
  _t.set(_zero);
}

function desExpansion(src, index) {
  _t[0] = ((src[index + 7] << 5) | (src[index + 4] >> 3)) & 0x3f;
  _t[1] = ((src[index + 4] << 1) | (src[index + 5] >> 7)) & 0x3f;
  _t[2] = ((src[index + 4] << 5) | (src[index + 5] >> 3)) & 0x3f;
  _t[3] = ((src[index + 5] << 1) | (src[index + 6] >> 7)) & 0x3f;
  _t[4] = ((src[index + 5] << 5) | (src[index + 6] >> 3)) & 0x3f;
  _t[5] = ((src[index + 6] << 1) | (src[index + 7] >> 7)) & 0x3f;
  _t[6] = ((src[index + 6] << 5) | (src[index + 7] >> 3)) & 0x3f;
  _t[7] = ((src[index + 7] << 1) | (src[index + 4] >> 7)) & 0x3f;
  src.set(_t, index);
  _t.set(_zero);
}

function desSbox(src, index) {
  for (let i = 0; i < 4; ++i) {
    _t[i] =
      (DES_SBOX[i][src[i * 2 + 0 + index]] & 0xf0) |
      (DES_SBOX[i][src[i * 2 + 1 + index]] & 0x0f);
  }
  src.set(_t, index);
  _t.set(_zero);
}

function desRound(src, index) {
  for (let i = 0; i < 8; i++) _t2[i] = src[index + i];
  desExpansion(_t2, 0);
  desSbox(_t2, 0);
  desTransposition(_t2, 0);
  src[index + 0] ^= _t2[4];
  src[index + 1] ^= _t2[5];
  src[index + 2] ^= _t2[6];
  src[index + 3] ^= _t2[7];
}

function desDecryptBlock(src, index) {
  desInitialPerm(src, index);
  desRound(src, index);
  desFinalPerm(src, index);
}

function desShuffleDec(src, index) {
  _t[0] = src[index + 3];
  _t[1] = src[index + 4];
  _t[2] = src[index + 6];
  _t[3] = src[index + 0];
  _t[4] = src[index + 1];
  _t[5] = src[index + 2];
  _t[6] = src[index + 5];
  _t[7] = DES_SHUFFLE[src[index + 7]];
  src.set(_t, index);
  _t.set(_zero);
}

// ENC_MIXED: first 20 blocks DES-decrypted; thereafter every `cycle`-th block
// is DES-decrypted and every 7th remaining block is de-shuffled. `entryLength`
// is the *compressed* size and drives the cycle gap.
function desDecodeFull(src, length, entryLength) {
  const digits = entryLength.toString().length;
  const cycle =
    digits < 3 ? 1 : digits < 5 ? digits + 1 : digits < 7 ? digits + 9 : digits + 15;
  const nblocks = length >> 3;
  for (let i = 0; i < 20 && i < nblocks; ++i) desDecryptBlock(src, i * 8);
  for (let i = 20, j = -1; i < nblocks; ++i) {
    if (i % cycle === 0) {
      desDecryptBlock(src, i * 8);
      continue;
    }
    if (++j && j % 7 === 0) desShuffleDec(src, i * 8);
  }
}

// ENC_HEADER: only the first 20 blocks are DES-decrypted; the rest is plaintext.
function desDecodeHeader(src, length) {
  const count = length >> 3;
  for (let i = 0; i < 20 && i < count; ++i) desDecryptBlock(src, i * 8);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function extractFile(grf, entry) {
  const FILE_BIT = 0x01;
  const ENC_MIXED = 0x02;
  const ENC_HEADER = 0x04;
  if (!(entry.flags & FILE_BIT)) return new Uint8Array(0);
  const raw = readBytes(grf.fd, entry.compSizeAligned, 0x2e + entry.offset);
  if (entry.flags & ENC_MIXED) desDecodeFull(raw, entry.compSizeAligned, entry.compSize);
  else if (entry.flags & ENC_HEADER) desDecodeHeader(raw, entry.compSizeAligned);
  // Stored (not deflated) when compressed size == real size.
  if (entry.uncompSize === entry.compSize) return raw;
  return inflateSync(raw);
}

function closeGrf(grf) {
  if (grf?.fd != null) closeSync(grf.fd);
}

function extractAll(grfPath, outDir, matchPattern) {
  const grf = openGrf(grfPath);
  const re = matchPattern ? new RegExp(matchPattern, "i") : null;
  const root = resolve(outDir);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  const startedAt = Date.now();
  let written = 0;
  let skipped = 0;
  let encrypted = 0;
  let bytes = 0;

  try {
    let lastReportAt = startedAt;
    for (let i = 0; i < grf.files.length; i++) {
      const entry = grf.files[i];
      if (!(entry.flags & 0x01)) continue;
      if (re && !re.test(entry.filename)) continue;
      if (entry.flags & 0x06) encrypted++; // decrypted in extractFile; just track count

      const safe = sanitizePath(entry.filename);
      if (!safe) {
        skipped++;
        continue;
      }
      const dest = join(root, safe);
      const dir = dirname(dest);
      try {
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
        const data = extractFile(grf, entry);
        writeFileSync(dest, data);
        written++;
        bytes += data.length;
      } catch {
        skipped++;
      }

      const now = Date.now();
      if (now - lastReportAt > 2000) {
        const pct = ((i / grf.files.length) * 100).toFixed(1);
        console.error(
          `  [${pct}%] ${written} written, ${skipped} skipped, ${encrypted} encrypted, ${(bytes / 1e6).toFixed(0)} MB`,
        );
        lastReportAt = now;
      }
    }
  } finally {
    closeGrf(grf);
  }

  const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(
    `\nExtracted ${written} file(s), ${(bytes / 1e9).toFixed(2)} GB to ${root} in ${dur}s.`,
  );
  if (encrypted) console.error(`Decrypted ${encrypted} encrypted file(s).`);
  if (skipped) console.error(`Skipped ${skipped} unreadable/invalid file(s).`);
}

// ---------------------------------------------------------------------------
// Minimal Lua 5.1 bytecode VM — just enough to execute the Ragnarok client's
// data-table chunks (System/iteminfo_new.lub, skillid.lub, etc.). These files
// are pure table constructors assigned to globals: no loops, branches, or
// arithmetic, so we only implement the opcodes they actually use and throw on
// anything unexpected. Run a chunk and read the resulting globals.
//
// String constants are kept as latin1 (1:1 byte<->codepoint) so the caller can
// re-decode the original bytes with the right charset (client data mixes CP1252
// Portuguese with EUC-KR Korean). See decodeClientString().
//
// Inlined from adsonpleal/ragreplaystats (tools/lua51.mjs).
// ---------------------------------------------------------------------------

// Lua 5.1 opcode numbers (lopcodes.h order).
// prettier-ignore
const OP = {
  MOVE: 0, LOADK: 1, LOADBOOL: 2, LOADNIL: 3, GETUPVAL: 4, GETGLOBAL: 5,
  GETTABLE: 6, SETGLOBAL: 7, SETUPVAL: 8, SETTABLE: 9, NEWTABLE: 10, SELF: 11,
  ADD: 12, SUB: 13, MUL: 14, DIV: 15, MOD: 16, POW: 17, UNM: 18, NOT: 19,
  LEN: 20, CONCAT: 21, JMP: 22, EQ: 23, LT: 24, LE: 25, TEST: 26, TESTSET: 27,
  CALL: 28, TAILCALL: 29, RETURN: 30, FORLOOP: 31, FORPREP: 32, TFORLOOP: 33,
  SETLIST: 34, CLOSE: 35, CLOSURE: 36, VARARG: 37,
};
const FIELDS_PER_FLUSH = 50;
const BITRK = 1 << 8;

class LuaTable {
  constructor() {
    this.map = new Map();
  }
  set(k, v) {
    if (v === undefined || v === null) this.map.delete(k);
    else this.map.set(k, v);
  }
  get(k) {
    return this.map.get(k);
  }
}

function loadChunk(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf[0] !== 0x1b || buf[1] !== 0x4c || buf[2] !== 0x75 || buf[3] !== 0x61)
    throw new Error("not a Lua chunk");
  if (buf[4] !== 0x51) throw new Error(`unsupported Lua version 0x${buf[4].toString(16)}`);
  const c = {
    buf,
    pos: 12,
    sizeofInt: buf[7],
    sizeofSizeT: buf[8],
    sizeofInstr: buf[9],
    sizeofNumber: buf[10],
  };
  if (c.sizeofInstr !== 4) throw new Error("only 4-byte instructions supported");
  return readProto(c);
}

function readUInt(c, n) {
  let val = 0;
  for (let i = 0; i < n; i++) val += c.buf[c.pos + i] * 2 ** (8 * i);
  c.pos += n;
  return val;
}

function readString(c) {
  const len = readUInt(c, c.sizeofSizeT);
  if (len === 0) return null;
  const start = c.pos;
  c.pos += len;
  return c.buf.toString("latin1", start, start + len - 1); // drop trailing \0
}

function readProto(c) {
  readString(c); // source name
  c.pos += c.sizeofInt; // line defined
  c.pos += c.sizeofInt; // last line defined
  c.pos += 4; // nups, numparams, is_vararg, maxstacksize

  const sizecode = readUInt(c, c.sizeofInt);
  const code = new Array(sizecode);
  for (let i = 0; i < sizecode; i++) {
    code[i] = c.buf.readUInt32LE(c.pos);
    c.pos += 4;
  }

  const sizek = readUInt(c, c.sizeofInt);
  const k = new Array(sizek);
  for (let i = 0; i < sizek; i++) {
    const type = c.buf[c.pos++];
    if (type === 0) k[i] = undefined;
    else if (type === 1) k[i] = c.buf[c.pos++] !== 0;
    else if (type === 3) {
      k[i] = c.buf.readDoubleLE(c.pos);
      c.pos += 8;
    } else if (type === 4) k[i] = readString(c);
    else throw new Error(`unknown constant type ${type}`);
  }

  const sizep = readUInt(c, c.sizeofInt);
  const protos = new Array(sizep);
  for (let i = 0; i < sizep; i++) protos[i] = readProto(c);

  // debug blocks — skip
  const lineInfo = readUInt(c, c.sizeofInt);
  c.pos += lineInfo * c.sizeofInt;
  const locals = readUInt(c, c.sizeofInt);
  for (let i = 0; i < locals; i++) {
    readString(c);
    c.pos += c.sizeofInt * 2;
  }
  const upvals = readUInt(c, c.sizeofInt);
  for (let i = 0; i < upvals; i++) readString(c);

  return { code, k, protos };
}

// Executes a single proto over a shared globals table.
function execute(proto, globals) {
  const R = [];
  const K = proto.k;
  const rk = (x) => (x & BITRK ? K[x & (BITRK - 1)] : R[x]);
  let pc = 0;
  while (pc < proto.code.length) {
    const i = proto.code[pc++];
    const op = i & 0x3f;
    const a = (i >>> 6) & 0xff;
    const c = (i >>> 14) & 0x1ff;
    const b = (i >>> 23) & 0x1ff;
    const bx = (i >>> 14) & 0x3ffff;

    switch (op) {
      case OP.MOVE: R[a] = R[b]; break;
      case OP.LOADK: R[a] = K[bx]; break;
      case OP.LOADBOOL: R[a] = b !== 0; if (c) pc++; break;
      case OP.LOADNIL: for (let r = a; r <= b; r++) R[r] = undefined; break;
      case OP.GETGLOBAL: R[a] = globals.get(K[bx]); break;
      case OP.SETGLOBAL: globals.set(K[bx], R[a]); break;
      case OP.NEWTABLE: R[a] = new LuaTable(); break;
      case OP.GETTABLE: {
        const t = R[b];
        R[a] = t instanceof LuaTable ? t.get(rk(c)) : undefined;
        break;
      }
      case OP.SETTABLE: {
        const t = R[a];
        if (t instanceof LuaTable) t.set(rk(b), rk(c));
        break;
      }
      case OP.SETLIST: {
        let n = b;
        let block = c;
        if (block === 0) block = proto.code[pc++]; // real C in next word
        if (n === 0) throw new Error("SETLIST with B=0 (vararg) not supported");
        const base = (block - 1) * FIELDS_PER_FLUSH;
        const t = R[a];
        for (let j = 1; j <= n; j++) t.set(base + j, R[a + j]);
        break;
      }
      case OP.CLOSURE: {
        // Represent nested closures as their proto; calling is a no-op below.
        R[a] = { __proto_index: bx, proto: proto.protos[bx] };
        // CLOSURE is followed by `nups` pseudo-instructions (MOVE/GETUPVAL);
        // skip them so we don't misread them as real ops.
        // We don't track nups here, but data chunks have no upvalue captures
        // on these closures, so there is nothing to skip in practice.
        break;
      }
      case OP.CALL: break; // ignore calls — data chunks build tables, not effects
      case OP.TAILCALL: break;
      case OP.RETURN: return; // end of chunk
      case OP.JMP: break; // no real branching in data chunks
      default:
        throw new Error(`unimplemented opcode ${op} at pc ${pc - 1}`);
    }
  }
}

// Run a Lua 5.1 chunk over an existing globals table (so dependent chunks can
// share state); runChunk starts from a fresh one.
function runChunkInto(bytes, globals) {
  execute(loadChunk(bytes), globals);
  return globals;
}

function runChunk(bytes) {
  return runChunkInto(bytes, new LuaTable());
}

// Client strings are CP1252 (Portuguese) or EUC-KR (Korean, untranslated). The
// VM keeps them as latin1, so recover the bytes and pick the charset: prefer a
// clean EUC-KR decode that yields Hangul, else fall back to Windows-1252.
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const EUCKR = new TextDecoder("euc-kr", { fatal: true });
const CP1252 = new TextDecoder("windows-1252");
function decodeClientString(latin1) {
  if (latin1 == null) return null;
  const bytes = Buffer.from(latin1, "latin1");
  if (!bytes.some((x) => x >= 0x80)) return latin1; // pure ASCII
  // The patched iteminfo_new.lub is UTF-8; a strict decode succeeds only for
  // genuine UTF-8 and cleanly covers both Portuguese and Korean. Legacy strings
  // fall back: EUC-KR for pure-Hangul names, else CP1252.
  try {
    return UTF8.decode(bytes);
  } catch {
    /* not UTF-8 */
  }
  if (!/[A-Za-z]/.test(latin1)) {
    try {
      return EUCKR.decode(bytes);
    } catch {
      /* fall through to CP1252 */
    }
  }
  return CP1252.decode(bytes);
}

// ---------------------------------------------------------------------------
// Icon id mapping — items come from System/iteminfo_new.lub (a sibling of
// data.grf), skills from skillid.lub inside the GRF.
// ---------------------------------------------------------------------------

// Allow an explicit override via --iteminfo; otherwise look next to the GRF.
function resolveItemInfoPath(args) {
  if (args.iteminfo) return existsSync(args.iteminfo) ? args.iteminfo : null;
  const root = join(dirname(resolve(args.grf)), "System");
  for (const name of ["iteminfo_new.lub", "itemInfo.lub", "iteminfo.lub"]) {
    const p = join(root, name);
    // Skip the tiny stub itemInfo.lub (a few hundred bytes that just chains
    // to the real table).
    if (existsSync(p) && statSync(p).size > 4096) return p;
  }
  return null;
}

// id -> icon resource name (lowercased). The live System/iteminfo_new.lub is
// authoritative and complete (modern equipment like 450147 = "Illusion_Armor_A"
// is only there).
function buildResNameMap(args) {
  const out = new Map();
  const lubPath = resolveItemInfoPath(args);
  if (!lubPath) {
    throw new Error(
      "iteminfo_new.lub not found next to the GRF (System/) — pass --iteminfo <path>",
    );
  }
  const tbl = runChunk(readFileSync(lubPath)).get("tbl");
  if (tbl instanceof LuaTable) {
    for (const [id, entry] of tbl.map) {
      if (typeof id !== "number" || !(entry instanceof LuaTable)) continue;
      const res =
        decodeClientString(entry.get("identifiedResourceName")) ||
        decodeClientString(entry.get("unidentifiedResourceName"));
      if (res) out.set(String(id), res.toLowerCase());
    }
  }
  return out;
}

// SKID const -> numeric id, from executing skillid.lub (it defines the SKID
// table). Skill icons live in the item folder named after the lowercased
// const (e.g. SKID.AL_HEAL = 28 -> item/al_heal.bmp -> skill/28.png).
function parseSkillIds(map) {
  const ids = new Map();
  const bytes =
    map.get("data/luafiles514/lua files/skillinfoz/skillid.lub") ??
    map.get("data/luafiles514/lua files/skillinfoz/skillid.lua");
  if (!bytes) return ids;
  try {
    const skid = runChunk(bytes).get("SKID");
    if (skid instanceof LuaTable) {
      for (const [konst, id] of skid.map) {
        if (typeof konst === "string" && typeof id === "number") ids.set(konst, id);
      }
    }
  } catch (err) {
    console.error(`! skillid.lub could not be executed (${err.message}); skipping skill icons`);
  }
  return ids;
}

// EFST status-effect id -> icon filename. efstids.lub defines the global
// EFST_IDs (name -> numeric id); stateiconimginfo.lub then builds
// StateIconImgList[priority][EFST_IDs[name]] = "<file>.tga", so it must run over
// the SAME globals AFTER efstids for those lookups to resolve. We flatten the
// per-priority sub-tables down to id -> filename (the filename is a client
// string — EUC-KR for the Korean names — resolved against the GRF later).
function parseStatusIcons(map) {
  const out = new Map();
  const efst = map.get("data/luafiles514/lua files/stateicon/efstids.lub");
  const img = map.get("data/luafiles514/lua files/stateicon/stateiconimginfo.lub");
  if (!efst || !img) {
    console.error("! stateicon lua tables not found in GRF; skipping status icons");
    return out;
  }
  try {
    const globals = new LuaTable();
    runChunkInto(efst, globals);
    runChunkInto(img, globals);
    const list = globals.get("StateIconImgList");
    if (list instanceof LuaTable) {
      for (const [, sub] of list.map) {
        if (!(sub instanceof LuaTable)) continue;
        for (const [id, file] of sub.map) {
          if (typeof id === "number" && typeof file === "string" && file) out.set(id, file);
        }
      }
    }
  } catch (err) {
    console.error(`! stateicon tables could not be executed (${err.message}); skipping status icons`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// BMP -> PNG conversion. RO icons are uncompressed BMPs (8-bit palettized,
// some 24/32-bit) that use magenta #FF00FF as the transparency colorkey. We
// decode to RGBA (keying magenta -> alpha 0) and re-encode as a PNG using only
// node:zlib — no external image library. Some char-creation UI elements use a
// solid corner background instead of magenta; those are keyed separately via
// keyCornerBackground (see bmpToPng's keyCorners option).
// ---------------------------------------------------------------------------

function bmpToRgba(buf) {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 54 || b[0] !== 0x42 || b[1] !== 0x4d) return null; // "BM"
  const dataOffset = b.readUInt32LE(10);
  const dibSize = b.readUInt32LE(14);
  const w = b.readInt32LE(18);
  const rawH = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28);
  const compression = b.readUInt32LE(30);
  if (compression !== 0 || w <= 0 || rawH === 0) return null; // BI_RGB only
  const topDown = rawH < 0;
  const h = Math.abs(rawH);

  let palette = null;
  if (bpp <= 8) {
    let palCount = b.readUInt32LE(46); // biClrUsed
    if (!palCount) palCount = 1 << bpp;
    const palStart = 14 + dibSize;
    palette = new Array(palCount);
    for (let i = 0; i < palCount; i++) {
      const o = palStart + i * 4; // stored BGRA
      palette[i] = [b[o + 2], b[o + 1], b[o]];
    }
  } else if (bpp !== 24 && bpp !== 32) {
    return null; // unsupported depth
  }

  const rowSize = Math.floor((bpp * w + 31) / 32) * 4; // padded to 4 bytes
  const rgba = Buffer.alloc(w * h * 4);
  let magenta = 0; // count of colorkeyed pixels (used to pick the alpha strategy)
  for (let row = 0; row < h; row++) {
    const srcRow = topDown ? row : h - 1 - row; // BMP rows are bottom-up
    const srcBase = dataOffset + srcRow * rowSize;
    for (let x = 0; x < w; x++) {
      let r, g, bl;
      if (bpp === 8) {
        const p = palette[b[srcBase + x]] || [0, 0, 0];
        [r, g, bl] = p;
      } else if (bpp === 4) {
        const byte = b[srcBase + (x >> 1)];
        const p = palette[x & 1 ? byte & 0x0f : byte >> 4] || [0, 0, 0];
        [r, g, bl] = p;
      } else if (bpp === 1) {
        const byte = b[srcBase + (x >> 3)];
        const p = palette[(byte >> (7 - (x & 7))) & 1] || [0, 0, 0];
        [r, g, bl] = p;
      } else if (bpp === 24) {
        const o = srcBase + x * 3;
        bl = b[o]; g = b[o + 1]; r = b[o + 2];
      } else {
        const o = srcBase + x * 4; // 32bpp BGRA — ignore stored alpha
        bl = b[o]; g = b[o + 1]; r = b[o + 2];
      }
      const di = (row * w + x) * 4;
      rgba[di] = r;
      rgba[di + 1] = g;
      rgba[di + 2] = bl;
      const isMagenta = r === 255 && g === 0 && bl === 255;
      if (isMagenta) magenta++;
      rgba[di + 3] = isMagenta ? 0 : 255; // magenta key
    }
  }
  return { width: w, height: h, rgba, magenta };
}

// Some bitmaps don't use the magenta colorkey at all but sit on a solid
// background that fills the area outside their (rounded) artwork — e.g. the
// character-creation gender/arrow buttons, whose corners are a pale pink/grey
// rather than #FF00FF. Make that background transparent by flood-filling inward
// from the four corners: each corner seeds its own colour and connected pixels
// within TOL of that seed are keyed. Connectivity (vs. a global colour match)
// keeps interior pixels that merely happen to share the corner colour. If the
// fill would swallow most of the image the corner colour was the artwork's own
// fill (e.g. the white close button), so it's reverted and left opaque.
const CORNER_TOL = 24; // max per-channel Manhattan distance from the corner seed
const CORNER_GUARD = 0.5; // abort the fill if it would key >= this fraction

function keyCornerBackground(width, height, rgba) {
  const seen = new Uint8Array(width * height);
  const keyed = [];
  const stack = [];
  for (const [sx, sy] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
    const si = (sy * width + sx) * 4;
    stack.push([sx, sy, rgba[si], rgba[si + 1], rgba[si + 2]]);
  }
  while (stack.length) {
    const [x, y, sr, sg, sb] = stack.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const idx = y * width + x;
    if (seen[idx]) continue;
    const o = idx * 4;
    if (Math.abs(rgba[o] - sr) + Math.abs(rgba[o + 1] - sg) + Math.abs(rgba[o + 2] - sb) > CORNER_TOL)
      continue;
    seen[idx] = 1;
    rgba[o + 3] = 0;
    keyed.push(o);
    stack.push([x + 1, y, sr, sg, sb], [x - 1, y, sr, sg, sb], [x, y + 1, sr, sg, sb], [x, y - 1, sr, sg, sb]);
  }
  if (keyed.length >= width * height * CORNER_GUARD) {
    for (const o of keyed) rgba[o + 3] = 255; // not a background border — revert
  }
}

const PNG_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = PNG_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10..12 = compression / filter / interlace = 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function bmpToPng(bmpBytes, opts = {}) {
  const decoded = bmpToRgba(bmpBytes);
  if (!decoded) return null;
  // For UI elements that carry no magenta colorkey, derive transparency from the
  // solid corner background instead (gender/arrow/etc. buttons).
  if (opts.keyCorners && decoded.magenta === 0) {
    keyCornerBackground(decoded.width, decoded.height, decoded.rgba);
  }
  return encodePng(decoded.width, decoded.height, decoded.rgba);
}

// Status (EFST) icons ship as TARGA rather than BMP. They are uncompressed
// true-colour (24/32-bit BGR(A)); 32-bit carries a real alpha channel while
// 24-bit is fully opaque. Decode to RGBA and re-use the PNG encoder. RLE
// (image type 10) is handled too, in case a future client patch uses it.
function tgaToRgba(buf) {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 18) return null;
  const idLen = b[0];
  const colorMapType = b[1];
  const imageType = b[2];
  if (colorMapType !== 0 || (imageType !== 2 && imageType !== 10)) return null; // truecolor only
  const w = b.readUInt16LE(12);
  const h = b.readUInt16LE(14);
  const bpp = b[16];
  const desc = b[17];
  if (w <= 0 || h <= 0 || (bpp !== 24 && bpp !== 32)) return null;
  const bytesPP = bpp / 8;
  const topDown = (desc & 0x20) !== 0; // bit 5: 1 = top-left origin, else bottom-up
  let p = 18 + idLen; // no color map (colorMapType 0), so skip only the image id field
  const px = w * h;
  const src = Buffer.alloc(px * bytesPP); // pixels in stored (row) order
  if (imageType === 2) {
    if (p + px * bytesPP > b.length) return null;
    b.copy(src, 0, p, p + px * bytesPP);
  } else {
    let o = 0; // RLE: alternating run-length (0x80 bit) and raw packets
    while (o < src.length && p < b.length) {
      const count = (b[p++] & 0x7f) + 1;
      if (b[p - 1] & 0x80) {
        for (let i = 0; i < count && o < src.length; i++, o += bytesPP) b.copy(src, o, p, p + bytesPP);
        p += bytesPP;
      } else {
        const n = count * bytesPP;
        b.copy(src, o, p, p + n);
        o += n;
        p += n;
      }
    }
  }
  const rgba = Buffer.alloc(px * 4);
  for (let row = 0; row < h; row++) {
    const srcRow = topDown ? row : h - 1 - row;
    for (let x = 0; x < w; x++) {
      const so = (srcRow * w + x) * bytesPP;
      const di = (row * w + x) * 4;
      rgba[di] = src[so + 2]; // stored BGR(A)
      rgba[di + 1] = src[so + 1];
      rgba[di + 2] = src[so];
      rgba[di + 3] = bpp === 32 ? src[so + 3] : 255;
    }
  }
  return { width: w, height: h, rgba };
}

function tgaToPng(tgaBytes) {
  const decoded = tgaToRgba(tgaBytes);
  if (!decoded) return null;
  return encodePng(decoded.width, decoded.height, decoded.rgba);
}

// Bleed opaque colours outward into transparent pixels (alpha stays 0). The
// magenta colorkey leaves transparent texels with magenta RGB; under bilinear
// filtering / mipmaps those values bleed back in as pink fringes. Replacing each
// transparent texel's RGB with its nearest opaque neighbour's (a multi-source
// BFS) removes the halos. Used for the effect textures (the map sim filters them
// bilinearly); the icon pipeline keeps its texels as-is.
function bleedTransparent(width, height, rgba) {
  const total = width * height;
  const filled = new Uint8Array(total);
  let queue = [];
  for (let i = 0; i < total; i++) {
    if (rgba[i * 4 + 3] !== 0) {
      filled[i] = 1;
      queue.push(i);
    }
  }
  if (queue.length === 0 || queue.length === total) return; // all/none transparent
  while (queue.length) {
    const next = [];
    for (const p of queue) {
      const px = p % width;
      const po = p * 4;
      const cands = [];
      if (px > 0) cands.push(p - 1);
      if (px < width - 1) cands.push(p + 1);
      if (p - width >= 0) cands.push(p - width);
      if (p + width < total) cands.push(p + width);
      for (const q of cands) {
        if (filled[q]) continue;
        filled[q] = 1;
        const qo = q * 4;
        rgba[qo] = rgba[po];
        rgba[qo + 1] = rgba[po + 1];
        rgba[qo + 2] = rgba[po + 2]; // copy RGB only; alpha stays 0
        next.push(q);
      }
    }
    queue = next;
  }
}

// Convert a .str-referenced texture (BMP or TGA) to a transparent PNG for the map
// effect renderer. TGA keeps its 32-bit alpha (glow textures); BMP is magenta
// (#FF00FF) colorkeyed; both then get their transparent RGB bled to kill fringes.
// Returns null for unsupported encodings (caller logs + skips). Mirrors the POC
// latamvisuais/tools/bmp.mjs textureToPng so its output is byte-identical.
function effectTextureToPng(bytes, name) {
  const isTga = /\.tga$/i.test(name);
  const decoded = isTga ? tgaToRgba(bytes) : bmpToRgba(bytes);
  if (!decoded) return null;
  bleedTransparent(decoded.width, decoded.height, decoded.rgba);
  return encodePng(decoded.width, decoded.height, decoded.rgba);
}

// ---------------------------------------------------------------------------
// Icon extraction — decodes each BMP to a transparent PNG keyed by numeric id:
//   <out>/item/<id>.png        inventory icon    (item\<resname>.bmp)
//   <out>/collection/<id>.png  description image (collection\<resname>.bmp)
//   <out>/skill/<id>.png       skill icon        (item\<skid-const>.bmp)
//   <out>/job/<id>.png         class icon        (renewalparty\icon_jobs_<id>.bmp)
//   <out>/status/<id>.png      EFST status icon  (texture\effect\<file>.tga)
//   <out>/ui/<name>.png        char-creation UI  (make_character_ver2\<name>.bmp)
// resnames come from System/iteminfo_new.lub; skill icon filenames are the
// lowercased SKID constant. Magenta (#FF00FF) is mapped to transparent; UI
// elements with no magenta key instead derive transparency from their corner
// background (keyCornerBackground), which fixes the gender/arrow buttons.
// ---------------------------------------------------------------------------

const UI = "data/texture/유저인터페이스"; // "user interface" texture root

// Character-creation UI elements (gender/turn buttons, hair style thumbnails,
// hair color swatches, race images) served by basename under the `ui` kind.
const UI_DIR = `${UI}/make_character_ver2/`;

function indexIcons(grf) {
  // normalized filename -> best entry, limited to the icon folders we need.
  const idx = new Map();
  const itemDir = `${UI}/item/`;
  const collDir = `${UI}/collection/`;
  const jobPrefix = `${UI}/renewalparty/icon_jobs_`;
  for (const f of grf.files) {
    if (!(f.flags & 0x01)) continue;
    const n = normalize(f.filename);
    if (!n.endsWith(".bmp")) continue;
    if (
      !n.startsWith(itemDir) &&
      !n.startsWith(collDir) &&
      !n.startsWith(jobPrefix) &&
      !n.startsWith(UI_DIR)
    )
      continue;
    const prev = idx.get(n);
    if (!prev || f.uncompSize > prev.uncompSize) idx.set(n, f);
  }
  return idx;
}

function extractIcons(grfPath, outBase, args) {
  const grf = openGrf(grfPath);
  try {
    const root = resolve(outBase);
    const dirs = {
      item: join(root, "item"),
      collection: join(root, "collection"),
      skill: join(root, "skill"),
      job: join(root, "job"),
      status: join(root, "status"),
      ui: join(root, "ui"),
    };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

    console.error("Indexing icon entries…");
    const idx = indexIcons(grf);
    console.error(`  ${idx.size} icon files indexed`);

    const counts = { item: 0, collection: 0, skill: 0, job: 0, status: 0, ui: 0 };
    const fails = { extract: 0, convert: 0 };
    const writeIcon = (kind, id, entry) => {
      let bmp;
      try {
        bmp = extractFile(grf, entry);
      } catch {
        fails.extract++;
        return false;
      }
      const png = bmpToPng(bmp, { keyCorners: kind === "ui" });
      if (!png) {
        fails.convert++;
        return false;
      }
      writeFileSync(join(dirs[kind], `${id}.png`), png);
      counts[kind]++;
      return true;
    };

    // Item inventory + collection icons, keyed by resource name.
    const resNames = buildResNameMap(args);
    for (const [id, res] of resNames) {
      const itemEntry = idx.get(`${UI}/item/${res}.bmp`);
      if (itemEntry) writeIcon("item", id, itemEntry);
      const collEntry = idx.get(`${UI}/collection/${res}.bmp`);
      if (collEntry) writeIcon("collection", id, collEntry);
    }

    // Skill icons share the item folder, named after the lowercased SKID const.
    const fileMap = collectGrfFiles(grf, [
      "data/luafiles514/lua files/skillinfoz/skillid.lub",
      "data/luafiles514/lua files/skillinfoz/skillid.lua",
    ]);
    const skillIds = parseSkillIds(fileMap);
    for (const [konst, id] of skillIds) {
      const entry = idx.get(`${UI}/item/${konst.toLowerCase()}.bmp`);
      if (entry) writeIcon("skill", id, entry);
    }

    // Class icons keyed directly by numeric job id (skip the _die variants).
    const jobRe = new RegExp(
      `${UI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/renewalparty/icon_jobs_(\\d+)\\.bmp$`,
    );
    const jobFailed = [];
    for (const [name, entry] of idx) {
      const m = name.match(jobRe);
      if (m && !writeIcon("job", m[1], entry)) jobFailed.push(Number(m[1]));
    }

    // Status (EFST) icons: TARGA images under data/texture/effect/, keyed by the
    // numeric EFST id from the stateicon lua tables. The mapped filename is a
    // client string (EUC-KR for Korean names), decoded the same way as GRF entry
    // names so it matches the indexed path.
    const statusMap = parseStatusIcons(
      collectGrfFiles(grf, [
        "data/luafiles514/lua files/stateicon/efstids.lub",
        "data/luafiles514/lua files/stateicon/stateiconimginfo.lub",
      ]),
    );
    if (statusMap.size) {
      const effectIdx = new Map(); // normalized effect-folder path -> best entry
      for (const f of grf.files) {
        if (!(f.flags & 0x01)) continue;
        const n = normalize(f.filename);
        if (!n.startsWith("data/texture/effect/") || !n.endsWith(".tga")) continue;
        const prev = effectIdx.get(n);
        if (!prev || f.uncompSize > prev.uncompSize) effectIdx.set(n, f);
      }
      const statusMissing = [];
      for (const [id, file] of statusMap) {
        // The lua VM keeps strings as latin1; recover the raw bytes and decode
        // them the same way GRF entry names are (EUC-KR for the Korean filenames).
        const name = decodeName(Buffer.from(file, "latin1"));
        const entry = effectIdx.get(normalize(`data/texture/effect/${name}`));
        if (!entry) {
          statusMissing.push(file);
          continue;
        }
        let tga;
        try {
          tga = extractFile(grf, entry);
        } catch {
          fails.extract++;
          continue;
        }
        const png = tgaToPng(tga);
        if (!png) {
          fails.convert++;
          continue;
        }
        writeFileSync(join(dirs.status, `${id}.png`), png);
        counts.status++;
      }
      if (statusMissing.length)
        console.error(
          `  status icons not in GRF: ${[...new Set(statusMissing)].sort().join(", ")}`,
        );
    }

    // Character-creation UI elements, keyed by their original basename
    // (bt_male_on, img_hairstyle_girl05, color03_press, ...).
    for (const [name, entry] of idx) {
      if (!name.startsWith(UI_DIR)) continue;
      const base = name.slice(UI_DIR.length, -".bmp".length);
      if (!/^[a-z0-9_]+$/.test(base)) continue; // flat lowercase names only
      writeIcon("ui", base, entry);
    }

    console.error(
      `\nIcons (PNG) → ${root}\n  item: ${counts.item}  collection: ${counts.collection}  skill: ${counts.skill}  job: ${counts.job}  status: ${counts.status}  ui: ${counts.ui}` +
        (fails.extract ? `\n  ${fails.extract} entry(s) failed to extract` : "") +
        (fails.convert ? `\n  ${fails.convert} BMP(s) skipped (unsupported encoding)` : ""),
    );
    if (jobFailed.length)
      console.error(`  job ids not written: ${jobFailed.sort((a, b) => a - b).join(", ")}`);
  } finally {
    closeGrf(grf);
  }
}

// Pull a small set of named files from an already-open GRF into a name->bytes
// map (keyed by the wanted path), without reopening the archive.
function collectGrfFiles(grf, wants) {
  const map = new Map();
  for (const want of wants) {
    const entry = findBestEntry(grf, want);
    if (entry) {
      try {
        map.set(want, extractFile(grf, entry));
      } catch {
        /* skip */
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Effect-only costumes (.str world effects) — auras, falling petals, spotlights,
// ghosts. These costumes carry NO character-sprite view (ClassNum == 0 and the
// resource name isn't in the accessory/robe sprite tables), so the 2D paper-doll
// renderer can't draw them; the client draws them with its ".str" effect system.
// For the latamvisuais 3D map simulator we extract each one's .str into a small
// bundle (effect.json describing the keyframe animation + the texture PNGs it
// references) and a catalogue, served like /icons.
//
// This is the production generalization of latamvisuais/tools/build-effects.mjs
// (the 5-effect POC); the enumeration mirrors that repo's build-db.mjs so the set
// matches exactly the costumes build-db DROPS as effect-only.
// ---------------------------------------------------------------------------

// Read a Lua data table from the GRF (.lub preferred, .lua fallback). Mirrors
// the helper the costume builder uses in latamvisuais/tools/build-db.mjs.
function grfLub(grf, base) {
  const entry = findBestEntry(grf, normalize(`${base}.lub`)) ?? findBestEntry(grf, normalize(`${base}.lua`));
  if (!entry) {
    console.error(`  ! missing in GRF: ${base}.lub`);
    return null;
  }
  return extractFile(grf, entry);
}

// "Equipa em: ^777777Topo e Meio^000000" → ["top","mid"]. Newer LATAM items write
// "Posição: Topo" instead; both labels are accepted. Color codes (^RRGGBB) are
// stripped first. Ported verbatim from build-db.mjs so the slot set matches.
function parseSlots(desc) {
  if (!(desc instanceof LuaTable)) return [];
  for (const line of desc.map.values()) {
    if (typeof line !== "string") continue;
    const s = decodeClientString(line).replace(/\^[0-9a-fA-F]{6}/g, "");
    const m = s.match(/(?:Equipa em|Posi[çc][ãa]o)\s*:\s*(.+)/i);
    if (!m) continue;
    const t = m[1].split(/\s+\S+\s*:/)[0].toLowerCase();
    const slots = [];
    if (t.includes("topo")) slots.push("top");
    if (t.includes("meio")) slots.push("mid");
    if (t.includes("baixo") || /(^|\s)ixo\b/.test(t)) slots.push("low");
    if (t.includes("capa")) slots.push("garment");
    return slots;
  }
  return [];
}

// Normalize a resource name to its effect key / lookup form: forward slashes,
// no leading underscore, lowercase. (Used both as the served effect key and as
// the substring to find the .str folder.)
function normRes(s) {
  return typeof s === "string" ? s.replace(/\\/g, "/").replace(/^_/, "").toLowerCase() : "";
}

// Reverse lookup (sprite name → view id) over the client's accessory/robe name
// tables — the same authority build-db.mjs uses to recover a costume's view when
// ClassNum is 0. A costume that resolves to a view here is a renderable body
// sprite (NOT an effect-only costume), so we use this only to EXCLUDE those.
function buildViewResolver(grf) {
  const tablesFrom = (...bases) => {
    const g = new LuaTable();
    for (const base of bases) {
      const bytes = grfLub(grf, `data/luafiles514/lua files/datainfo/${base}`);
      if (bytes) {
        try {
          runChunkInto(bytes, g);
        } catch (err) {
          console.error(`  ! ${base}: ${err.message}`);
        }
      }
    }
    return g;
  };
  const reverse = (...tables) => {
    const m = new Map();
    for (const t of tables) {
      if (!(t instanceof LuaTable)) continue;
      for (const [k, v] of t.map) {
        const key = normRes(typeof v === "string" ? decodeClientString(v) : "");
        if (typeof k !== "number" || k <= 0 || !key) continue;
        const prev = m.get(key);
        if (prev == null || k < prev) m.set(key, k); // lowest id wins (deterministic)
      }
    }
    return m;
  };
  const accG = tablesFrom("accessoryid", "accname");
  const robeG = tablesFrom("spriterobeid", "spriterobename");
  const acc = reverse(accG.get("AccNameTable"));
  const robe = reverse(robeG.get("RobeNameTable"), robeG.get("RobeNameTable_Eng"));
  return (slots, resourceName) => {
    const key = normRes(decodeClientString(resourceName));
    if (!key) return undefined;
    return (slots.includes("garment") ? robe : acc).get(key);
  };
}

// Enumerate the effect-only costumes from System/iteminfo_new.lub: costume==true,
// a parsed visual slot, and NO resolvable character view (the set build-db drops).
// The "invisible" costumes (가린다/Invisível — res 인비지블*) hide gear and have no
// visual to extract, so they're excluded up front.
function buildEffectCostumes(grf, args) {
  const lubPath = resolveItemInfoPath(args);
  if (!lubPath) {
    throw new Error("iteminfo_new.lub not found next to the GRF (System/) — pass --iteminfo <path>");
  }
  const tbl = runChunk(readFileSync(lubPath)).get("tbl");
  if (!(tbl instanceof LuaTable)) throw new Error("iteminfo: no `tbl` global");
  const resolveView = buildViewResolver(grf);

  const effects = [];
  const excluded = [];
  for (const [id, entry] of tbl.map) {
    if (typeof id !== "number" || !(entry instanceof LuaTable)) continue;
    if (entry.get("costume") !== true) continue;
    const name = decodeClientString(entry.get("identifiedDisplayName"));
    if (!name) continue;
    const slots = parseSlots(entry.get("identifiedDescriptionName"));
    if (!slots.length) continue;

    // Renderable? (iteminfo carries the view, or its resource name resolves to one.)
    const cn = entry.get("ClassNum");
    if (typeof cn === "number" && cn > 0) continue;
    if (resolveView(slots, entry.get("identifiedResourceName")) != null) continue;

    const res = decodeClientString(entry.get("identifiedResourceName")) || "";
    // "Invisible" costumes hide gear — no .str to extract.
    if (/^인비지블/.test(res) || /invis[íi]vel/i.test(name)) {
      excluded.push({ id, name, res });
      continue;
    }
    effects.push({ id, name, slots, res });
  }
  effects.sort((a, b) => a.id - b.id);
  excluded.sort((a, b) => a.id - b.id);
  return { effects, excluded };
}

// Index every .str under data/texture/effect/ (normalized, forward-slash paths).
function indexStrFiles(grf) {
  const out = [];
  for (const f of grf.files) {
    if (!(f.flags & 0x01)) continue;
    const n = normalize(f.filename);
    if (n.startsWith("data/texture/effect/") && n.endsWith(".str")) out.push(n);
  }
  return out;
}

// Manual .str overrides for resource names the heuristic can't pick on its own:
// folders with several real .str where the right one isn't the name-matching one
// (verified visually against the live client). Korean-named and EXE/shared-bound
// effects (the level auras, magic circles, …) whose .str path isn't derivable
// from the resource name go here too once mapped — until then they report as
// unresolved (expected manual follow-up, per the project brief).
const STR_OVERRIDE = {
  // efst_c_sakura_fubuki holds cherryblossoms.str AND sakura_fubuki.str; the
  // costume uses the cherry-blossom petals.
  c_sakura_fubuki: "data/texture/effect/efst_c_sakura_fubuki/cherryblossoms.str",
  // c_swirling_flame holds vortexf.str AND vortexf2.str; the primary is vortexf.
  c_swirling_flame: "data/texture/effect/c_swirling_flame/vortexf.str",
  // Magic circles: the effect folder collapses the resource name's punctuation
  // ("magic_circle" → efst_magiccircle). The rainbow folder holds mc.str AND
  // mcr.str — mcr ("magic circle rainbow") is the rainbow variant.
  magic_circle: "data/texture/effect/efst_magiccircle/mc.str",
  c_magic_circle_rainbow: "data/texture/effect/efst_magiccirclerainbow/mcr.str",
  // Korean-named costumes whose effect folder is romanized (the brief's
  // fluttering/feather/angel_wing hint). Keyed by the normalized resource name;
  // their served key is derived from the .str folder (see effectKey).
  "c흩날리는천사의날개": "data/texture/effect/efst_angel_fluttering/angel_fluttering.str",
  "c흩날리는깃털": "data/texture/effect/efst_feather_fluttering/feath.str",
  "눈의선물": "data/texture/effect/efst_gift_of_snow/gift_of_snow.str",
};

// The served effect key: the resource name normalized to a URL/path-safe slug.
// Most resource names are already ASCII; the Korean-named ones aren't, so we fall
// back to the .str folder name (minus the efst_ prefix), e.g.
// efst_angel_fluttering → "angel_fluttering", then the .str basename.
function effectKey(res, strPath) {
  const k = normRes(res);
  if (/^[a-z0-9_]+$/.test(k)) return k;
  const segs = strPath.split("/");
  const folder = (segs[segs.length - 2] || "").replace(/^efst_/, "");
  if (/^[a-z0-9_]+$/.test(folder)) return folder;
  return strBase(strPath);
}

const strBase = (p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.str$/, "");
const isMinStr = (p) => strBase(p).startsWith("min_"); // low-spec "minimized" variant

// Map a resource name → a .str path in the GRF. Returns { str } on success, or
// { ambiguous } / null so the caller can report it. The link is the resource
// name: find the .str folder named efst_<res> or <res> (or a basename <res>.str),
// preferring the basename that matches the resource, then the sole real (non-min)
// .str, else flag the folder as ambiguous for the override table. Costume resource
// names often carry a leading "C_" that the effect folder omits (C_InkPainting_Day
// → efst_inkpainting_day), so the de-prefixed form is tried too.
function resolveStr(strIndex, res) {
  const r = normRes(res);
  if (!r) return null;
  if (STR_OVERRIDE[r]) {
    const ov = normalize(STR_OVERRIDE[r]);
    const hit = strIndex.find((p) => p.endsWith(ov));
    return hit ? { str: hit } : null;
  }
  const variants = r.startsWith("c_") ? [r, r.slice(2)] : [r];
  for (const v of variants) {
    const folderMatch = strIndex.filter((p) => {
      const segs = p.split("/");
      return segs.includes("efst_" + v) || segs.includes(v);
    });
    const pool = (folderMatch.length ? folderMatch : strIndex.filter((p) => strBase(p) === v)).filter(
      (p) => !isMinStr(p),
    );
    if (!pool.length) continue;
    const byName = pool.find((p) => strBase(p) === v);
    if (byName) return { str: byName };
    if (pool.length === 1) return { str: pool[0] };
    return { ambiguous: pool };
  }
  return null;
}

// Resolve a texture referenced by a .str: its own folder first (bespoke
// textures), then the shared effect texture pool, then the global texture root.
function findEffectTexture(grf, strDir, texName) {
  const n = normRes(texName);
  return (
    findBestEntry(grf, normalize(`${strDir}/${n}`)) ||
    findBestEntry(grf, normalize(`data/texture/effect/${n}`)) ||
    findBestEntry(grf, normalize(`data/texture/${n}`))
  );
}

// Parse a binary ".str" (STRM) world-effect. Little-endian. Ported from
// latamvisuais/tools/str.mjs (itself from roBrowser's Loaders/Str.js). Texture
// names are EUC-KR char[128]; keyframes are 124 bytes. Returns the parsed layers
// plus bytesRead/total so the caller can assert a clean round-trip.
function parseStr(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const EUCKR = new TextDecoder("euc-kr");
  let off = 0;
  const u32 = () => { const v = view.getUint32(off, true); off += 4; return v; };
  const i32 = () => { const v = view.getInt32(off, true); off += 4; return v; };
  const f32 = () => { const v = view.getFloat32(off, true); off += 4; return v; };
  const floats = (n) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = f32(); return a; };
  const str = (n) => {
    let end = off;
    const lim = off + n;
    while (end < lim && u8[end] !== 0) end++;
    const s = EUCKR.decode(u8.subarray(off, end));
    off += n;
    return s;
  };

  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  off = 4;
  if (magic !== "STRM") throw new Error(`bad STR magic: ${JSON.stringify(magic)}`);
  const version = u32();
  const fps = u32();
  const maxKey = u32();
  const layerNum = u32();
  off += 16; // reserved

  const layers = [];
  for (let l = 0; l < layerNum; l++) {
    const texNum = u32();
    const textures = [];
    for (let t = 0; t < texNum; t++) textures.push(str(128));
    const animNum = u32();
    const anims = [];
    for (let a = 0; a < animNum; a++) {
      anims.push({
        frame: i32(),
        type: u32(),
        pos: floats(2),
        uv: floats(8),
        xy: floats(8),
        aniframe: f32(),
        anitype: u32(),
        delay: f32(),
        angle: f32(),
        color: floats(4),
        srcalpha: u32(),
        destalpha: u32(),
        mtpreset: u32(),
      });
    }
    layers.push({ textures, anims });
  }
  return { version, fps, maxKey, layers, bytesRead: off, total: u8.length };
}

// Extract one effect into <outDir>: parse the .str, emit each referenced texture
// as tex_N.png (deduped by name, shared textures emitted once), and write
// effect.json with the slimmed keyframes the runtime needs. Mirrors the POC's
// buildEffect so the bundle is byte-identical. Returns counts for the report.
function buildEffect(grf, strPath, key, outDir) {
  const entry = findBestEntry(grf, strPath);
  if (!entry) throw new Error(`.str not found: ${strPath}`);
  const str = parseStr(extractFile(grf, entry));
  const strDir = dirname(strPath); // normalized already

  // One shared PNG per distinct texture name. texFile maps in-.str name →
  // emitted filename (or null when missing/undecodable). The running map size is
  // the next tex index — kept faithful to the POC, including counting nulls.
  const texFile = new Map();
  let texMissing = 0;
  const ensureTexture = (name) => {
    const k = normRes(name);
    if (texFile.has(k)) return texFile.get(k);
    const tex = findEffectTexture(grf, strDir, name);
    if (!tex) {
      texMissing++;
      console.error(`  ! texture missing: ${name}`);
      texFile.set(k, null);
      return null;
    }
    const png = effectTextureToPng(extractFile(grf, tex), k);
    if (!png) {
      console.error(`  ! texture decode failed: ${name}`);
      texFile.set(k, null);
      return null;
    }
    const file = `tex_${texFile.size}.png`;
    writeFileSync(join(outDir, file), png);
    texFile.set(k, file);
    return file;
  };

  const layers = str.layers.map((ly) => ({
    textures: ly.textures.map((t) => ensureTexture(t)),
    anims: ly.anims.map((a) => ({
      frame: a.frame,
      type: a.type,
      pos: a.pos,
      xy: a.xy,
      aniframe: a.aniframe,
      angle: a.angle,
      color: a.color,
      src: a.srcalpha,
      dst: a.destalpha,
    })),
  }));

  writeFileSync(join(outDir, "effect.json"), JSON.stringify({ key, fps: str.fps, maxKey: str.maxKey, layers }));
  return { layers: layers.length, textures: texFile.size, texMissing, bytesRead: str.bytesRead, total: str.total };
}

function extractEffects(grfPath, outBase, args) {
  const grf = openGrf(grfPath);
  try {
    const root = resolve(outBase);
    mkdirSync(root, { recursive: true });

    console.error("Enumerating effect-only costumes from iteminfo…");
    const { effects, excluded } = buildEffectCostumes(grf, args);
    const strIndex = indexStrFiles(grf);
    console.error(`  ${effects.length} effect-only costumes, ${excluded.length} excluded (invisible), ${strIndex.length} .str files indexed`);

    const resolved = [];
    const unresolved = [];
    for (const eff of effects) {
      const r = resolveStr(strIndex, eff.res);
      if (!r || !r.str) {
        unresolved.push({ ...eff, ambiguous: r?.ambiguous });
        continue;
      }
      const key = effectKey(eff.res, r.str);
      if (!/^[a-z0-9_]+$/.test(key)) {
        // The key is the /effects/{key}/ URL segment; the gateway only serves
        // [a-z0-9_] keys. A non-ASCII .str folder would yield an unservable
        // bundle — flag it for a romanized override instead of writing it.
        unresolved.push({ ...eff, error: `unservable key ${JSON.stringify(key)}` });
        console.error(`  ! ${eff.id} ${JSON.stringify(eff.res)}: non-ASCII key ${JSON.stringify(key)} — add a romanized .str folder to STR_OVERRIDE`);
        continue;
      }
      const outDir = join(root, key);
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      try {
        const info = buildEffect(grf, r.str, key, outDir);
        const roundTrip = info.bytesRead === info.total ? "" : ` (! str bytesRead ${info.bytesRead}/${info.total})`;
        console.error(
          `  ✓ ${key} (item ${eff.id}) → ${info.layers} layers, ${info.textures} textures` +
            (info.texMissing ? ` (${info.texMissing} missing)` : "") + roundTrip,
        );
        resolved.push({ ...eff, key, str: r.str });
      } catch (err) {
        rmSync(outDir, { recursive: true, force: true });
        unresolved.push({ ...eff, error: err.message });
        console.error(`  ! ${key} (item ${eff.id}): ${err.message}`);
      }
    }

    // Catalogue: view-less costume entries (id/name/slots + the `effect` key that
    // links to the bundle above). The map simulator's loadDb merges these in.
    const items = resolved
      .map((e) => ({ id: e.id, name: e.name, slots: e.slots, effect: e.key }))
      .sort((a, b) => a.id - b.id);
    writeFileSync(join(root, "index.json"), JSON.stringify({ items }));

    // In-world map effects: build a /effects/<key>/ bundle for every servable STR
    // effect in the ported EffectTable, so any map's manifest `effects[].str` keys
    // (e.g. iz_dun03's bubble1..bubble4) resolve. The table is the bounded authority,
    // so this is independent of which maps are extracted. Costume keys win on a
    // collision (already produced above). Each key picks the first id-path that
    // exists in the GRF (handles a basename shared across ids, e.g. safetywall).
    const producedKeys = new Set(resolved.map((e) => e.key));
    const keyPaths = new Map(); // key -> ordered unique candidate paths
    for (const id of Object.keys(EFFECT_STR_TABLE)) {
      for (const { key, path } of effectStrRefs(Number(id))) {
        if (producedKeys.has(key)) continue;
        if (!keyPaths.has(key)) keyPaths.set(key, []);
        const arr = keyPaths.get(key);
        if (!arr.includes(path)) arr.push(path);
      }
    }
    let mapBuilt = 0;
    const mapMissing = [];
    const mapFailed = [];
    for (const [key, paths] of keyPaths) {
      const path = paths.find((p) => findBestEntry(grf, p));
      if (!path) { mapMissing.push(key); continue; }
      const outDir = join(root, key);
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      try {
        const info = buildEffect(grf, path, key, outDir);
        const roundTrip = info.bytesRead === info.total ? "" : ` (! str bytesRead ${info.bytesRead}/${info.total})`;
        console.error(
          `  ✓ ${key} (map effect) → ${info.layers} layers, ${info.textures} textures` +
            (info.texMissing ? ` (${info.texMissing} missing)` : "") + roundTrip,
        );
        producedKeys.add(key);
        mapBuilt++;
      } catch (err) {
        rmSync(outDir, { recursive: true, force: true });
        mapFailed.push(key);
        console.error(`  ! ${key} (map effect): ${err.message}`);
      }
    }

    // Report: resolved / unresolved / excluded (the unresolved set is expected
    // manual follow-up — Korean-named and EXE/shared-bound effects).
    console.error(`\nEffects → ${root}`);
    console.error(`  resolved:   ${resolved.length}`);
    console.error(`  unresolved: ${unresolved.length}`);
    console.error(`  excluded:   ${excluded.length}`);
    console.error(`  map effects: ${mapBuilt} built` + (mapMissing.length ? `, ${mapMissing.length} not in GRF` : "") + (mapFailed.length ? `, ${mapFailed.length} failed` : ""));
    console.error(`  catalogue:  index.json (${items.length} items)`);
    if (unresolved.length) {
      console.error(`\n  Unresolved (need a manual STR_OVERRIDE entry):`);
      for (const u of unresolved) {
        const hint = u.ambiguous ? ` — ambiguous: [${u.ambiguous.join(", ")}]` : u.error ? ` — ${u.error}` : "";
        console.error(`    ${u.id}\t${JSON.stringify(u.res)}\t${u.name}${hint}`);
      }
    }
    if (excluded.length) {
      console.error(`\n  Excluded (invisible costumes — no visual):`);
      for (const x of excluded) console.error(`    ${x.id}\t${JSON.stringify(x.res)}\t${x.name}`);
    }
  } finally {
    closeGrf(grf);
  }
}

// ---------------------------------------------------------------------------
// RSW in-world effects (.str) — the .rsw "type 4" effect objects reference a
// numeric effect id; this is the STR-type subset of roBrowser's
// src/DB/Effects/EffectTable.js (id → { type:"STR", file, rand? }), ported here
// so both the map manifest (`effects`) and the --effects extractor can resolve
// an id to its .str asset(s). Only STR effects are ported — the FUNC / 3D /
// CYLINDER / SPR / weather types roBrowser draws procedurally are out of scope
// (e.g. id 45 = EF_FIREFLY is a FUNC and is absent here, so it is skipped).
//
// `file` may carry a "%d" placeholder expanded over `rand:[a,b]` (the client
// picks one at random per spawn — e.g. 109 EF_BUBBLE "bubble%d" [1,4] →
// bubble1..bubble4), a sub-path ("../npc/x", "RL_C_MAKER/cm"), or an EUC-KR
// Korean name (decoded from the source's \xHH escapes).
// ---------------------------------------------------------------------------

const EFFECT_STR_TABLE = {
  10: [{ file: "maemor" }],
  13: [{ file: "effect/safetywall" }],
  23: [{ file: "stonecurse" }],
  25: [{ file: "firewall%d", rand: [1, 2] }],
  28: [{ file: "freeze" }],
  29: [{ file: "lightning" }, { file: "windhit%d", rand: [1, 3] }],
  30: [{ file: "thunderstorm" }],
  40: [{ file: "cross" }],
  41: [{ file: "angelus" }],
  49: [{ file: "firehit%d", rand: [1, 3] }],
  52: [{ file: "windhit%d", rand: [1, 3] }],
  64: [{ file: "arrowshot" }],
  65: [{ file: "invenom" }],
  66: [{ file: "cure" }],
  67: [{ file: "provoke" }],
  68: [{ file: "mvp" }],
  69: [{ file: "skidtrap" }],
  70: [{ file: "brandish" }],
  75: [{ file: "gloria" }],
  76: [{ file: "magnificat" }],
  77: [{ file: "resurrection" }],
  78: [{ file: "recovery" }],
  83: [{ file: "sanctuary" }],
  84: [{ file: "impositio" }],
  85: [{ file: "lexaeterna" }],
  86: [{ file: "aspersio" }],
  87: [{ file: "lexdivina" }],
  88: [{ file: "suffragium" }],
  89: [{ file: "stormgust" }],
  90: [{ file: "lord" }],
  91: [{ file: "benedictio" }],
  92: [{ file: "meteor%d", rand: [1, 4] }],
  94: [{ file: "quagmire", rand: [1, 4] }],
  95: [{ file: "quagmire" }],
  96: [{ file: "firepillar" }],
  97: [{ file: "firepillarbomb" }],
  101: [{ file: "repairweapon" }],
  102: [{ file: "crashearth" }],
  103: [{ file: "weaponperfection" }],
  104: [{ file: "maximizepower" }],
  106: [{ file: "blastmine" }],
  107: [{ file: "claymore" }],
  108: [{ file: "freezing" }],
  109: [{ file: "bubble%d", rand: [1, 4] }],
  110: [{ file: "gaspush" }],
  111: [{ file: "spring" }],
  112: [{ file: "kyrie" }],
  113: [{ file: "magnus" }],
  124: [{ file: "venomdust", rand: [1, 3] }],
  126: [{ file: "poisonreact_1st" }],
  127: [{ file: "poisonreact" }],
  129: [{ file: "venomsplasher" }],
  130: [{ file: "twohand" }],
  131: [{ file: "autocounter" }],
  133: [{ file: "freeze" }],
  134: [{ file: "freezed" }],
  135: [{ file: "icecrash" }],
  136: [{ file: "slowp" }],
  139: [{ file: "sandman" }],
  141: [{ file: "pneuma%d", rand: [1, 3] }],
  143: [{ file: "sonicblow" }],
  144: [{ file: "brandish2" }],
  146: [{ file: "shockwavehit" }],
  147: [{ file: "earthhit" }],
  148: [{ file: "pierce" }],
  149: [{ file: "bowling" }],
  150: [{ file: "spearstab" }],
  151: [{ file: "spearboomerang" }],
  152: [{ file: "holyhit" }],
  153: [{ file: "concentration" }],
  154: [{ file: "bs_refinesuccess" }],
  155: [{ file: "bs_refinefailed" }],
  158: [{ file: "joblvup" }],
  169: [{ file: "energycoat" }],
  170: [{ file: "cartrevolution" }],
  181: [{ file: "mentalbreak" }],
  182: [{ file: "magical" }],
  183: [{ file: "sui_explosion" }],
  185: [{ file: "suicide" }],
  186: [{ file: "yunta_1" }],
  187: [{ file: "yunta_2" }],
  188: [{ file: "yunta_3" }],
  189: [{ file: "yunta_4" }],
  190: [{ file: "yunta_5" }],
  191: [{ file: "homing" }],
  192: [{ file: "poison" }],
  193: [{ file: "silence" }],
  194: [{ file: "stun" }],
  195: [{ file: "stonecurse" }],
  197: [{ file: "sleep" }],
  199: [{ file: "pong%d", rand: [1, 3] }],
  204: [{ file: "빨간포션" }],
  205: [{ file: "주홍포션" }],
  206: [{ file: "노란포션" }],
  207: [{ file: "하얀포션" }],
  208: [{ file: "파란포션" }],
  209: [{ file: "초록포션" }],
  210: [{ file: "fruit" }],
  211: [{ file: "fruit_" }],
  213: [{ file: "deffender" }],
  214: [{ file: "keeping" }],
  218: [{ file: "집중" }],
  219: [{ file: "각성" }],
  220: [{ file: "버서크" }],
  234: [{ file: "spell" }],
  235: [{ file: "디스펠" }],
  244: [{ file: "매직로드" }],
  245: [{ file: "holy_cross" }],
  246: [{ file: "shield_charge" }],
  248: [{ file: "providence" }],
  250: [{ file: "twohand" }],
  251: [{ file: "devotion" }],
  255: [{ file: "enc_fire" }],
  256: [{ file: "enc_ice" }],
  257: [{ file: "enc_wind" }],
  258: [{ file: "enc_earth" }],
  268: [{ file: "steal_coin" }],
  269: [{ file: "strip_weapon" }],
  270: [{ file: "strip_shield" }],
  271: [{ file: "strip_armor" }],
  272: [{ file: "strip_helm" }],
  273: [{ file: "연환" }],
  293: [{ file: "유저인터페이스/item/염산병.bmp", rand: [1, 3] }],
  305: [{ file: "p_success" }],
  306: [{ file: "p_failed" }],
  311: [{ file: "loud" }],
  315: [{ file: "safetywall" }],
  337: [{ file: "joblvup" }],
  369: [{ file: "twohand" }],
  371: [{ file: "angel" }],
  372: [{ file: "devil" }],
  390: [{ file: "melt" }],
  391: [{ file: "cart" }],
  392: [{ file: "sword" }],
  406: [{ file: "소울번" }],
  407: [{ file: "사람효과" }],
  440: [{ file: "asum" }],
  452: [{ file: "스톱", rand: [1, 3] }],
  491: [{ file: "찹쌀떡" }],
  492: [{ file: "ramadan" }],
  507: [{ file: "mapae" }],
  508: [{ file: "itempokjuk" }],
  565: [{ file: "moonlight_1" }],
  566: [{ file: "moonlight_2" }],
  567: [{ file: "moonlight_3" }],
  568: [{ file: "h_levelup" }],
  569: [{ file: "defense" }],
  593: [{ file: "food_str" }],
  594: [{ file: "food_int" }],
  595: [{ file: "food_vit" }],
  596: [{ file: "food_agi" }],
  597: [{ file: "food_dex" }],
  598: [{ file: "food_luk" }],
  603: [{ file: "firehit%d", rand: [1, 3] }],
  608: [{ file: "cook_suc" }],
  609: [{ file: "cook_fail" }],
  612: [{ file: "itempokjuk" }],
  618: [{ file: "firehit", rand: [1, 3] }],
  619: [{ file: "freeze", rand: [1, 3] }],
  622: [{ file: "setsudan" }],
  635: [{ file: "fire dragon" }],
  636: [{ file: "icy" }],
  646: [{ file: "트랙킹" }],
  649: [{ file: "불스아이" }],
  668: [{ file: "dragon_h" }],
  669: [{ file: "wideb" }],
  670: [{ file: "dfear" }],
  677: [{ file: "cwound" }],
  682: [{ file: "itempokjuk" }],
  683: [{ file: "itempokjuk" }],
  684: [{ file: "itempokjuk" }],
  685: [{ file: "itempokjuk" }],
  686: [{ file: "itempokjuk" }],
  699: [{ file: "flower_leaf" }],
  704: [{ file: "mobile_ef02" }],
  705: [{ file: "mobile_ef01" }],
  706: [{ file: "mobile_ef03" }],
  708: [{ file: "storm_min" }],
  709: [{ file: "pokjuk_jap" }],
  717: [{ file: "angelus" }],
  721: [{ file: "ado" }],
  722: [{ file: "이그니션브레이크" }],
  727: [{ file: "crimson_r" }],
  728: [{ file: "hell_in" }],
  731: [{ file: "dragon_h" }],
  734: [{ file: "chainlight" }],
  745: [{ file: "aimed" }],
  746: [{ file: "arrowstorm" }],
  747: [{ file: "laulamus" }],
  748: [{ file: "lauagnus" }],
  749: [{ file: "mil_shield" }],
  750: [{ file: "concentration" }],
  756: [{ file: "버서크" }],
  795: [{ file: "powerswing" }],
  813: [{ file: "enervation" }],
  814: [{ file: "groomy" }],
  815: [{ file: "ignorance" }],
  816: [{ file: "laziness" }],
  817: [{ file: "unlucky" }],
  818: [{ file: "weakness" }],
  920: [{ file: "firewall_per" }],
  926: [{ file: "hunter_shockwave_blue" }],
  959: [{ file: "poison_mist" }],
  960: [{ file: "eraser_cutter" }],
  964: [{ file: "lava_slide" }],
  965: [{ file: "sonic_claw" }],
  966: [{ file: "tinder" }],
  967: [{ file: "mid_frenzy" }],
  975: [{ file: "vash00" }],
  987: [{ file: "rwc2011" }],
  988: [{ file: "rwc2011_2" }],
  1015: [{ file: "rune_success" }],
  1016: [{ file: "rune_fail" }],
  1017: [{ file: "changematerial_su" }],
  1018: [{ file: "changematerial_fa" }],
  1019: [{ file: "guardian" }],
  1020: [{ file: "bubble%d_1", rand: [1, 4] }],
  1021: [{ file: "dust" }],
  1029: [{ file: "dancingblade" }],
  1031: [{ file: "invincibleoff2" }],
  1033: [{ file: "devil" }],
  1040: [{ file: "gc_darkcrow" }],
  1042: [{ file: "all_full_throttle" }],
  1043: [{ file: "sr_flashcombo" }],
  1044: [{ file: "rk_luxanima" }],
  1046: [{ file: "so_elemental_shield" }],
  1047: [{ file: "ab_offertorium" }],
  1048: [{ file: "wl_telekinesis_intense" }],
  1049: [{ file: "gn_illusiondoping" }],
  1050: [{ file: "nc_magma_eruption" }],
  1055: [{ file: "chill" }],
  1057: [{ file: "ab_offertorium_ring" }],
  1062: [{ file: "stormgust" }],
  1094: [{ file: "ach_complete/ppring3" }],
  1186: [{ file: "new_dropitem/dropitem_pink/dropitem_pink/dropitem_pink" }, { file: "new_dropitem/dropitem_pink/dropitem_pink_bottom/dropitem_pink_bottom" }],
  1189: [{ file: "new_dropitem/dropitem_yellow/dropitem_yellow/dropitem_yellow" }, { file: "new_dropitem/dropitem_yellow/dropitem_yellow_bottom/dropitem_yellow_bottom" }],
  1190: [{ file: "new_dropitem/dropitem_purple/dropitem_purple/dropitem_purple" }, { file: "new_dropitem/dropitem_purple/dropitem_purple_bottom/dropitem_purple_bottom" }],
  1869: [{ file: "new_dropitem/dropitem_blue/dropitem_blue/dropitem_blue" }, { file: "new_dropitem/dropitem_blue/dropitem_blue_bottom/dropitem_blue_bottom" }],
  1870: [{ file: "new_dropitem/dropitem_green/dropitem_green/dropitem_green" }, { file: "new_dropitem/dropitem_green/dropitem_green_bottom/dropitem_green_bottom" }],
  1871: [{ file: "new_dropitem/dropitem_red/dropitem_red/dropitem_red" }, { file: "new_dropitem/dropitem_red/dropitem_red_bottom/dropitem_red_bottom" }],
  1872: [{ file: "grade_enchant/new_success/new_success" }],
  1873: [{ file: "grade_enchant/new_failed/new_failed" }],
  1874: [{ file: "grade_enchant/new_intro/new_intro" }],
  1875: [{ file: "ui_enchant/ui_intro_yellow/ui_intro_yellow" }],
  1876: [{ file: "ui_enchant/ui_enchant_success/ui_enchant_success" }],
  1877: [{ file: "ui_enchant/ui_fail/ui_enchant_fail" }],
  1878: [{ file: "ui_enchant/ui_intro_blue/ui_intro_blue" }],
  1879: [{ file: "ui_enchant/ui_levelup_success/ui_levelup_success" }],
  1880: [{ file: "ui_enchant/ui_fail/ui_levelup_fail" }],
  1881: [{ file: "ui_enchant/ui_intro_green/ui_intro_green" }],
  1882: [{ file: "ui_enchant/ui_reset_success/ui_reset_success" }],
  1883: [{ file: "ui_enchant/ui_fail/ui_reset_fail" }],};

// Expand a STR def's `file` to concrete .str references. A "%d" placeholder over
// rand:[a,b] yields one name per integer in the (inclusive) range; otherwise the
// file is taken verbatim (a bare `rand` without "%d" is a render hint we ignore).
export function expandStrFiles(def) {
  if (def.rand && def.file.includes("%d")) {
    const out = [];
    for (let i = def.rand[0]; i <= def.rand[1]; i++) out.push(def.file.replace(/%d/g, String(i)));
    return out;
  }
  return [def.file];
}

// The served effect key: the .str basename as a URL-safe [a-z0-9_] segment (the
// /effects/<key>/ path the gateway serves). Returns null for non-ASCII names
// (the Korean-named effects) — those can't be served, so they're skipped in v1.
export function effectStrKey(file) {
  const base = normRes(file).split("/").pop();
  return /^[a-z0-9_]+$/.test(base) ? base : null;
}

// Resolve a .str `file` token to its normalized GRF path under data/texture/effect/,
// folding any leading "../" (e.g. "../npc/x" → data/texture/npc/x.str).
export function effectStrPath(file) {
  const parts = [];
  for (const seg of normalize(`data/texture/effect/${file}.str`).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg) parts.push(seg);
  }
  return parts.join("/");
}

// All servable .str references for an effect id: { key, path } per expanded name,
// deduped by key (order preserved). Returns [] for ids that aren't STR effects
// (FUNC/3D/weather/unknown) or whose names are all unservable. Shared by the map
// manifest (`str` = the keys) and the --effects extractor (builds each path once).
export function effectStrRefs(id) {
  const defs = EFFECT_STR_TABLE[id];
  if (!defs) return [];
  const seen = new Set();
  const refs = [];
  for (const def of defs) {
    for (const file of expandStrFiles(def)) {
      const key = effectStrKey(file);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      refs.push({ key, path: effectStrPath(file) });
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Map extraction — world maps (.gat/.gnd/.rsw + referenced .rsm models and
// BMP/TGA textures) for the latamvisuais 3D map simulator (src/sim).
//
// Each map's geometry binaries are emitted raw (parsed in the browser); the
// models, textures, water frames and shared cursor/grid UI are de-duplicated
// across all 900+ maps into content-addressed stores so identical blobs are
// stored (and served) exactly once:
//
//   <out>/<map>/<map>.gat|gnd|rsw   raw geometry (browser-parsed)
//   <out>/<map>/manifest.json       resolves resource names → shared blob paths
//   <out>/_m/<hash>.rsm             a referenced model (raw)
//   <out>/_t/<hash>.png             a referenced texture (BMP/TGA → transparent PNG)
//   <out>/_w/<hash>.jpg             one animated-water frame (raw JPG)
//   <out>/_u/<hash>.png             a shared UI image (grid selector / cursor frame)
//   <out>/index.json                { maps: [...] } — every extracted map name
//
// Manifest blob paths are written relative to the map dir as "../_t/<hash>.png"
// etc.; the browser fetches them as `baseUrl + path`, and the URL parser folds
// the ".." so they resolve against the store, not the map dir. This mirrors the
// proof-of-concept latamvisuais/tools/build-map.mjs (same manifest shape) but
// shares blobs instead of copying them per map.
// ---------------------------------------------------------------------------

const MAP_EUCKR = new TextDecoder("euc-kr");

// Little-endian binary cursor over a Uint8Array (ported from roformat.mjs).
class MapReader {
  constructor(bytes) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = 0;
  }
  // Fixed-length, NUL-terminated EUC-KR string field.
  str(n) {
    let end = this.p;
    const lim = this.p + n;
    while (end < lim && this.b[end] !== 0) end++;
    const s = MAP_EUCKR.decode(this.b.subarray(this.p, end));
    this.p += n;
    return s;
  }
  lstr() { return this.str(this.u32()); } // u32 length then that many bytes (RSW/RSM 2.x)
  u8() { return this.b[this.p++]; }
  i8() { const v = this.dv.getInt8(this.p); this.p += 1; return v; }
  u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  seek(n) { this.p += n; }
}

// Normalize an embedded resource name (EUC-KR, backslash-separated) to the
// lowercase forward-slash key both the manifest and the browser parsers use.
function normName(name) {
  return name.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

// RSW → referenced model filenames + water type. Field layout ported from
// roBrowserLegacy (handles RSW 1.x–2.x). We read only the object list.
export function parseRsw(bytes) {
  const fp = new MapReader(bytes);
  if (fp.str(4) !== "GRSW") throw new Error("RSW: bad header");
  const version = fp.i8() + fp.i8() / 10;

  if (version >= 2.5) fp.i32(); // build number
  if (version >= 2.2) fp.u8(); // unknown byte

  fp.str(40); // ini
  fp.str(40); // gnd
  fp.str(40); // gat
  if (version >= 1.4) fp.str(40); // src

  let waterType = 0;
  if (version < 2.6) {
    if (version >= 1.3) fp.f32(); // water level
    if (version >= 1.8) { waterType = fp.i32(); fp.f32(); fp.f32(); fp.f32(); } // type, waveH, waveSpeed, wavePitch
    if (version >= 1.9) fp.i32(); // animSpeed
  }
  if (version >= 1.5) {
    fp.i32(); fp.i32(); // longitude, latitude
    fp.f32(); fp.f32(); fp.f32(); // diffuse
    fp.f32(); fp.f32(); fp.f32(); // ambient
    if (version >= 1.7) fp.f32(); // opacity
  }
  if (version >= 1.6) { fp.i32(); fp.i32(); fp.i32(); fp.i32(); } // ground bounds
  if (version >= 2.7) { const c = fp.i32(); fp.seek(4 * c); }

  const count = fp.i32();
  const models = [];
  const effects = [];
  for (let i = 0; i < count; i++) {
    const type = fp.i32();
    if (type === 1) {
      if (version >= 1.3) { fp.str(40); fp.i32(); fp.f32(); fp.i32(); } // name, animType, animSpeed, blockType
      if (version >= 2.6) fp.u8();
      if (version >= 2.7) fp.i32();
      const filename = fp.str(80);
      fp.str(80); // node name
      fp.f32(); fp.f32(); fp.f32(); // position
      fp.f32(); fp.f32(); fp.f32(); // rotation
      fp.f32(); fp.f32(); fp.f32(); // scale
      models.push(filename);
    } else if (type === 2) {
      fp.str(80); fp.f32(); fp.f32(); fp.f32(); fp.i32(); fp.i32(); fp.i32(); fp.f32();
    } else if (type === 3) {
      fp.str(80); fp.str(80); fp.f32(); fp.f32(); fp.f32(); fp.f32(); fp.i32(); fp.i32(); fp.f32();
      if (version >= 2.0) fp.f32();
    } else if (type === 4) {
      // In-world effect: name(80), pos[3]÷5, id(long), delay(float), param[4]. The
      // id maps to a .str world effect via EFFECT_STR_TABLE (EF_BUBBLE = 109 etc.).
      // Positions match the roBrowser ÷5 world scale (same as model/light/sound).
      fp.str(80); // name (unused)
      const pos = [fp.f32() / 5, fp.f32() / 5, fp.f32() / 5];
      const id = fp.i32();
      const delay = fp.f32(); // raw .rsw delay (roBrowser scales it ×10 at render time)
      const param = [fp.f32(), fp.f32(), fp.f32(), fp.f32()];
      effects.push({ id, pos, delay, param });
    } else {
      break; // unknown — stop (quadtree/footer follows the object list anyway)
    }
  }
  return { models: [...new Set(models)], waterType, effects };
}

// GND → ground texture filenames (relative to data/texture/).
function parseGndTextures(bytes) {
  const fp = new MapReader(bytes);
  if (fp.str(4) !== "GRGN") throw new Error("GND: bad header");
  fp.i8(); fp.i8(); // version
  fp.u32(); fp.u32(); // width, height
  fp.f32(); // zoom
  const count = fp.u32();
  const length = fp.u32();
  const textures = [];
  for (let i = 0; i < count; i++) textures.push(fp.str(length));
  return [...new Set(textures)];
}

// RSM → texture filenames (relative to data/texture/). For <2.2 every name is in
// the top-level list (40-char strings); 2.2/2.3 length-prefix them and (2.3)
// carry them per node, so we walk the node tree collecting string entries.
function parseRsmTextures(bytes) {
  const fp = new MapReader(bytes);
  const header = fp.str(4);
  if (header !== "GRSM" && header !== "GRSX") throw new Error("RSM: bad header");
  const version = fp.i8() + fp.i8() / 10;
  fp.i32(); // animLen
  fp.i32(); // shadeType
  if (version >= 1.4) fp.u8(); // alpha

  const textures = [];
  if (version >= 2.3) {
    fp.f32(); // frame rate
    const c = fp.u32();
    for (let i = 0; i < c; i++) textures.push(fp.lstr());
  } else if (version >= 2.2) {
    fp.f32();
    const ac = fp.u32();
    for (let i = 0; i < ac; i++) textures.push(fp.lstr());
    const c = fp.u32();
    for (let i = 0; i < c; i++) textures.push(fp.lstr());
  } else {
    fp.seek(16); // reserved
    const c = fp.u32();
    for (let i = 0; i < c; i++) textures.push(fp.str(40));
    fp.str(40); // main node name (not a texture)
    return [...new Set(textures)]; // <2.2: node textures are indices, nothing new
  }

  // 2.2/2.3: descend nodes to gather any per-node string textures.
  const nodeCount = fp.u32();
  for (let n = 0; n < nodeCount; n++) {
    fp.lstr(); // name
    fp.lstr(); // parent name
    const tc = fp.u32();
    for (let i = 0; i < tc; i++) {
      if (version >= 2.3) textures.push(fp.lstr());
      else fp.i32(); // texture index
    }
    fp.seek(9 * 4 + 3 * 4); // mat3 + offset
    if (version < 2.2) fp.seek(10 * 4); // pos/rotangle/rotaxis/scale (absent for >=2.2)
    const vc = fp.u32(); fp.seek(vc * 12);
    const tvc = fp.u32(); fp.seek(tvc * (version >= 1.2 ? 12 : 8));
    const fc = fp.u32();
    for (let i = 0; i < fc; i++) {
      if (version >= 2.2) fp.seek(fp.i32()); // length-prefixed face record
      else fp.seek(version >= 1.2 ? 24 : 20);
    }
    if (version >= 1.6) { const sc = fp.u32(); fp.seek(sc * 20); } // scale keyframes
    const rc = fp.u32(); fp.seek(rc * 20); // rot keyframes
    if (version >= 2.2) { const pc = fp.u32(); fp.seek(pc * 20); } // pos keyframes
    if (version >= 2.3) {
      const g = fp.u32();
      for (let i = 0; i < g; i++) {
        fp.i32(); // texture id
        const anims = fp.u32();
        for (let a = 0; a < anims; a++) {
          fp.i32(); // type
          const frames = fp.u32();
          fp.seek(frames * 8); // frame i32 + offset f32
        }
      }
    }
  }
  return [...new Set(textures)];
}

// Decode SPR frame `index` (default 0) → { width, height, rgba }; palette index
// 0 = transparent. Just enough to pull the cursor frames (ported from spr.mjs).
function decodeSprFrame(bytes, index = 0) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => { const v = dv.getUint16(p, true); p += 2; return v; };

  if (bytes[0] !== 0x53 || bytes[1] !== 0x50) throw new Error("SPR: bad header"); // "SP"
  p = 2;
  const minor = u8();
  const major = u8();
  const version = major + minor / 10;

  const indexedCount = u16();
  if (version > 1.1) u16(); // rgba frame count (unused — palette frames only)
  if (index >= indexedCount) throw new Error("SPR: frame index out of range (palette frames only)");

  const palStart = bytes.length - 1024; // palette is the last 1024 bytes

  let frame = null;
  for (let i = 0; i <= index; i++) {
    const width = u16();
    const height = u16();
    const size = width * height;
    const data = new Uint8Array(size);
    if (version < 2.1) {
      for (let k = 0; k < size; k++) data[k] = bytes[p++];
    } else {
      const end = u16() + p; // RLE: a run of zeros is 0x00 then a count
      let idx = 0;
      while (p < end) {
        const c = bytes[p++];
        data[idx++] = c;
        if (!c) {
          const count = bytes[p++];
          if (!count) data[idx++] = 0;
          else for (let j = 1; j < count; j++) data[idx++] = c;
        }
      }
    }
    if (i === index) frame = { width, height, data };
  }

  const { width, height, data } = frame;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const pi = data[i] * 4;
    rgba[i * 4] = bytes[palStart + pi];
    rgba[i * 4 + 1] = bytes[palStart + pi + 1];
    rgba[i * 4 + 2] = bytes[palStart + pi + 2];
    rgba[i * 4 + 3] = data[i] === 0 ? 0 : 255; // index 0 = transparent
  }
  return { width, height, rgba };
}

// ACT → per-action playback sequence: out[action] is the layer-0 SPR frame index
// of each of that action's animations, in order (ported from act.mjs).
function actActionSequences(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => { const v = dv.getUint16(p, true); p += 2; return v; };
  const u32 = () => { const v = dv.getUint32(p, true); p += 4; return v; };
  const i32 = () => { const v = dv.getInt32(p, true); p += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(p, true); p += 4; return v; };
  const seek = (n) => { p += n; };

  if (bytes[0] !== 0x41 || bytes[1] !== 0x43) throw new Error("ACT: bad header");
  p = 2;
  const minor = u8();
  const major = u8();
  const version = major + minor / 10;

  const actionCount = u16();
  seek(10);
  const out = [];

  for (let a = 0; a < actionCount; a++) {
    const animCount = u32();
    const seq = [];
    for (let an = 0; an < animCount; an++) {
      seek(32);
      const layerCount = u32();
      let first = -1;
      for (let l = 0; l < layerCount; l++) {
        seek(8);
        const index = i32();
        i32();
        if (version >= 2.0) {
          seek(4); f32();
          if (version > 2.3) f32();
          i32(); i32();
          if (version >= 2.5) { i32(); i32(); }
        }
        if (l === 0) first = index;
      }
      if (version >= 2.0) i32();
      if (version >= 2.3) { const c = i32(); for (let i = 0; i < c; i++) seek(12); }
      seq.push(first);
    }
    out.push(seq);
  }
  return out;
}

// Content-addressed blob store: writes each distinct byte payload once under
// <outBase>/<subdir>/<hash>.<ext> and returns its store-relative path. Identical
// blobs (the same texture/model/water frame referenced by many maps) collapse to
// one file. The returned path is later prefixed with "../" in the manifest.
function makeBlobStore(outBase) {
  const seen = new Set();
  return function put(subdir, ext, bytes) {
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const rel = `${subdir}/${hash}.${ext}`;
    if (!seen.has(rel)) {
      const dir = join(outBase, subdir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${hash}.${ext}`), bytes);
      seen.add(rel);
    }
    return rel;
  };
}

// findBestEntry scans all ~260k GRF entries per call, which is far too slow for
// the ~100 lookups each of 900+ maps needs. Build the resolution once: a
// normalized-name → best-entry map (largest uncompressed copy wins, matching
// findBestEntry's tie-break) so per-map lookups are O(1). Map resources are
// always full `data/...` paths, so exact-name keying reproduces findBestEntry's
// result for them (its endsWith leniency only matters for partial paths we never
// pass here).
function buildEntryIndex(grf) {
  const idx = new Map();
  for (const f of grf.files) {
    if (!(f.flags & 0x01)) continue;
    const name = normalize(f.filename);
    const prev = idx.get(name);
    if (!prev || f.uncompSize > prev.uncompSize) idx.set(name, f);
  }
  return idx;
}

// Every map name in the GRF (the basename of each data/<name>.rsw), lowercased.
function listMapNames(grf) {
  const names = new Set();
  for (const f of grf.files) {
    if (!(f.flags & 0x01)) continue;
    const m = /^data\/([a-z0-9_@-]+)\.rsw$/.exec(normalize(f.filename));
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

// The mouse cursor + hovered-cell selector are identical for every map, so we
// extract them once into the shared _u store and reuse the manifest fragment.
function extractMapUi(grf, index, store) {
  const ui = {};
  const gridEntry = index.get("data/texture/grid.tga");
  if (gridEntry) {
    const png = effectTextureToPng(extractFile(grf, gridEntry), "grid.tga");
    if (png) ui.grid = "../" + store("_u", "png", png);
  }

  const cursorSpr = index.get("data/sprite/cursors.spr");
  const cursorAct = index.get("data/sprite/cursors.act");
  if (cursorSpr && cursorAct) {
    const spr = extractFile(grf, cursorSpr);
    const DEFAULT_ACTION = 0; // animated default arrow
    const ROTATE_ACTION = 4; // two-curvy-arrows rotate cursor
    const CURSOR_FPS = 12;
    let seqs = [];
    try {
      seqs = actActionSequences(extractFile(grf, cursorAct));
    } catch (err) {
      console.warn(`  ! cursors.act parse failed: ${err.message}`);
    }
    // Emit the distinct frames of an action's sequence + a seq[] indexing them.
    const buildCursor = (actionSeq) => {
      const order = [];
      const seen = new Map();
      for (const idx of actionSeq) {
        if (idx < 0) continue;
        if (!seen.has(idx)) { seen.set(idx, order.length); order.push(idx); }
      }
      if (!order.length) return null;
      const frames = [];
      let w = 0, h = 0;
      order.forEach((idx, i) => {
        const fr = decodeSprFrame(spr, idx);
        if (i === 0) { w = fr.width; h = fr.height; }
        frames.push("../" + store("_u", "png", encodePng(fr.width, fr.height, Buffer.from(fr.rgba))));
      });
      const seq = actionSeq.filter((i) => i >= 0).map((i) => seen.get(i));
      return { frames, seq, w, h };
    };
    try {
      const def = buildCursor(seqs[DEFAULT_ACTION] ?? [0]);
      if (def) ui.cursor = { frames: def.frames, seq: def.seq, hotspot: [1, 1], fps: CURSOR_FPS, fallback: "default" }; // arrow tip ≈ top-left
      const rot = buildCursor(seqs[ROTATE_ACTION] ?? [10]);
      if (rot) ui.cursorRotate = { frames: rot.frames, seq: rot.seq, hotspot: [Math.round(rot.w / 2), Math.round(rot.h / 2)], fps: CURSOR_FPS, fallback: "grabbing" }; // pivots about centre
    } catch (err) {
      console.warn(`  ! cursor extraction failed: ${err.message}`);
    }
  }
  return ui;
}

// ---------------------------------------------------------------------------
// EffectTool emitter lubs — the modern parametric map effects EF_EMITTER (974),
// EF_ANIMATED_EMITTER (1073) and EF_MAGIC_FLOOR (1025) are NOT .str files. Their
// particle spec lives per-map in `data/luafiles514/lua files/effecttool/<map>.lub`
// as global tables (`_<map>_emitterInfo`/`_animatedEmitterInfo`/`_magicfloorInfo`
// and a generic `_<map>_Effect` container with Type/ID fields). Each .rsw type-4
// placement of these ids matches a lub entry by horizontal (X/Z) position, so we
// attach the matched entry's spec to the manifest effect — the client renders it
// from that, no client EXE needed.
//
// The `*Info` data is ALWAYS a straight-line table constructor; the FORLOOP/CALL
// in these lubs live only in trailing loader closures that must NOT be executed
// (running their control flow corrupts the data). So executeLub runs straight
// line — branch/loop/call/upvalue ops are no-ops, nested closures are captured
// but never run — while still evaluating arithmetic (some coords are computed).
// EffectTool arrays are 0-indexed (keys 0..N); one lub (1@def03) ships as plain
// Lua source rather than LuaQ bytecode, so readEffectToolLub handles both.
// ---------------------------------------------------------------------------

const EMITTER_EFFECT_IDS = new Set([974, 1073, 1025]);

// Straight-line execution of a lub's root proto (see note above). Reuses the
// shared OP/BITRK/FIELDS_PER_FLUSH/LuaTable defined for the iteminfo reader.
function executeLub(proto, globals) {
  const R = [];
  const K = proto.k;
  const rk = (x) => (x & BITRK ? K[x & (BITRK - 1)] : R[x]);
  let pc = 0;
  const code = proto.code;
  while (pc < code.length) {
    const i = code[pc++];
    const op = i & 0x3f;
    const a = (i >>> 6) & 0xff;
    const c = (i >>> 14) & 0x1ff;
    const b = (i >>> 23) & 0x1ff;
    const bx = (i >>> 14) & 0x3ffff;
    switch (op) {
      case OP.MOVE: R[a] = R[b]; break;
      case OP.LOADK: R[a] = K[bx]; break;
      case OP.LOADBOOL: R[a] = b !== 0; if (c) pc++; break;
      case OP.LOADNIL: for (let r = a; r <= b; r++) R[r] = undefined; break;
      case OP.GETGLOBAL: R[a] = globals.get(K[bx]); break;
      case OP.SETGLOBAL: globals.set(K[bx], R[a]); break;
      case OP.NEWTABLE: R[a] = new LuaTable(); break;
      case OP.GETTABLE: { const t = R[b]; R[a] = t instanceof LuaTable ? t.get(rk(c)) : undefined; break; }
      case OP.SETTABLE: { const t = R[a]; if (t instanceof LuaTable) t.set(rk(b), rk(c)); break; }
      case OP.ADD: R[a] = rk(b) + rk(c); break;
      case OP.SUB: R[a] = rk(b) - rk(c); break;
      case OP.MUL: R[a] = rk(b) * rk(c); break;
      case OP.DIV: R[a] = rk(b) / rk(c); break;
      case OP.MOD: { const x = rk(b), y = rk(c); R[a] = x - Math.floor(x / y) * y; break; }
      case OP.POW: R[a] = Math.pow(rk(b), rk(c)); break;
      case OP.UNM: R[a] = -R[b]; break;
      case OP.SETLIST: {
        let n = b;
        let block = c;
        if (block === 0) block = code[pc++]; // real C stored in the next word
        if (n === 0) { n = 0; while (R[a + n + 1] !== undefined) n++; } // B=0: flush to top
        const base = (block - 1) * FIELDS_PER_FLUSH;
        const t = R[a];
        for (let j = 1; j <= n; j++) t.set(base + j, R[a + j]);
        break;
      }
      case OP.CLOSURE: R[a] = { __closure: proto.protos[bx] }; break; // captured, not run
      case OP.RETURN: return;
      default: break; // JMP/FOR*/CALL/EQ/…/upvalues — no-op (straight-line)
    }
  }
}

// LuaTable → plain JS. EffectTool list tables are 0-indexed (keys 0..N) while Lua
// literals like {x,y,z} are 1-indexed, so an all-integer-keyed table is walked
// min..max (walking 1..max would silently drop entry 0).
function lubToJS(v, seen = new Set()) {
  if (v instanceof LuaTable) {
    if (seen.has(v)) return undefined;
    seen.add(v);
    const keys = [...v.map.keys()];
    const arrish = keys.length > 0 && keys.every((k) => typeof k === "number" && Number.isInteger(k));
    if (arrish) {
      const min = Math.min(...keys), max = Math.max(...keys);
      const arr = [];
      for (let i = min; i <= max; i++) arr.push(lubToJS(v.map.get(i), seen));
      return arr;
    }
    const o = {};
    for (const k of keys) o[k] = lubToJS(v.map.get(k), seen);
    return o;
  }
  if (typeof v === "number") return Math.abs(v) < 1e-9 ? 0 : Math.round(v * 1e4) / 1e4;
  return v;
}

// Minimal Lua table-literal parser for the rare uncompiled (plain-text) lub.
function parseLubSource(src) {
  src = src.replace(/--\[\[[\s\S]*?\]\]/g, "").replace(/--[^\n]*/g, "");
  let i = 0;
  const n = src.length;
  const ws = () => { while (i < n && /\s/.test(src[i])) i++; };
  function value() {
    ws();
    const ch = src[i];
    if (ch === "{") return table();
    if (ch === "[" && src[i + 1] === "[") { i += 2; const e = src.indexOf("]]", i); const s = src.slice(i, e); i = e + 2; return s; }
    if (ch === '"' || ch === "'") { const q = ch; i++; let s = ""; while (i < n && src[i] !== q) { if (src[i] === "\\") { s += src[i + 1]; i += 2; } else s += src[i++]; } i++; return s; }
    let j = i; while (j < n && /[^,}\s\]=]/.test(src[j])) j++; const tok = src.slice(i, j); i = j;
    if (tok === "true") return true; if (tok === "false") return false; if (tok === "nil") return undefined;
    const num = Number(tok); return Number.isNaN(num) ? tok : num;
  }
  function table() {
    const t = {}; const arr = []; i++;
    for (;;) {
      ws(); if (src[i] === "}") { i++; break; }
      if (src[i] === "[") {
        i++; ws(); let key;
        if (src[i] === '"' || src[i] === "'") { const q = src[i++]; key = ""; while (src[i] !== q) key += src[i++]; i++; }
        else { let j = i; while (src[j] !== "]") j++; key = Number(src.slice(i, j).trim()); i = j; }
        ws(); i++; ws(); i++; t[key] = value();
      } else if (/[A-Za-z_]/.test(src[i])) {
        let j = i; while (/[A-Za-z0-9_]/.test(src[j])) j++; const key = src.slice(i, j); i = j; ws();
        if (src[i] === "=") { i++; t[key] = value(); } else { i = j; arr.push(value()); }
      } else arr.push(value());
      ws(); if (src[i] === "," || src[i] === ";") i++;
    }
    if (arr.length) arr.forEach((v, k) => (t[k + 1] = v));
    return Object.keys(t).every((k) => /^\d+$/.test(k)) ? Object.values(t) : t;
  }
  const globals = {};
  const re = /(_[A-Za-z0-9_]+)\s*=\s*/g;
  let m;
  while ((m = re.exec(src))) { i = re.lastIndex; ws(); globals[m[1]] = value(); re.lastIndex = i; }
  return globals;
}

// Read an EffectTool lub (LuaQ bytecode or plain-text source) → globals object.
function readEffectToolLub(bytes) {
  if (bytes[0] === 0x1b && bytes[1] === 0x4c && bytes[2] === 0x75 && bytes[3] === 0x61) {
    const g = new LuaTable();
    executeLub(loadChunk(bytes), g);
    const out = {};
    for (const k of g.map.keys()) out[k] = lubToJS(g.get(k));
    return out;
  }
  return parseLubSource(Buffer.from(bytes).toString("latin1"));
}

// All emitter placement records from a map's lub: every global that's a non-empty
// array of objects carrying a `pos` (covers emitterInfo/animatedEmitterInfo/
// magicfloorInfo and the generic Effect container). [] when the map has no lub.
function readMapEmitters(grf, index, map) {
  const entry = index.get(`data/luafiles514/lua files/effecttool/${map}.lub`);
  if (!entry) return [];
  let globals;
  try { globals = readEffectToolLub(extractFile(grf, entry)); }
  catch (err) { console.warn(`  ! ${map}: effecttool lub parse failed: ${err.message}`); return []; }
  const out = [];
  for (const val of Object.values(globals)) {
    if (!Array.isArray(val) || !val.length) continue;
    if (!val.every((e) => e && typeof e === "object" && !Array.isArray(e) && Array.isArray(e.pos))) continue;
    out.push(...val);
  }
  return out;
}

// Extract one map into <outBase>/<map>/ (raw geometry + manifest) plus its
// model/texture/water blobs into the shared store. Returns a stats object, or
// { skipped } when a required geometry file is missing.
function extractOneMap(grf, index, map, outBase, store, ui, fogTable) {
  const rawFiles = {};
  for (const ext of ["gat", "gnd", "rsw"]) {
    const entry = index.get(`data/${map}.${ext}`);
    if (!entry) return { skipped: `no .${ext}` };
    rawFiles[ext] = extractFile(grf, entry);
  }

  const mapDir = join(outBase, map);
  mkdirSync(mapDir, { recursive: true });
  for (const ext of ["gat", "gnd", "rsw"]) writeFileSync(join(mapDir, `${map}.${ext}`), rawFiles[ext]);

  const { models: modelNames, waterType, effects: rswEffects } = parseRsw(rawFiles.rsw);
  const modelMap = {}; // normName -> ../_m/<hash>.rsm
  const textureNames = new Set();
  for (const name of parseGndTextures(rawFiles.gnd)) textureNames.add(normName(name));

  let modelMissing = 0;
  for (const name of modelNames) {
    const key = normName(name);
    if (modelMap[key]) continue;
    const entry = index.get(`data/model/${key}`);
    if (!entry) { modelMissing++; continue; }
    const bytes = extractFile(grf, entry);
    modelMap[key] = "../" + store("_m", "rsm", bytes);
    try {
      for (const tex of parseRsmTextures(bytes)) textureNames.add(normName(tex));
    } catch (err) {
      console.warn(`  ! ${map}: RSM texture parse failed for ${key}: ${err.message}`);
    }
  }

  const textureMap = {}; // normName -> ../_t/<hash>.png
  let texMissing = 0;
  let texFailed = 0;
  for (const key of textureNames) {
    if (!key) continue;
    const entry = index.get(`data/texture/${key}`);
    if (!entry) { texMissing++; continue; }
    const png = effectTextureToPng(extractFile(grf, entry), key);
    if (!png) { texFailed++; continue; }
    textureMap[key] = "../" + store("_t", "png", png);
  }

  // Animated water: the 32 JPG frames for this map's water type, served as-is.
  const waterFrames = [];
  for (let n = 0; n < 32; n++) {
    const nn = String(n).padStart(2, "0");
    const entry = index.get(`data/texture/워터/water${waterType}${nn}.jpg`);
    if (!entry) continue;
    waterFrames.push("../" + store("_w", "jpg", extractFile(grf, entry)));
  }

  const manifest = {
    map,
    files: { gat: `${map}.gat`, gnd: `${map}.gnd`, rsw: `${map}.rsw` },
    models: modelMap,
    textures: textureMap,
    water: { type: waterType, frames: waterFrames },
    ui,
  };
  // Per-map fog (from data/fogparametertable.txt) — only present for maps with a
  // fog row; omitted otherwise. The .rsw carries no fog data of its own.
  const fog = fogTable && fogTable.get(map);
  if (fog) manifest.fog = fog;

  // In-world effects: one entry per placed type-4 object. Two renderable kinds:
  //  - STR effects (`str` = the id's deduped set of /effects/<key>/ bundles built
  //    by --effects); positions are NOT deduped — the client proximity-culls.
  //  - Parametric emitters (EF_EMITTER/ANIMATED_EMITTER/MAGIC_FLOOR): not .str —
  //    each placement is matched by horizontal (X/Z) position to its EffectTool
  //    lub entry, whose particle spec is baked inline as `emitter` (texture
  //    rewritten into the shared _t store). Effects that are neither (e.g. id 45
  //    EF_FIREFLY, a FUNC, or the hardcoded classic light/torch/pillar effects)
  //    are skipped — the client draws those procedurally with no data we can ship.
  const hasEmitters = rswEffects.some((e) => EMITTER_EFFECT_IDS.has(e.id));
  const emitterEntries = hasEmitters ? readMapEmitters(grf, index, map) : [];
  const emitterTexCache = new Map(); // normalized texture name -> ../_t/<hash>.png | null
  // Resolve an emitter texture (e.g. "effect\\smoke2.bmp" / "smoke2.bmp") into the
  // shared _t store, relative to data/texture/effect/ (then data/texture/).
  const resolveEmitterTexture = (texName) => {
    const key = normName(texName);
    if (emitterTexCache.has(key)) return emitterTexCache.get(key);
    const rel = key.replace(/^effect\//, "");
    const ent = index.get(`data/texture/effect/${rel}`) || index.get(`data/texture/${rel}`);
    let served = null;
    if (ent) {
      const png = effectTextureToPng(extractFile(grf, ent), rel);
      if (png) served = "../" + store("_t", "png", png);
    }
    emitterTexCache.set(key, served);
    return served;
  };
  // Nearest lub entry to a placement by X/Z (.rsw pos is ÷5; lub pos is raw), within
  // 5 world units. The lub `pos` is dropped from the baked spec (the placement's own
  // `pos` is authoritative and scene-consistent); `texture` is rewritten to a path.
  const matchEmitter = (e) => {
    const rx = e.pos[0] * 5, rz = e.pos[2] * 5;
    let best = null, bestD = Infinity;
    for (const rec of emitterEntries) {
      const dx = rec.pos[0] - rx, dz = rec.pos[2] - rz;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = rec; }
    }
    if (!best || bestD > 25) return null;
    const { pos, ...spec } = best;
    if (typeof spec.texture === "string") spec.texture = resolveEmitterTexture(spec.texture);
    return spec;
  };

  const mapEffects = [];
  let emitterMissed = 0;
  for (const e of rswEffects) {
    const refs = effectStrRefs(e.id);
    if (refs.length) {
      mapEffects.push({ id: e.id, pos: e.pos, str: refs.map((r) => r.key), delay: e.delay, param: e.param });
      continue;
    }
    if (EMITTER_EFFECT_IDS.has(e.id)) {
      const spec = matchEmitter(e);
      if (spec) mapEffects.push({ id: e.id, pos: e.pos, delay: e.delay, param: e.param, emitter: spec });
      else emitterMissed++;
    }
  }
  if (mapEffects.length) manifest.effects = mapEffects;

  writeFileSync(join(mapDir, "manifest.json"), JSON.stringify(manifest));

  return {
    models: Object.keys(modelMap).length,
    modelTotal: modelNames.length,
    modelMissing,
    textures: Object.keys(textureMap).length,
    textureTotal: textureNames.size,
    texMissing,
    texFailed,
    waterType,
    waterFrames: waterFrames.length,
    fog: !!fog,
    effects: mapEffects.length,
    emitters: mapEffects.filter((e) => e.emitter).length,
    emitterMissed,
  };
}

// Parse a fog colour token → [r, g, b] in 0..1, or null if unparseable. The
// official table stores it as a packed "0xAARRGGBB" D3DCOLOR (leading alpha byte
// then big-endian RGB); we drop the alpha and keep the low three bytes (R = high
// byte) ÷ 255. A bare 6-digit "RRGGBB" (no 0x) is accepted too.
function parseFogColor(tok) {
  let h = tok.trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  if (h.length === 8) h = h.slice(2); // drop the leading alpha byte of AARRGGBB
  if (h.length !== 6) return null;
  const v = parseInt(h, 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

// Parse data/fogparametertable.txt → Map(mapName → fog block). Each record is the
// five "#"-terminated fields  <mapname># <near># <far># <colorHex># <factor>#  —
// the official client puts each field on its own line, so we tokenize on "#"
// across newlines (which also handles a single-line-per-map layout). Comments
// start with "//". The map key may carry a .rsw/.gat/.gnd suffix — stripped and
// lowercased to match the manifest key. near/far/factor are raw floats (the
// client multiplies near/far by 240 itself); colorHex → three 0..1 RGB floats.
// The table is ASCII in its data fields (EUC-KR only in comments), so latin1
// decoding is safe for the rows.
export function parseFogTable(bytes) {
  const tokens = Buffer.from(bytes)
    .toString("latin1")
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, "")) // strip whole-line and trailing comments
    .join("\n")
    .split("#")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const fog = new Map();
  // Records are exactly five fields; grouping positionally stays aligned even if
  // an individual record is malformed (we just skip that group).
  for (let i = 0; i + 4 < tokens.length; i += 5) {
    const name = tokens[i].replace(/\.(rsw|gat|gnd)$/i, "").toLowerCase();
    const near = parseFloat(tokens[i + 1]);
    const far = parseFloat(tokens[i + 2]);
    const color = parseFogColor(tokens[i + 3]);
    const factor = parseFloat(tokens[i + 4]);
    if (!name || !color || !Number.isFinite(near) || !Number.isFinite(far) || !Number.isFinite(factor)) continue;
    fog.set(name, { near, far, color, factor });
  }
  return fog;
}

function extractMaps(grfPath, outBase, args) {
  const grf = openGrf(grfPath);
  try {
    const root = resolve(outBase);
    const single = args.map ? args.map.toLowerCase() : null;

    // A full run rebuilds the whole tree (and its shared stores) deterministically;
    // a single --map run leaves the existing tree in place and just refreshes that
    // map plus any new shared blobs.
    if (!single) rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });

    const store = makeBlobStore(root);

    console.error("Indexing GRF entries…");
    const index = buildEntryIndex(grf);

    console.error("Extracting shared cursor/grid UI…");
    const ui = extractMapUi(grf, index, store);

    // Per-map fog table (folded into each manifest like the ui block).
    const fogEntry = index.get("data/fogparametertable.txt");
    const fogTable = fogEntry ? parseFogTable(extractFile(grf, fogEntry)) : new Map();
    if (fogEntry) console.error(`fogparametertable.txt: ${fogTable.size} map fog entries`);
    else console.warn("  ! data/fogparametertable.txt not found in GRF — manifests will omit fog");

    const names = single ? [single] : listMapNames(grf);
    console.error(`Extracting ${names.length} map${names.length === 1 ? "" : "s"} → ${root}`);

    const extracted = [];
    let skipped = 0;
    let foggy = 0;
    let effecty = 0;
    for (const map of names) {
      try {
        const r = extractOneMap(grf, index, map, root, store, ui, fogTable);
        if (r.skipped) { skipped++; console.warn(`  - skip ${map} (${r.skipped})`); continue; }
        extracted.push(map);
        if (r.fog) foggy++;
        if (r.effects) effecty++;
        if (single || extracted.length % 25 === 0) {
          console.error(
            `  ✓ ${map}: ${r.models}/${r.modelTotal} models, ${r.textures}/${r.textureTotal} textures, ` +
              `water ${r.waterType} (${r.waterFrames}/32)` +
              (r.effects ? `, ${r.effects} effects` : "") +
              (extracted.length % 25 === 0 && !single ? `  [${extracted.length}/${names.length}]` : ""),
          );
        }
      } catch (err) {
        skipped++;
        console.warn(`  ! ${map}: ${err.message}`);
      }
    }

    // index.json lists every map. For a single --map run, merge into the existing
    // index rather than clobbering the full catalogue.
    let allMaps = extracted;
    if (single) {
      try {
        const prev = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));
        allMaps = [...new Set([...(prev.maps || []), ...extracted])];
      } catch {
        // no prior index — start fresh
      }
    }
    allMaps.sort();
    writeFileSync(join(root, "index.json"), JSON.stringify({ maps: allMaps }));

    console.error(
      `\nMaps → ${root}\n` +
        `  extracted: ${extracted.length}\n` +
        `  skipped:   ${skipped}\n` +
        `  with fog:  ${foggy}\n` +
        `  with effects: ${effecty}\n` +
        `  index.json: ${allMaps.length} maps`,
    );
  } finally {
    closeGrf(grf);
  }
}

// ---------------------------------------------------------------------------
// BGM extraction — per-map background music.
//
// The client maps each world map to a BGM track in data/mp3nametable.txt (lines
// of the form "<map>.rsw#bgm\\<file>.mp3#"); the .mp3 files themselves are loose
// on disk in the client's BGM/ folder, not inside the GRF. We parse the table,
// copy every *referenced* track once (tracks are uniquely numbered, so the
// basename de-duplicates naturally), and emit:
//
//   <out>/<file>.mp3     each referenced track (copied verbatim)
//   <out>/index.json     { maps: { "<map>": "<file>.mp3", … } }
//
// The gateway serves <out>/ at /bgm/ (/bgm/index.json + /bgm/<file>.mp3).
// ---------------------------------------------------------------------------

// Parse data/mp3nametable.txt → Map(mapName → mp3 basename). Comment lines start
// with "//"; data lines are "<map>.rsw#bgm\<file>.mp3#" (the path separator and
// trailing junk after the closing "#" vary, so we match leniently). The table is
// EUC-KR in its comments but pure ASCII in the data fields.
function parseMp3NameTable(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  const re = /^([A-Za-z0-9_@-]+)\.rsw#\s*bgm[\\/]+([^#]+?\.mp3)\s*#/i;
  const map = new Map();
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("//")) continue;
    const m = re.exec(line);
    if (!m) continue;
    const name = m[1].toLowerCase();
    // The mp3 field may carry a sub-path; keep only the basename.
    const file = m[2].replace(/^.*[\\/]/, "").toLowerCase();
    map.set(name, file);
  }
  return map;
}

function extractBgm(grfPath, outBase, args) {
  const grf = openGrf(grfPath);
  try {
    const root = resolve(outBase);

    const entry = findBestEntry(grf, normalize("data/mp3nametable.txt"));
    if (!entry) throw new Error("data/mp3nametable.txt not found in GRF");
    const mapToFile = parseMp3NameTable(extractFile(grf, entry));
    console.error(`mp3nametable.txt: ${mapToFile.size} map→bgm mappings`);

    // BGM tracks live next to the GRF (client BGM/ folder), not in the GRF.
    const srcDir = args.bgmsrc ? resolve(args.bgmsrc) : join(dirname(resolve(grfPath)), "BGM");
    if (!existsSync(srcDir)) throw new Error(`BGM source dir not found: ${srcDir} (pass --bgmsrc <dir>)`);
    // Case-insensitive index of the on-disk filenames (the table is lowercase).
    const onDisk = new Map();
    for (const f of readdirSync(srcDir)) onDisk.set(f.toLowerCase(), f);

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });

    const maps = {};
    const copied = new Set();
    const missing = new Set();
    for (const [name, file] of mapToFile) {
      const actual = onDisk.get(file);
      if (!actual) { missing.add(file); continue; }
      if (!copied.has(file)) {
        copyFileSync(join(srcDir, actual), join(root, file));
        copied.add(file);
      }
      maps[name] = file;
    }

    const sorted = Object.fromEntries(Object.keys(maps).sort().map((k) => [k, maps[k]]));
    writeFileSync(join(root, "index.json"), JSON.stringify({ maps: sorted }));

    console.error(
      `\nBGM → ${root}\n` +
        `  maps mapped: ${Object.keys(maps).length}\n` +
        `  tracks copied: ${copied.size} (${[...missing].length} referenced track(s) missing on disk)\n` +
        `  index.json: ${Object.keys(sorted).length} maps`,
    );
    if (missing.size) console.warn(`  ! missing tracks: ${[...missing].sort().join(", ")}`);
  } finally {
    closeGrf(grf);
  }
}

// Run the CLI only when executed directly (not when imported by a test).
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
