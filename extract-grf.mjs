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
// Credits: GRF reader, icon pipeline and the mini Lua 5.1 VM extracted from
// adsonpleal/ragreplaystats (tools/build-db.mjs + tools/lua51.mjs).
// The DES routine is ported from vthibault/grf-loader (MIT).

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

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
    ].join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.list && !args.extract && !args.dump && !args.icons)) {
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

main();
