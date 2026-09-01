// Tests for extract-grf.mjs pure parsers. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LuaTable,
  parseAegisMap,
  parseLuaConstants,
  jtIdsFromConstants,
  jobLabelsFromConstants,
  projectJobs,
  projectItems,
  projectPackages,
  projectSkills,
  projectStatus,
  runChunk,
  projectRandomOpt,
  paletteSwatches,
  parseFogTable,
  parseRsw,
  expandStrFiles,
  effectStrKey,
  effectStrPath,
  effectMaxKey,
  resolveStr,
  effectStrRefs,
  decodeSprFrames,
  parseActFrames,
  compositeActFrame,
  parseWav,
  encodeWavPcm,
  decodeImaAdpcm,
  toPlayableWav,
  decodeClientString,
  actDrawsNothing,
  hatEffectSprite,
  sprEffectCandidates,
  parseCardIllustTable,
  pickCardIllust,
  robeTemplateHashes,
} from "./extract-grf.mjs";

// The real data/fogparametertable.txt lays out each record across five
// "#"-terminated lines, with the colour as a packed 0xAARRGGBB D3DCOLOR.
test("parseFogTable parses the official multi-line / 0xAARRGGBB layout", () => {
  const table = [
    "//--- brazil localizing data",
    "bra_fild01.rsw#",
    "0.1#",
    "0.6#",
    "0xff638f1e#",
    "0.3#",
  ].join("\r\n");
  const fog = parseFogTable(Buffer.from(table, "latin1"));

  assert.deepEqual(fog.get("bra_fild01"), {
    near: 0.1,
    far: 0.6,
    // alpha byte (ff) dropped; RGB = 63 8f 1e
    color: [0x63 / 255, 0x8f / 255, 0x1e / 255],
    factor: 0.3,
  });
});

test("parseFogTable also accepts the single-line / bare-RRGGBB layout", () => {
  const fog = parseFogTable(Buffer.from("prontera#0.6#1.8#c79e8c#1.0#", "latin1"));
  assert.deepEqual(fog.get("prontera"), {
    near: 0.6,
    far: 1.8,
    color: [0xc7 / 255, 0x9e / 255, 0x8c / 255],
    factor: 1.0,
  });
});

test("parseFogTable normalizes the map key (suffix + case) and keeps @-maps", () => {
  const fog = parseFogTable(
    Buffer.from(["1@nyd.rsw#0.1#0.8#0x5548d1cc#0.7#", "ALBERTA.GAT#0.3#1.2#0xff000000#0.5#"].join("\n"), "latin1"),
  );
  assert.ok(fog.has("1@nyd"));
  assert.ok(fog.has("alberta"));
  assert.deepEqual(fog.get("alberta").color, [0, 0, 0]);
});

test("parseFogTable stays aligned past a malformed record", () => {
  const fog = parseFogTable(
    Buffer.from(
      [
        "badcolor#0.1#0.6#nothex#0.3#", // bad colour → skipped, grouping preserved
        "goodmap#0.2#0.9#0x00abcdef#0.5#",
      ].join("\n"),
      "latin1",
    ),
  );
  assert.equal(fog.size, 1);
  assert.deepEqual(fog.get("goodmap"), {
    near: 0.2,
    far: 0.9,
    color: [0xab / 255, 0xcd / 255, 0xef / 255],
    factor: 0.5,
  });
});

// --- RSW in-world effect (.str) extraction ------------------------------------

// Build a minimal-but-valid RSW 2.1 carrying `effects` type-4 objects, exercising
// the same field path the real client maps (e.g. iz_dun03) hit. Each effect is
// name(80) + pos[3] + id + delay + param[4]; positions are written ×5 so the
// parser's ÷5 yields the input coordinates.
function buildRsw21(effects) {
  const buf = Buffer.alloc(4096);
  let p = 0;
  const wStr = (s, n) => { buf.write(s, p, "latin1"); p += n; };
  const wI8 = (v) => { buf.writeInt8(v, p); p += 1; };
  const wI32 = (v) => { buf.writeInt32LE(v, p); p += 4; };
  const wF32 = (v) => { buf.writeFloatLE(v, p); p += 4; };
  wStr("GRSW", 4);
  wI8(2); wI8(1); // version 2.1
  wStr("", 40); wStr("", 40); wStr("", 40); // ini/gnd/gat
  wStr("", 40); // src (>=1.4)
  wF32(0); // water level (>=1.3)
  wI32(3); wF32(0); wF32(0); wF32(0); // waterType=3 + wave fields (>=1.8)
  wI32(0); // animSpeed (>=1.9)
  wI32(0); wI32(0); wF32(0); wF32(0); wF32(0); wF32(0); wF32(0); wF32(0); // lon/lat + diffuse + ambient (>=1.5)
  wF32(0); // opacity (>=1.7)
  wI32(0); wI32(0); wI32(0); wI32(0); // ground bounds (>=1.6)
  wI32(effects.length); // object count
  for (const e of effects) {
    wI32(4); // type 4
    wStr(e.name || "", 80);
    wF32(e.pos[0] * 5); wF32(e.pos[1] * 5); wF32(e.pos[2] * 5);
    wI32(e.id);
    wF32(e.delay);
    wF32(e.param[0]); wF32(e.param[1]); wF32(e.param[2]); wF32(e.param[3]);
  }
  return new Uint8Array(buf.subarray(0, p));
}

test("parseRsw reads type-4 effects: id, ÷5 pos, delay, param[4]", () => {
  const bytes = buildRsw21([
    { name: "bubble", id: 109, pos: [100, -22.5, -34.25], delay: 0, param: [0, 0, 0, 0] },
    { name: "firefly", id: 45, pos: [10, 1, 2], delay: 500, param: [0.1, 0.1, 0, 0] },
  ]);
  const { waterType, effects } = parseRsw(bytes);
  assert.equal(waterType, 3);
  assert.equal(effects.length, 2);
  assert.deepEqual(effects[0], { id: 109, pos: [100, -22.5, -34.25], delay: 0, param: [0, 0, 0, 0] });
  assert.equal(effects[1].id, 45);
  assert.equal(effects[1].delay, 500);
});

test("expandStrFiles expands %d over rand, else takes the file verbatim", () => {
  assert.deepEqual(expandStrFiles({ file: "bubble%d", rand: [1, 4] }), ["bubble1", "bubble2", "bubble3", "bubble4"]);
  // bare rand without %d is a render hint we ignore (e.g. quagmire)
  assert.deepEqual(expandStrFiles({ file: "quagmire", rand: [1, 4] }), ["quagmire"]);
  assert.deepEqual(expandStrFiles({ file: "freezing" }), ["freezing"]);
});

test("effectStrKey is the URL-safe basename, null for non-ASCII", () => {
  assert.equal(effectStrKey("bubble1"), "bubble1");
  assert.equal(effectStrKey("RL_C_MAKER/cm"), "cm");
  assert.equal(effectStrKey("ach_complete/ppring3"), "ppring3");
  assert.equal(effectStrKey("빨간포션"), null);
});

test("effectStrPath folds ../ under data/texture/effect/", () => {
  assert.equal(effectStrPath("bubble1"), "data/texture/effect/bubble1.str");
  assert.equal(effectStrPath("../npc/hydra_atk"), "data/texture/npc/hydra_atk.str");
  assert.equal(effectStrPath("RL_C_MAKER/cm"), "data/texture/effect/rl_c_maker/cm.str");
});

test("effectStrRefs resolves EF_BUBBLE (109) to bubble1..4 and skips non-STR ids", () => {
  const refs = effectStrRefs(109);
  assert.deepEqual(refs.map((r) => r.key), ["bubble1", "bubble2", "bubble3", "bubble4"]);
  assert.equal(refs[0].path, "data/texture/effect/bubble1.str");
  assert.deepEqual(effectStrRefs(45), []); // EF_FIREFLY is a FUNC — not in the table
  assert.deepEqual(effectStrRefs(204), []); // Korean-named potion — unservable key
});

// robeTemplateHashes takes folder -> per-job sprite entries and reports the
// contents so many folders share that they can only be template leftovers.
// `sprites` below is written the way the real tree reads: a garment's own bank is
// unique to it, a leftover repeats verbatim across unrelated costumes.
function robeIndex(sprites) {
  return new Map(
    Object.entries(sprites).map(([folder, hashes]) => [folder, hashes.map((hash) => ({ hash }))]),
  );
}

test("robeTemplateHashes picks the widely-shared contents, not the per-folder banks", () => {
  const spread = (n, hash) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c_g${i}`, ["own" + i, hash]]));
  // "bag" sits in 12 folders next to each one's own sprite; only "bag" is shared.
  const hits = robeTemplateHashes(robeIndex(spread(12, "bag")), 10);
  assert.deepEqual([...hits], ["bag"]);
});

test("robeTemplateHashes leaves art a couple of sibling folders share alone", () => {
  // The client also ships small families (a costume under its Korean and English
  // folder name, the four angel-wing variants) whose art is legitimately equal.
  // Those must survive — the threshold is what separates them from the template.
  const idx = robeIndex({
    thanatos_sword: ["sword", "hilt"],
    "타나토스의검": ["sword", "hilt"],
    c_cat_fork: ["sword", "fork"],
  });
  assert.deepEqual([...robeTemplateHashes(idx, 10)], []);
});

test("robeTemplateHashes counts folders, not files", () => {
  // One folder repeating a content across all its job slots is the normal case
  // for a garment with a single image bank — it is not evidence of a template.
  const idx = robeIndex({ c_solo: Array(300).fill("same") });
  assert.deepEqual([...robeTemplateHashes(idx, 10)], []);
});

// A minimal SPR (v2.1) carrying a single 1x2 truecolor (RGBA) frame. Each pixel
// is stored as 4 bytes in ABGR order (the order the sprite map-effects use).
function buildSprRgba(version, pixelsABGR, width, height) {
  const head = Buffer.alloc(8);
  head[0] = 0x53; head[1] = 0x50; // "SP"
  head[2] = Math.round((version % 1) * 10); // minor
  head[3] = Math.floor(version); // major
  head.writeUInt16LE(0, 4); // 0 palette frames
  head.writeUInt16LE(1, 6); // 1 rgba frame
  const dim = Buffer.alloc(4);
  dim.writeUInt16LE(width, 0);
  dim.writeUInt16LE(height, 2);
  return new Uint8Array(Buffer.concat([head, dim, Buffer.from(pixelsABGR)]));
}

test("decodeSprFrames reads truecolor frames and swizzles ABGR → RGBA", () => {
  // two pixels: ABGR (0x80,0x10,0x20,0x30) and (0x00,0x01,0x02,0x03)
  const spr = buildSprRgba(2.1, [0x80, 0x10, 0x20, 0x30, 0x00, 0x01, 0x02, 0x03], 1, 2);
  const frames = decodeSprFrames(spr);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].width, 1);
  assert.equal(frames[0].height, 2);
  // R=byte3, G=byte2, B=byte1, A=byte0
  assert.deepEqual([...frames[0].rgba], [0x30, 0x20, 0x10, 0x80, 0x03, 0x02, 0x01, 0x00]);
});

// Build a v2.3 ACT with one action whose motions reference the given layer-0
// sprite indices, and a single per-action delay (stored as delay/25). Exercises
// the corrected 2.x layer layout: 4-byte packed colour (not 4 floats) and the
// 16-byte attach points, plus the trailing events + delays sections.
function buildAct23(indices, delayMs, alpha = 255) {
  const parts = [];
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b; };
  const header = Buffer.alloc(16);
  header[0] = 0x41; header[1] = 0x43; // "AC"
  header[2] = 3; header[3] = 2; // version 2.3
  header.writeUInt16LE(1, 4); // 1 action
  parts.push(header);
  parts.push(i32(indices.length)); // motion count
  for (const idx of indices) {
    parts.push(Buffer.alloc(32)); // range1[4] + range2[4]
    parts.push(i32(1)); // one layer
    parts.push(i32(0), i32(0)); // x, y
    parts.push(i32(idx)); // sprite index
    parts.push(i32(0)); // mirror
    parts.push(Buffer.from([255, 255, 255, alpha])); // packed colour (4 bytes)
    parts.push(f32(1)); // scaleX (scaleY copied at 2.3)
    parts.push(i32(0), i32(0)); // rotation, sprite type
    parts.push(i32(-1)); // event id
    parts.push(i32(0)); // 0 attach points
  }
  parts.push(i32(0)); // 0 sound events
  parts.push(f32(delayMs / 25)); // single per-action delay
  return new Uint8Array(Buffer.concat(parts));
}

test("parseActFrames reads the 2.x layer layout, events and per-action delays", () => {
  const act = buildAct23([5, 6, 5], 100);
  const { actions, delays } = parseActFrames(act);
  // One action of three single-layer frames; each layer carries full placement.
  assert.equal(actions.length, 1);
  assert.deepEqual(
    actions[0].map((frame) => frame.map((l) => l.index)),
    [[5], [6], [5]],
  );
  assert.deepEqual(actions[0][0][0], {
    x: 0, y: 0, index: 5, sprType: 0, mirror: 0,
    color: [255, 255, 255, 255], scaleX: 1, scaleY: 1, rotation: 0,
  });
  assert.deepEqual(delays, [100]); // stored value (4.0) × 25
});

// compositeActFrame bakes a frame's layer stack into one image and reports the
// centre of that image relative to the act origin. Two 2x2 RGBA layers offset on
// the y axis (centres at y=-10 and y=10) span y∈[-11,11] → a 4x22 image centred
// at (0, 0); the upper layer sits in the top rows, the lower in the bottom.
test("compositeActFrame composites layers and reports the image centre offset", () => {
  const solid = (r, g, b) => ({
    width: 2, height: 2, type: 1,
    rgba: new Uint8Array([r, g, b, 255, r, g, b, 255, r, g, b, 255, r, g, b, 255]),
  });
  const framesByType = [[], [solid(10, 20, 30), solid(40, 50, 60)]];
  const layer = (index, y) => ({
    x: 0, y, index, sprType: 1, mirror: 0,
    color: [255, 255, 255, 255], scaleX: 1, scaleY: 1, rotation: 0,
  });
  const out = compositeActFrame(framesByType, [layer(0, -10), layer(1, 10)]);
  assert.equal(out.width, 2);
  assert.equal(out.height, 22);
  assert.deepEqual(out.offset, [0, 0]);
  // Top row is the y=-10 layer (10,20,30); bottom row is the y=10 layer (40,50,60).
  assert.deepEqual([...out.rgba.slice(0, 4)], [10, 20, 30, 255]);
  const last = (out.width * out.height - 1) * 4;
  assert.deepEqual([...out.rgba.slice(last, last + 4)], [40, 50, 60, 255]);
});

// --- sound extraction: WAV muxing + ADPCM transcode -------------------------

// Build a minimal WAV: fmt (with optional extra bytes) + data chunk.
function makeWav({ audioFormat, channels, sampleRate, blockAlign, bits, ext = Buffer.alloc(0), data }) {
  const fmtBody = Buffer.alloc(16 + ext.length);
  fmtBody.writeUInt16LE(audioFormat, 0);
  fmtBody.writeUInt16LE(channels, 2);
  fmtBody.writeUInt32LE(sampleRate, 4);
  fmtBody.writeUInt32LE(sampleRate * blockAlign, 8);
  fmtBody.writeUInt16LE(blockAlign, 12);
  fmtBody.writeUInt16LE(bits, 14);
  ext.copy(fmtBody, 16);
  const chunk = (id, body) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, "ascii");
    h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body, body.length & 1 ? Buffer.from([0]) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), chunk("fmt ", fmtBody), chunk("data", data)]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

test("encodeWavPcm/parseWav round-trip preserves the format and samples", () => {
  const pcm = Buffer.from(Int16Array.from([0, 1000, -1000, 32767, -32768]).buffer);
  const wav = encodeWavPcm(pcm, 1, 22050, 16);
  const parsed = parseWav(wav);
  assert.equal(parsed.fmt.audioFormat, 1);
  assert.equal(parsed.fmt.channels, 1);
  assert.equal(parsed.fmt.sampleRate, 22050);
  assert.equal(parsed.fmt.bits, 16);
  assert.equal(parsed.data.len, pcm.length);
  assert.deepEqual(wav.subarray(parsed.data.offset, parsed.data.offset + parsed.data.len), pcm);
});

test("toPlayableWav passes standard PCM through verbatim", () => {
  const pcm = Buffer.from(Int16Array.from([1, 2, 3, 4]).buffer);
  const wav = makeWav({ audioFormat: 1, channels: 1, sampleRate: 22050, blockAlign: 2, bits: 16, data: pcm });
  const r = toPlayableWav(wav);
  assert.equal(r.transcoded, false);
  assert.equal(r.format, 1);
  assert.deepEqual(r.bytes, wav); // byte-for-byte, no re-muxing
});

test("toPlayableWav transcodes IMA ADPCM to PCM (first sample = block predictor)", () => {
  // One mono IMA block: predictor=1234, stepIndex=0, reserved=0, then 4 data bytes.
  const block = Buffer.alloc(8);
  block.writeInt16LE(1234, 0);
  block[2] = 0; // step index
  block[3] = 0; // reserved
  block[4] = 0x00; block[5] = 0x11; block[6] = 0x22; block[7] = 0x33; // 8 nibbles
  const wav = makeWav({ audioFormat: 17, channels: 1, sampleRate: 22050, blockAlign: 8, bits: 4, data: block });
  const r = toPlayableWav(wav);
  assert.equal(r.transcoded, true);
  assert.equal(r.format, 17);
  const out = parseWav(r.bytes);
  assert.equal(out.fmt.audioFormat, 1); // now standard PCM
  assert.equal(out.fmt.bits, 16);
  // 1 header sample + 8 nibble samples = 9 samples (18 bytes).
  assert.equal(out.data.len, 18);
  const first = r.bytes.readInt16LE(out.data.offset);
  assert.equal(first, 1234); // IMA's first emitted sample is the stored predictor
});

test("decodeImaAdpcm keeps every decoded sample in int16 range", () => {
  const block = Buffer.alloc(12);
  block.writeInt16LE(-5000, 0);
  block[2] = 40; // a large step index — exercises growth/clamping
  block.fill(0xff, 4); // max-magnitude nibbles
  const pcm = decodeImaAdpcm(block, { channels: 1, blockAlign: 12 }, { offset: 0, len: 12 });
  assert.equal(pcm.length % 2, 0);
  for (let i = 0; i < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    assert.ok(s >= -32768 && s <= 32767, `sample ${s} out of range`);
  }
});

// ---------------------------------------------------------------------------
// Raw data tables (--raw)
// ---------------------------------------------------------------------------

// data/itemmoveinfov5.txt puts the real item_db aegis name in a trailing
// comment, but only on most lines — the early rows carry prose or Korean, and
// taking those would put junk in items.json's aegisName.
test("parseAegisMap keeps only clean aegis tokens from the trailing comment", () => {
  const txt = [
    "// header comment, not a record",
    "501\t0\t0\t0\t// Red_Potion",
    "1101\t1\t0\t0\t// Sword",
    "999\t0\t0\t0\t// cash item, tradable", // prose (spaces) — rejected
    "998\t0\t0\t0\t// 빨간포션", // Korean — rejected
    "997\t0\t0\t0\t// lowercase", // no underscore and no capital — rejected
    "996\t0\t0\t0\t// E_Illusion_Armor_A",
  ].join("\r\n");

  const map = parseAegisMap(txt);
  assert.deepEqual([...map.entries()].sort((a, b) => a[0] - b[0]), [
    [501, "Red_Potion"],
    [996, "E_Illusion_Armor_A"],
    [1101, "Sword"],
  ]);
});

// Build a minimal but structurally complete Lua 5.1 chunk, so the constant-pool
// walk is exercised against real offsets rather than a hand-waved buffer.
function luaChunk({ constants = [], protos = [], code = [], codeCount = code.length, lineInfo = 0, locals = [], upvalues = [] } = {}) {
  const parts = [];
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const str = (s) => (s === null ? u32(0) : Buffer.concat([u32(s.length + 1), Buffer.from(`${s}\0`, "latin1")]));

  parts.push(str("@test.lua"));
  parts.push(u32(0), u32(0)); // linedefined, lastlinedefined
  parts.push(Buffer.from([0, 0, 0, 2])); // nups, numparams, is_vararg, maxstacksize
  const codeBuf = Buffer.alloc(codeCount * 4);
  code.forEach((word, i) => codeBuf.writeUInt32LE(word >>> 0, i * 4));
  parts.push(u32(codeCount), codeBuf); // code
  parts.push(u32(constants.length));
  for (const k of constants) {
    if (k === null) parts.push(Buffer.from([0]));
    else if (typeof k === "boolean") parts.push(Buffer.from([1, k ? 1 : 0]));
    else if (typeof k === "number") {
      const b = Buffer.alloc(9);
      b[0] = 3;
      b.writeDoubleLE(k, 1);
      parts.push(b);
    } else parts.push(Buffer.concat([Buffer.from([4]), str(k)]));
  }
  parts.push(u32(protos.length), ...protos);
  parts.push(u32(lineInfo), Buffer.alloc(lineInfo * 4));
  parts.push(u32(locals.length), ...locals.map((n) => Buffer.concat([str(n), u32(0), u32(0)])));
  parts.push(u32(upvalues.length), ...upvalues.map(str));

  const body = Buffer.concat(parts);
  const header = Buffer.from([0x1b, 0x4c, 0x75, 0x61, 0x51, 0, 1, 4, 4, 4, 8, 0]);
  return Buffer.concat([header, body]);
}

// Lua 5.1 instruction encoders, so the branch tests below read as the ops they
// assemble rather than as magic numbers.
const iABC = (op, a, b, c) => (op | (a << 6) | (c << 14) | (b << 23)) >>> 0;
const iABx = (op, a, bx) => (op | (a << 6) | (bx << 14)) >>> 0;
const iAsBx = (op, a, sbx) => iABx(op, a, sbx + 131071);
const OP = { LOADK: 1, GETGLOBAL: 5, SETGLOBAL: 7, NEWTABLE: 10, JMP: 22, TEST: 26, RETURN: 30, TFORLOOP: 33 };

// SkillInfoList_data.lub ends with `if <table> then for k,v in pairs(<table>) do
// … end end`, the only data chunk with real control flow — and the one the skill
// max levels come from. TEST has to fall *into* the body for a table that
// exists, and the generic for has to end (its iterator comes from a call, and
// calls are no-ops here) instead of jumping back into itself forever.
test("the VM follows a guarded pairs() loop: enters the body, ends the loop", () => {
  const globals = runChunk(
    luaChunk({
      constants: ["SkillInfoList_data", "entered", "pairs"],
      code: [
        iABC(OP.NEWTABLE, 0, 0, 0),
        iABx(OP.SETGLOBAL, 0, 0), // SkillInfoList_data = {}
        iABx(OP.GETGLOBAL, 1, 0), // R1 = SkillInfoList_data — a table, so true
        iABC(OP.TEST, 1, 0, 0), //   if it: step over the jump that skips the body
        iAsBx(OP.JMP, 0, 2), //      (skipped) past the loop
        iABC(OP.NEWTABLE, 2, 0, 0),
        iABx(OP.SETGLOBAL, 2, 1), // entered = {} — only reached inside the body
        iABx(OP.GETGLOBAL, 3, 2), // R3 = pairs — nothing this VM can call
        iABC(OP.TFORLOOP, 3, 0, 1),
        iAsBx(OP.JMP, 0, -5), //     (skipped) back into the loop body
        iABC(OP.RETURN, 0, 1, 0),
      ],
    }),
  );

  assert.ok(globals.get("SkillInfoList_data") instanceof LuaTable);
  assert.ok(globals.get("entered") instanceof LuaTable);
});

// The mirror case: a nil condition must take the jump and skip the body. Lua
// truthiness is the point — only nil and false are false, so a JS `if (R[a])`
// would wrongly skip a body guarded by 0 or "".
test("the VM jumps over a guarded body when the condition is nil", () => {
  const globals = runChunk(
    luaChunk({
      constants: ["missing", "entered"],
      code: [
        iABx(OP.GETGLOBAL, 0, 0), // R0 = missing — nil
        iABC(OP.TEST, 0, 0, 0),
        iAsBx(OP.JMP, 0, 2), //      taken: past the body
        iABC(OP.NEWTABLE, 1, 0, 0),
        iABx(OP.SETGLOBAL, 1, 1), // entered = {} — must not run
        iABC(OP.RETURN, 0, 1, 0),
      ],
    }),
  );

  assert.equal(globals.get("entered"), undefined);
});

test("the VM treats 0 and \"\" as true, the way Lua does", () => {
  for (const zero of [0, ""]) {
    const globals = runChunk(
      luaChunk({
        constants: [zero, "entered"],
        code: [
          iABx(OP.LOADK, 0, 0), // R0 = 0 / "" — false in JS, true in Lua
          iABC(OP.TEST, 0, 0, 0),
          iAsBx(OP.JMP, 0, 2),
          iABC(OP.NEWTABLE, 1, 0, 0),
          iABx(OP.SETGLOBAL, 1, 1),
          iABC(OP.RETURN, 0, 1, 0),
        ],
      }),
    );
    assert.ok(globals.get("entered") instanceof LuaTable, `${JSON.stringify(zero)} should be truthy`);
  }
});

// Regression: every section is length-prefixed, so a walker that advances by the
// payload size but forgets the count it just read lands 4 bytes short and starts
// reading a length as a constant tag. The non-zero code/lineinfo/local/upvalue
// counts here are what make that failure observable.
test("parseLuaConstants walks past code, protos and the debug sections", () => {
  const nested = luaChunk({ constants: ["JT_NOVICE", 0], codeCount: 3 });
  const consts = parseLuaConstants(
    luaChunk({
      constants: ["pcJobTbl", "JT_SWORDMAN", 1, true, null],
      protos: [nested.subarray(12)], // a proto is a bare function body, no header
      codeCount: 7,
      lineInfo: 5,
      locals: ["i", "v"],
      upvalues: ["_ENV"],
    }),
  );

  assert.deepEqual(consts, [
    { type: "string", value: "pcJobTbl" },
    { type: "string", value: "JT_SWORDMAN" },
    { type: "number", value: 1 },
    { type: "bool", value: true },
    { type: "nil" },
    // the nested proto's pool follows the parent's
    { type: "string", value: "JT_NOVICE" },
    { type: "number", value: 0 },
  ]);
});

test("parseLuaConstants rejects anything that isn't a little-endian Lua 5.1 chunk", () => {
  assert.equal(parseLuaConstants(Buffer.from("not a lua chunk at all")), null);
  const wrongVersion = luaChunk();
  wrongVersion[4] = 0x52; // Lua 5.2
  assert.equal(parseLuaConstants(wrongVersion), null);
  const bigEndian = luaChunk();
  bigEndian[6] = 0;
  assert.equal(parseLuaConstants(bigEndian), null);
});

// pcidentity.lub stores each JT_ name immediately followed by its id, and
// aliases some names onto ids already taken — first one wins.
test("jtIdsFromConstants pairs each JT_ name with the number after it, first id winning", () => {
  const ids = jtIdsFromConstants([
    { type: "string", value: "pcJobTbl" },
    { type: "string", value: "JT_NOVICE" },
    { type: "number", value: 0 },
    { type: "string", value: "JT_SWORDMAN" },
    { type: "number", value: 1 },
    { type: "string", value: "JT_NOVICE" }, // alias, ignored
    { type: "number", value: 4001 },
    { type: "string", value: "JT_ORPHAN" }, // no number follows
  ]);

  assert.deepEqual([...ids.entries()], [
    ["JT_NOVICE", 0],
    ["JT_SWORDMAN", 1],
  ]);
});

// pcjobnamegender.lub stores the label after the JT_ key, but the table names it
// also holds as constants sit in between and must not be mistaken for labels.
test("jobLabelsFromConstants skips the table-name constants and stops at the next JT_", () => {
  const labels = jobLabelsFromConstants([
    { type: "string", value: "JT_NOVICE" },
    { type: "string", value: "PCJobNameTableMan" },
    { type: "string", value: "Aprendiz" },
    { type: "string", value: "JT_SWORDMAN" },
    { type: "number", value: 99 }, // non-strings are skipped over
    { type: "string", value: "Espadachim" },
    { type: "string", value: "JT_UNLABELLED" },
    { type: "string", value: "JT_MAGICIAN" }, // next key — the one before has no label
    { type: "string", value: "Mago" },
  ]);

  assert.equal(labels.get("JT_NOVICE"), "Aprendiz");
  assert.equal(labels.get("JT_SWORDMAN"), "Espadachim");
  assert.equal(labels.get("JT_MAGICIAN"), "Mago");
  assert.equal(labels.has("JT_UNLABELLED"), false);
});

// The two id universes only partly overlap: a class can be named by pcidentity
// with no party icon (unreleased here) or ship an icon the name table misses.
test("projectJobs unions the named classes with the icon-only ones", () => {
  const jobs = projectJobs(
    [
      { type: "string", value: "JT_NOVICE" },
      { type: "number", value: 0 },
      { type: "string", value: "JT_SWORDMAN" },
      { type: "number", value: 1 },
      { type: "string", value: "JT_FUTURE" },
      { type: "number", value: 4302 },
    ],
    [
      { type: "string", value: "JT_NOVICE" },
      { type: "string", value: "Aprendiz" },
      { type: "string", value: "JT_SWORDMAN" },
      { type: "string", value: "Espadachim" },
    ],
    new Set([0, 1, 99]),
  );

  assert.deepEqual(jobs, [
    { id: 0, jt: "JT_NOVICE", name: "Aprendiz", hasIcon: true },
    { id: 1, jt: "JT_SWORDMAN", name: "Espadachim", hasIcon: true },
    // named but unreleased — no icon ships for it
    { id: 4302, jt: "JT_FUTURE", name: null, hasIcon: false },
    // icon-only: nothing names it, but /icons/job/99.png exists
    { id: 99, jt: null, name: null, hasIcon: true },
  ].sort((a, b) => a.id - b.id));
});

// Build a Lua table from a plain object/array, the way the client's chunks come
// out of the VM (numeric keys for the id-keyed tables).
function luaTable(entries) {
  const t = new LuaTable();
  for (const [k, v] of entries) t.set(k, v);
  return t;
}
function luaRecord(obj) {
  return luaTable(Object.entries(obj));
}

test("projectItems keeps the bare name and slot count apart, sorted by id", () => {
  const items = projectItems(
    luaTable([
      [1101, luaRecord({ identifiedDisplayName: "Espada", slotCount: 3, ClassNum: 2, identifiedResourceName: "sword" })],
      [501, luaRecord({ identifiedDisplayName: "Poção Vermelha", identifiedResourceName: "red_potion" })],
    ]),
    new Map([[1101, "Sword"]]),
  );

  assert.deepEqual(items.map((i) => i.id), [501, 1101]);
  // the "[3]" suffix is the client's display convention, not part of the name
  assert.equal(items[1].name, "Espada");
  assert.equal(items[1].slots, 3);
  assert.equal(items[1].view, 2);
  assert.equal(items[1].aegisName, "Sword");
  // no move-info row for 501 — aegisName stays null and the consumer falls back
  assert.equal(items[0].aegisName, null);
  assert.equal(items[0].resourceName, "red_potion");
  assert.equal(items[0].slots, 0);
  assert.equal(items[0].view, 0);
});

// item-views.json covers ~640 more items than any named table does, so dropping
// unnamed rows here would lose sprite ids the paper-doll needs.
test("projectItems keeps rows with no display name so their view survives", () => {
  const items = projectItems(
    luaTable([[2000, luaRecord({ ClassNum: 7, identifiedResourceName: "mystery" })]]),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].name, null);
  assert.equal(items[0].view, 7);
});

test("projectItems reads the equip slots and costume flag off the description", () => {
  const desc = luaTable([[1, "Equipa em: ^777777Topo, Meio e Baixo^000000"]]);
  const [item] = projectItems(
    luaTable([[5000, luaRecord({ identifiedDisplayName: "Capuz", identifiedDescriptionName: desc, costume: true })]]),
  );
  assert.deepEqual(item.equipSlots, ["top", "mid", "low"]);
  assert.equal(item.costume, true);
  assert.equal(item.description, "Equipa em: ^777777Topo, Meio e Baixo^000000");
});

test("projectPackages keys drop lists by the box's id, keeping prob and group raw", () => {
  const packages = projectPackages(
    luaTable([
      [
        107912,
        luaTable([
          [1, luaRecord({ id: 1000274, prob: 10, name: "Cupom da Kachua", group: 0 })],
          [2, luaRecord({ id: 23047, prob: 1400, name: "[Evento] Bênção de Tyr 5", group: 6 })],
        ]),
      ],
      ["nope", luaTable([[1, luaRecord({ id: 1, prob: 1, group: 0 })]])], // non-numeric box id
      [9999, luaTable([[1, luaRecord({ prob: 5, group: 0 })]])], // no drop id — nothing left to keep
    ]),
  );

  assert.deepEqual([...packages.keys()], [107912]);
  assert.deepEqual(packages.get(107912), [
    { id: 1000274, prob: 10, group: 0 },
    { id: 23047, prob: 1400, group: 6 },
  ]);
});

test("projectItems hangs the box contents off the box's own row", () => {
  const items = projectItems(
    luaTable([
      [107912, luaRecord({ identifiedDisplayName: "[Evento] Artefato Oval Noturno" })],
      [501, luaRecord({ identifiedDisplayName: "Poção Vermelha" })],
    ]),
    new Map(),
    null,
    new Map([[107912, [{ id: 23047, prob: 1400, group: 6 }]]]),
  );

  assert.deepEqual(items[1].contains, [{ id: 23047, prob: 1400, group: 6 }]);
  // a row that is not a box leaves the key out entirely rather than carrying an
  // empty array — the key is absent, not present-and-undefined
  assert.ok(!("contains" in items[0]));
  assert.deepEqual(Object.keys(items[0]).filter((k) => k === "contains"), []);
});

test("projectSkills and projectRandomOpt key by numeric id and drop nameless rows", () => {
  const skills = projectSkills(
    luaTable([
      [2, luaRecord({ SkillName: "Cura" })],
      [1, luaRecord({ SkillName: "Habilidades Básicas" })],
      [3, luaRecord({})], // no SkillName — skipped
    ]),
  );
  assert.deepEqual(skills, [
    { id: 1, name: "Habilidades Básicas", maxLevel: null, description: null, delay: null },
    { id: 2, name: "Cura", maxLevel: null, description: null, delay: null },
  ]);

  assert.deepEqual(projectRandomOpt(luaTable([[1, "HP máx. +%d"], ["VAR_MAXHP", "ignored"]])), [
    { id: 1, name: "HP máx. +%d" },
  ]);
});

// SKILL_DESCRIPT is a second table keyed by the same ids; its lines are joined
// verbatim (colour codes and breaks kept), and a skill it has no entry for stays
// listed with a null description rather than dropping out of skills.json.
test("projectSkills joins the SKILL_DESCRIPT lines and keeps undescribed skills", () => {
  const skills = projectSkills(
    luaTable([
      [28, luaRecord({ SkillName: "Cura" })],
      [1, luaRecord({ SkillName: "Habilidades Básicas" })],
    ]),
    luaTable([
      [28, luaTable([[1, "Cura"], [2, "Tipo: ^777777Ativa^000000"], [3, ""]])],
    ]),
  );
  assert.deepEqual(skills, [
    { id: 1, name: "Habilidades Básicas", maxLevel: null, description: null, delay: null },
    { id: 28, name: "Cura", maxLevel: null, description: "Cura\nTipo: ^777777Ativa^000000\n", delay: null },
  ]);
});

// SKILL_DELAY_LIST is the third table keyed by the same ids — the client's
// "Conjuração e Espera" window. Its per-level arrays go out verbatim (trailing
// zeros kept, nothing padded to a max level), and a column the client omits
// stays null so it can't be read as a zero delay.
test("projectSkills publishes the cast/delay arrays verbatim, per column", () => {
  const skills = projectSkills(
    luaTable([
      [155, luaRecord({ SkillName: "Grito de Guerra" })],
      [28, luaRecord({ SkillName: "Cura" })],
      [1, luaRecord({ SkillName: "Habilidades Básicas" })],
    ]),
    null,
    luaTable([
      [
        155,
        luaRecord({
          SkillCastFixedDelay: luaTable([[1, 300], [2, 0], [3, 0]]),
          SkillCastStatDelay: luaTable([[1, 1000], [2, 0], [3, 0]]),
          SkillGlobalPostDelay: luaTable([[1, 1000], [2, 0], [3, 0]]),
          SkillSinglePostDelay: luaTable([[1, 30000], [2, 0], [3, 0]]),
        }),
      ],
      // only one column, and a flag list this VM can't resolve
      [28, luaRecord({ SkillFlag: luaTable([]), SkillGlobalPostDelay: luaTable([[1, 500], [2, 500]]) })],
      // a row the client left empty is the same as no row at all
      [1, luaRecord({ SkillFlag: luaTable([]) })],
    ]),
  );

  assert.deepEqual(skills[2].delay, {
    castFixed: [300, 0, 0],
    castVariable: [1000, 0, 0],
    afterCast: [1000, 0, 0],
    cooldown: [30000, 0, 0],
  });
  assert.deepEqual(skills[1].delay, {
    castFixed: null,
    castVariable: null,
    afterCast: [500, 500],
    cooldown: null,
  });
  assert.equal(skills[0].delay, null);
});

// maxLevel comes from a fourth table (SkillInfoList_data), and the arrays above
// are not a substitute for it: the client pads and truncates them freely, so a
// skill can carry ten entries for one level.
test("projectSkills reads maxLevel off the info table, not off the delay arrays", () => {
  const skills = projectSkills(
    luaTable([
      [155, luaRecord({ SkillName: "Grito de Guerra" })],
      [89, luaRecord({ SkillName: "Nevasca" })],
      [700, luaRecord({ SkillName: "Grito Ameaçador" })],
    ]),
    null,
    luaTable([[155, luaRecord({ SkillCastFixedDelay: luaTable([[1, 300], [2, 0], [3, 0]]) })]]),
    luaTable([
      [155, luaRecord({ MaxLv: 1, SpAmount: luaTable([[1, 8]]) })],
      [89, luaRecord({ MaxLv: 10 })],
      // a row with no MaxLv is the same as no row: null, never 0
      [700, luaRecord({})],
    ]),
  );

  assert.deepEqual(skills.map((s) => [s.id, s.maxLevel]), [[89, 10], [155, 1], [700, null]]);
  assert.equal(skills[1].delay.castFixed.length, 3); // padded past its one level
});

// descript[1] is the tooltip title: sometimes a bare string, sometimes a
// { text, colour } pair — both have to yield the same name.
test("projectStatus reads the title whether it is a string or a text/colour pair", () => {
  const status = projectStatus(
    luaTable([
      [0, luaRecord({ descript: luaTable([[1, "Provocar"]]) })],
      [1, luaRecord({ descript: luaTable([[1, luaTable([[1, "Impacto"], [2, "0xffff00"]])]]) })],
      [2, luaRecord({})], // no descript — skipped
    ]),
  );
  assert.deepEqual(status, [
    { id: 0, name: "Provocar" },
    { id: 1, name: "Impacto" },
  ]);
});

// A .pal is 256 RGBA entries covering the whole sprite, so the dye region has to
// be inferred from what CHANGES between a class's numbered palettes. These build
// palettes that share a fixed "skin"/outline block and differ only in a known
// slice, so the sampled swatch is predictable.
function palette({ dye, dyeFrom = 1, dyeCount = 8 }) {
  const p = Buffer.alloc(1024);
  // index 0 is the transparency key; the client stores it magenta
  p[0] = 255; p[1] = 0; p[2] = 255;
  // a fixed block every palette shares — skin and outlines, never the dye
  for (let i = 1; i < 256; i++) {
    p[i * 4] = 60; p[i * 4 + 1] = 60; p[i * 4 + 2] = 60; p[i * 4 + 3] = 255;
  }
  for (let i = dyeFrom; i < dyeFrom + dyeCount; i++) {
    p[i * 4] = dye[0]; p[i * 4 + 1] = dye[1]; p[i * 4 + 2] = dye[2]; p[i * 4 + 3] = 255;
  }
  return p;
}

test("paletteSwatches samples the region that varies between a class's palettes", () => {
  const swatches = paletteSwatches([
    palette({ dye: [60, 60, 60] }), // identical to the shared block — the reference
    palette({ dye: [200, 30, 30] }), // red
    palette({ dye: [30, 30, 200] }), // blue
  ]);

  assert.equal(swatches.length, 3);
  assert.equal(swatches[1], "#c81e1e");
  assert.equal(swatches[2], "#1e1ec8");
  // The reference has no region of its own, so it samples the union of the
  // others' — i.e. the undyed colour of the area everyone else retints.
  assert.equal(swatches[0], "#3c3c3c");
});

test("paletteSwatches returns null per palette rather than shifting the array", () => {
  // index-alignment with the palette ids the renderer takes is the contract
  const swatches = paletteSwatches([
    palette({ dye: [60, 60, 60] }),
    null,
    Buffer.alloc(16), // present but too short to be a palette
    palette({ dye: [200, 30, 30] }),
  ]);
  assert.equal(swatches.length, 4);
  assert.equal(swatches[1], null);
  assert.equal(swatches[2], null);
  assert.equal(swatches[3], "#c81e1e");
});

test("paletteSwatches gives up when there is nothing to diff against", () => {
  assert.deepEqual(paletteSwatches([palette({ dye: [200, 30, 30] })]), [null]);
  // every palette identical — no dye region exists, so no swatch can be inferred
  assert.deepEqual(paletteSwatches([palette({ dye: [60, 60, 60] }), palette({ dye: [60, 60, 60] })]), [null, null]);
});

// Newer costumes ship ClassNum 0 and keep their real view only in the client's
// accessory/robe name tables. `view` stays the literal client field so consumers
// that want it aren't guessing; `spriteView` is what the renderer draws with.
test("projectItems recovers spriteView when ClassNum is 0, leaving view alone", () => {
  const views = {
    resolveView: (slots, res) => (res === "recovered_hat" && slots.includes("top") ? 199 : undefined),
    spriteKind: (view) => (view === 199 ? "headgear" : undefined),
    drawsNothing: (view) => view === 42, // the effect-costume placeholder
  };
  const desc = luaTable([[1, "Equipa em: Topo"]]);
  const items = projectItems(
    luaTable([
      [1, luaRecord({ identifiedDisplayName: "Chapéu", ClassNum: 42, identifiedResourceName: "plain_hat", identifiedDescriptionName: desc })],
      [2, luaRecord({ identifiedDisplayName: "Orelhas", identifiedResourceName: "recovered_hat", identifiedDescriptionName: desc })],
      [3, luaRecord({ identifiedDisplayName: "Nada", identifiedResourceName: "unknown", identifiedDescriptionName: desc })],
    ]),
    new Map(),
    views,
  );

  // ClassNum present: view and spriteView agree, nothing was recovered
  assert.equal(items[0].view, 42);
  assert.equal(items[0].spriteView, 42);
  // ...and that view's sprite is blank, so a catalogue must not draw it
  assert.equal(items[0].spriteBlank, true);
  assert.equal(items[1].spriteBlank, false);
  // ClassNum 0 but the name tables know it — this is the row that would
  // otherwise vanish from a costume catalogue
  assert.equal(items[1].view, 0);
  assert.equal(items[1].spriteView, 199);
  assert.equal(items[1].viewKind, "headgear");
  // nothing knows it: both stay 0 rather than becoming null/undefined
  assert.equal(items[2].view, 0);
  assert.equal(items[2].spriteView, 0);
  assert.equal(items[2].viewKind, null);
});

test("projectItems works without a view resolver", () => {
  const [item] = projectItems(luaTable([[1, luaRecord({ identifiedDisplayName: "X", ClassNum: 7 })]]));
  assert.equal(item.spriteView, 7);
  assert.equal(item.viewKind, null);
  assert.equal(item.spriteBlank, false);
});


// The Lua VM hands strings over as latin1, so decodeClientString has to pick the
// charset from the bytes. The client mixes both in the same table, and — this is
// the trap — a CP1252 accent pair is usually a valid EUC-KR double byte too, so
// "decodes cleanly" is not enough to go on either way.
test("decodeClientString reads a Korean name that carries an ASCII prefix", () => {
  // AccNameTable[1500] = "_C홍염의폭렬파동": ASCII "_C" then EUC-KR Hangul. The
  // ASCII letter must not stop the EUC-KR reading — CP1252 would yield
  // "_CÈ«¿°ÀÇÆø·ÄÆÄµ¿", whose normalized form matches no item resource name, and
  // the costume silently loses its sprite view.
  const bytes = [0x5f, 0x43, 0xc8, 0xab, 0xbf, 0xb0, 0xc0, 0xc7, 0xc6, 0xf8, 0xb7, 0xc4, 0xc6, 0xc4, 0xb5, 0xbf];
  assert.equal(decodeClientString(Buffer.from(bytes).toString("latin1")), "_C홍염의폭렬파동");

  // Same shape, but every CP1252 byte happens to be a letter ("_CÀüÅõÀÇÈçÀû") —
  // the run of them is what gives it away as Korean.
  const combat = [0x5f, 0x43, 0xc0, 0xfc, 0xc5, 0xf5, 0xc0, 0xc7, 0xc8, 0xe7, 0xc0, 0xfb];
  assert.equal(decodeClientString(Buffer.from(combat).toString("latin1")), "_C전투의흔적");
});

test("decodeClientString reads a pure EUC-KR name", () => {
  const bytes = [0xc0, 0xce, 0xba, 0xf1, 0xc1, 0xf6, 0xba, 0xed, 0xc4, 0xb8]; // 인비지블캡
  assert.equal(decodeClientString(Buffer.from(bytes).toString("latin1")), "인비지블캡");
});

test("decodeClientString leaves accented Portuguese alone", () => {
  // "AÇÃO" is C7 C3 — a perfectly valid Hangul double byte (것), so a decoder
  // that trusts a clean EUC-KR read turns the client's pt-BR text into Korean.
  const cases = [
    [[0x41, 0xc7, 0xc3, 0x4f], "AÇÃO"],
    [[0x4d, 0x41, 0x4c, 0x44, 0x49, 0xc7, 0xd5, 0x45, 0x53], "MALDIÇÕES"],
    [[0x50, 0x6f, 0xe7, 0xe3, 0x6f, 0x20, 0x64, 0x65, 0x20, 0x43, 0x75, 0x72, 0x61], "Poção de Cura"],
  ];
  for (const [bytes, want] of cases) {
    assert.equal(decodeClientString(Buffer.from(bytes).toString("latin1")), want);
  }
});

test("decodeClientString keeps UTF-8 (the patched iteminfo) as-is", () => {
  assert.equal(decodeClientString(Buffer.from("Poção de Cura", "utf8").toString("latin1")), "Poção de Cura");
});

// Effect costumes ship an accessory sprite that is there but deliberately blank:
// every layer tinted alpha 0. That is how the client says "the visual is an
// effect" — so the extractor must not mistake such a view for a renderable one.
test("actDrawsNothing spots the all-alpha-0 effect-costume placeholder", () => {
  assert.equal(actDrawsNothing(buildAct23([0, 1, 0], 100, 0)), true);
  assert.equal(actDrawsNothing(buildAct23([0, 1, 0], 100, 255)), false);
  assert.equal(actDrawsNothing(buildAct23([0, 1, 0], 100, 1)), false); // barely visible still counts
});

// ...except when the blank accessory is a hat effect: the costume's real visual
// is a separate looping sprite named after the same resource, which the renderer
// composites at the character's head. The name is the whole link — the accessory
// table's leading underscore goes, the rest is the resource name plus "_이펙트".
// The ported effect table carries roBrowser's file names, and not all of them are
// a plain child of the effect folder. Effect 1130 is the same flame the costume
// above plays — the client's chain reaches it as HAT_EF_BAKURETSU_HADOU → 1130 —
// but under the Korean resource name, so the id has to be redirected or the
// bundle never builds and the replay viewer has nothing to play for it.
test("sprEffectCandidates redirects the ids whose ported name is another client's", () => {
  assert.deepEqual(sprEffectCandidates("1130", "bakuretsu_hadou/bakuretsu_hadou"), [
    "data/sprite/아이템/c홍염의폭렬파동_이펙트",
  ]);
  // Numeric keys reach the same entry (Object.entries hands them over as strings).
  assert.deepEqual(sprEffectCandidates(1130, "bakuretsu_hadou/bakuretsu_hadou"), [
    "data/sprite/아이템/c홍염의폭렬파동_이펙트",
  ]);
  // Everything else keeps the table's own name under the effect sprite folder.
  assert.deepEqual(sprEffectCandidates("666", "어스퀘이크"), ["data/sprite/이팩트/어스퀘이크"]);
});

// A "../npc/x" name walks out of the effect folder. The GRF is a flat name list,
// so the ".." has to be collapsed or the path matches nothing at all; and this
// client keeps only two of those six sprites under npc/, the rest under the
// Korean monster folder, so both are offered in order.
test("sprEffectCandidates resolves the ../npc names out of the effect folder", () => {
  assert.deepEqual(sprEffectCandidates("ef_mandragora_attack", "../npc/mandragora_atk"), [
    "data/sprite/npc/mandragora_atk",
    "data/sprite/몬스터/mandragora_atk",
  ]);
  // A sub-path that stays inside the folder keeps it, and gets no monster fallback.
  assert.deepEqual(sprEffectCandidates("1240", "digital_space/digital_space"), [
    "data/sprite/이팩트/digital_space/digital_space",
  ]);
});

test("hatEffectSprite names the sprite a hat-effect costume plays", () => {
  assert.equal(hatEffectSprite("_C홍염의폭렬파동"), "data/sprite/아이템/c홍염의폭렬파동_이펙트");
  // Backslashes and case come from the client table the same way normRes takes them.
  assert.equal(hatEffectSprite("C홍염의폭렬파동"), "data/sprite/아이템/c홍염의폭렬파동_이펙트");
  // No accessory name, nothing to look for.
  assert.equal(hatEffectSprite(""), "");
  assert.equal(hatEffectSprite(undefined), "");
});


// The costumes whose effect folder is romanized can't be reached from the
// resource name, so STR_OVERRIDE names the .str by hand. The picks come from the
// client's own HatEffectInfo table (HAT_EF_* → resourceFileName), which is also
// what settles the folders holding more than one .str — pinning them here keeps
// a future "cleanup" from silently swapping in the wrong sibling file.
test("STR_OVERRIDE resolves the romanized costumes to the .str the client plays", () => {
  const index = [
    "data/texture/effect/efst_maple_falls/maple_falls.str",
    "data/texture/effect/efst_maple_falls/dandan1.str",
    "data/texture/effect/efst_blossom_fluttering/sakura.str",
    "data/texture/effect/efst_gold_shower/coin2.str",
    "data/texture/effect/efst_decoration_of_music/note_1.str",
    "data/texture/effect/efst_rabbit_aura/toto.str",
    "data/texture/effect/efst_alice_tea/alice02.str",
  ];
  const cases = [
    ["흩날리는낙엽", "efst_maple_falls/maple_falls.str"], //        HAT_EF_Maple_Falls, not dandan1.str
    ["흩날리는벚꽃", "efst_blossom_fluttering/sakura.str"], //      HAT_EF_Blossom_Fluttering
    ["C골드샤워", "efst_gold_shower/coin2.str"], //                 HAT_EF_gold_shower
    ["음계의오오라", "efst_decoration_of_music/note_1.str"], //     HAT_EF_decoration_of_music
    ["토끼리본모자", "efst_rabbit_aura/toto.str"], //               HAT_EF_rabbit_aura
    ["Teaparty_Wonderland", "efst_alice_tea/alice02.str"], //      HAT_EF_alice_tea
  ];
  for (const [res, want] of cases) {
    assert.equal(resolveStr(index, res)?.str, "data/texture/effect/" + want, res);
  }
});

// toto.str (the rabbit aura) is the one effect in the client whose header maxKey
// is garbage. Taken at face value the viewer would loop over 1.8 billion frames
// and the effect would never appear to move.
test("effectMaxKey falls back to the last keyframe only when the header is absurd", () => {
  const layers = [{ anims: [{ frame: 0 }, { frame: 90 }] }, { anims: [{ frame: 180 }] }];
  assert.equal(effectMaxKey(1835102790, layers), 180);
  assert.equal(effectMaxKey(-1, layers), 180);
  // plausible headers are kept verbatim, including ones past the last keyframe
  // (an effect may hold after its final key) and 0
  assert.equal(effectMaxKey(360, layers), 360);
  assert.equal(effectMaxKey(180, layers), 180);
  assert.equal(effectMaxKey(0, layers), 0);
});

// data/num2cardillustnametable.txt is EUC-KR: "4001#포링카드#" is the Poring
// card's 300x400 illustration. The bytes below are that exact line from the
// live client, so the decode is tested against real client encoding rather than
// a re-encoding of it.
const CARD_TABLE_BYTES = Buffer.from(
  "2f2f206361726473" + "0d0a" + // "// cards" comment line
    "3430303123c6f7b8b5c4abb5e523" + "0d0a" + // 4001#포링카드#
    "3430303223" + "6d795f63617264" + "23" + "0d0a" + // 4002#my_card#  (ASCII name)
    "34303032230d0a" + // 4002## — empty name, ignored
    "6a756e6b" + "0d0a" + // "junk" — no id, ignored
    "3430303223" + "736f727279" + "23", // 4002#sorry#
  "hex",
);

test("parseCardIllustTable reads EUC-KR names and keeps every name per id", () => {
  const table = parseCardIllustTable(CARD_TABLE_BYTES);
  assert.deepEqual([...table.keys()], ["4001", "4002"]);
  assert.deepEqual(table.get("4001"), ["포링카드"]);
  assert.deepEqual(table.get("4002"), ["my_card", "sorry"]);
});

// The table's trailing block re-points ~190 ids at the "sorry" placeholder,
// sometimes over a name whose art is still shipped (the 마신의정수 cards), and
// some ids name art that was never shipped before naming art that was (4557).
// So: first name that resolves to real art wins, placeholder never does.
test("pickCardIllust takes the first shipped name and never the placeholder", () => {
  const shipped = (...names) => (n) => names.includes(n);
  assert.equal(pickCardIllust(["마신의정수카드1", "sorry"], shipped("마신의정수카드1", "sorry")), "마신의정수카드1");
  assert.equal(pickCardIllust(["sorry", "마신의정수카드1"], shipped("마신의정수카드1", "sorry")), "마신의정수카드1");
  assert.equal(pickCardIllust(["약화된펜릴카드", "펜릴카드_"], shipped("펜릴카드_")), "펜릴카드_");
  assert.equal(pickCardIllust(["sorry"], shipped("sorry")), null); // placeholder only
  assert.equal(pickCardIllust(["SLD_Gioia_Card"], shipped()), null); // never shipped
});
