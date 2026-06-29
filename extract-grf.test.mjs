// Tests for extract-grf.mjs pure parsers. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFogTable } from "./extract-grf.mjs";

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
