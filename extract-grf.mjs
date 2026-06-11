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
// Credits: GRF reader extracted from adsonpleal/ragreplaystats (tools/build-db.mjs).
// The DES routine is ported from vthibault/grf-loader (MIT).

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { inflateSync } from "node:zlib";

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
      "",
      "  --match is a regex tested against stored names (backslash separators).",
      '  e.g. --match "data\\\\(sprite|palette|imf|luafiles514)\\\\"',
    ].join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.list && !args.extract && !args.dump)) {
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

main();
