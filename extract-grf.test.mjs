// Tests for extract-grf.mjs pure parsers. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFogTable,
  parseRsw,
  expandStrFiles,
  effectStrKey,
  effectStrPath,
  effectStrRefs,
  decodeSprFrames,
  parseActFrames,
  compositeActFrame,
  parseWav,
  encodeWavPcm,
  decodeImaAdpcm,
  toPlayableWav,
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
function buildAct23(indices, delayMs) {
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
    parts.push(Buffer.from([255, 255, 255, 255])); // packed colour (4 bytes)
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
