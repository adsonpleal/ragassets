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
