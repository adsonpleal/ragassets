// Unit tests for the parts of the pipeline it cannot get wrong quietly: the
// path shapes, the set cover, the byte-range arithmetic, the slot parsing and
// the catalogue join.
//
// Run with `node --test tools/multiserver/multiserver.test.mjs`, which is what
// CI runs. These are the modules that need neither a network nor a mirror; the
// ones that read real client tables are covered by running a stage, since what
// they have to be right about is a 9 MB .lub and not a fixture.
//
// (When this pipeline lived in the app's repository it could not import
// extract-grf.mjs as a module at all — it was a path on the operator's machine
// — so the format readers were untestable there and the suite said so. Here
// they are the repository's own, tested in extract-grf.test.mjs.)

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The keys of `want`, compared exactly, and nothing else: for the handful of
// assertions that are about some fields of a result and not all of them.
const hasFields = (got, want) => {
  const picked = {};
  for (const k of Object.keys(want)) picked[k] = got[k];
  assert.deepStrictEqual(picked, want);
};
import { sep } from "node:path";

// The sex marks that prefix every headgear sprite file name.
const SEX_M = "남";
const SEX_F = "여";
// A headgear sprite's real path shape, which `originCanDraw` reads.
const accPath = (sex, key = "chapeu") =>
  `data/sprite/악세사리/${sex}/${sex}${key}.spr`;
import { ORIGINS, parsePatchList, rgzProbeOrder, selectOrigins, GRF_EXT, RGZ_EXT } from "./origins.mjs";
import { ITEM_INFO_FILES, ITEM_INFO_TAILS } from "./iteminfo.mjs";
import { normalizePath, robeTargets, spriteTargets, targetsFor } from "./pathshapes.mjs";
import { legacyNameCoverage } from "./coverage.mjs";
import {
  bestSlotOfStep,
  blockedFrom,
  coverPlan,
  originCanDraw,
  planStats,
  rowKey,
  targetsOf,
} from "./stage4-plan.mjs";
import { COALESCE_GAP, coalesceSpans, fileEntries, rangeCost } from "./ranges.mjs";
import {
  clientNamesBySprite,
  isPlaceholderName,
  normResource,
  spaceOut,
} from "./clientnames.mjs";
import {
  buildCatalogue,
  catalogueDocument,
  costumeDraws,
  originsFromPaths,
  planByCostume,
  slotsByCostume,
  treeProbe,
} from "./stage5-catalogue.mjs";
import {
  SLOT_PRIORITY,
  bestSlot,
  kindFromSlots,
  parseSlotValue,
  parseSlotsFromLines,
  slotRank,
} from "./slots.mjs";

describe("parsePatchList", () => {
  // The real shape, taken from twRO's patch3.txt and jRO's patch2.txt.
  const index = [
    "// taiwan roz live",
    "9431\t2026-11-17_live_client_4590_4596_1794800000.gpf",
    "\t//9432 2026-11-17_pulled.rgz",
    "9433 2026-11-17_Raghash_1794814779.rgz",
    "",
  ].join("\n");

  it("reads sequence and filename, and skips pulled patches by default", () => {
    const got = parsePatchList(index);
    assert.deepStrictEqual(got, [
      { seq: 9431, file: "2026-11-17_live_client_4590_4596_1794800000.gpf", pulled: false },
      { seq: 9433, file: "2026-11-17_Raghash_1794814779.rgz", pulled: false },
    ]);
  });

  it("can include the pulled ones, flagged", () => {
    const got = parsePatchList(index, { includePulled: true });
    assert.deepStrictEqual(got.map((e) => [e.seq, e.pulled]), [
      [9431, false],
      [9432, true],
      [9433, false],
    ]);
  });

  it("ignores comment lines that are not patch entries", () => {
    assert.deepStrictEqual(parsePatchList("// End of Patch\n\n"), []);
  });
});

describe("archive extensions", () => {
  it("separates the ones with a file table from the gzip ones", () => {
    for (const f of ["a.gpf", "a.gsf", "a.gef", "a.grf", "A.GPF"]) {
      assert.strictEqual(GRF_EXT.test(f), true, f);
      assert.strictEqual(RGZ_EXT.test(f), false, f);
    }
    assert.strictEqual(RGZ_EXT.test("2026-11-17_Raghash_1794814779.rgz"), true);
    assert.strictEqual(GRF_EXT.test("2026-11-17_Raghash_1794814779.rgz"), false);
  });
});

describe("selectOrigins", () => {
  it("defaults to everything and understands 'foreign' and a list", () => {
    assert.strictEqual(selectOrigins().length, Object.keys(ORIGINS).length);
    assert.strictEqual(selectOrigins("foreign").some((o) => o.id === "latam"), false);
    assert.deepStrictEqual(selectOrigins("twro,jro").map((o) => o.id), ["twro", "jro"]);
  });

  it("refuses an origin it does not know, rather than silently doing nothing", () => {
    assert.throws(() => selectOrigins("bro"), /unknown origin/);
  });
});

describe("normalizePath", () => {
  it("makes the two spellings of the same GRF path compare equal", () => {
    const a = String.raw`data\LuaFiles514\Lua Files\Datainfo\AccName.lub`;
    const b = String.raw`data\luafiles514\lua files\datainfo\accname.lub`;
    assert.strictEqual(normalizePath(a), normalizePath(b));
    assert.strictEqual(normalizePath(a), "data/luafiles514/lua files/datainfo/accname.lub");
  });
});

describe("spriteTargets", () => {
  it("keeps the underscore for the headgear files and drops it for the effect folder", () => {
    assert.deepStrictEqual(spriteTargets("_C_Chained_Bear"), [
      "/sprite/악세사리/남/남_c_chained_bear.",
      "/sprite/악세사리/여/여_c_chained_bear.",
      "/sprite/이팩트/c_chained_bear/",
    ]);
  });

  it("matches the real paths a patch table carries", () => {
    const targets = spriteTargets("_C_Chained_Bear");
    const real = [
      String.raw`data\sprite\악세사리\남\남_C_Chained_Bear.act`,
      String.raw`data\sprite\악세사리\남\남_C_Chained_Bear.spr`,
      String.raw`data\sprite\악세사리\여\여_C_Chained_Bear.spr`,
    ];
    for (const p of real) {
      const norm = normalizePath(p);
      assert.strictEqual(targets.some((t) => norm.includes(t)), true, p);
    }
  });

  it("does not match a different costume that shares a prefix", () => {
    // `_C_Fox_Ear` must not drag in `_C_Fox_Ear_Beret`: the headgear prefix ends
    // at the dot before the extension.
    const targets = spriteTargets("_C_Fox_Ear");
    const other = normalizePath(String.raw`data\sprite\악세사리\남\남_C_Fox_Ear_Beret.spr`);
    assert.strictEqual(targets.some((t) => other.includes(t)), false);
  });

  it("handles a Korean sprite name", () => {
    const got = spriteTargets("_붉은고양이귀케이프");
    assert.strictEqual(got[0], "/sprite/악세사리/남/남_붉은고양이귀케이프.");
    assert.strictEqual(got[2], "/sprite/이팩트/붉은고양이귀케이프/");
  });

  it("never asks for a robe folder, which is the other namespace", () => {
    assert.strictEqual(spriteTargets("_C_Chained_Bear").some((t) => t.includes("로브")), false);
  });
});

describe("robeTargets", () => {
  it("takes both spellings the robe table carries, because both exist as folders", () => {
    assert.deepStrictEqual(robeTargets("기린의날개", "KIRIN_WING"), [
      "/sprite/로브/기린의날개/",
      "/sprite/이팩트/기린의날개/",
      "/sprite/로브/kirin_wing/",
      "/sprite/이팩트/kirin_wing/",
    ]);
  });

  it("skips a spelling the table does not have", () => {
    assert.deepStrictEqual(robeTargets("기린의날개", null), [
      "/sprite/로브/기린의날개/",
      "/sprite/이팩트/기린의날개/",
    ]);
  });

  it("matches the real garment path from a live client", () => {
    const targets = robeTargets("C_Juncea_Wing");
    const real = normalizePath(String.raw`data\sprite\로브\C_Juncea_Wing\남abyss_chaser_riding_남.act`);
    assert.strictEqual(targets.some((t) => real.includes(t)), true);
  });
});

describe("targetsFor", () => {
  it("dispatches on the namespace, so a view id is never looked up in the wrong tree", () => {
    assert.deepStrictEqual(targetsFor("acc", "_C_Chained_Bear"), spriteTargets("_C_Chained_Bear"));
    assert.deepStrictEqual(targetsFor("robe", "기린의날개"), robeTargets("기린의날개"));
  });
});

describe("ORIGINS", () => {
  it("gives every origin an index, a file store and an encoding", () => {
    for (const [id, o] of Object.entries(ORIGINS)) {
      assert.strictEqual(o.id, id, id);
      assert.match(o.index, /^(https?|ftp):\/\//, id);
      assert.match(o.files, /^(https?|ftp):\/\//, id);
      assert.strictEqual(o.files.endsWith("/"), false, `${id} file base must not end in /`);
      assert.ok(o.encoding, id);
      assert.ok(o.badge.length <= 5, `${id} badge is ${o.badge.length} chars, max 5`);
    }
  });

  // An encoding here is a WHATWG label, not a charset name of one's own
  // choosing: TextDecoder throws on anything it does not know, and it throws at
  // the point a name table is being decoded -- hours into a run, in stage 2,
  // after the bandwidth has been spent. thRO is the reason this exists: its
  // client is TIS-620, which the WHATWG set calls `windows-874`, and writing
  // `tis-620` or `iso-8859-11` would also have worked while `TIS620` would
  // not. Asserting it here costs nothing and moves the failure to CI.
  it("labels every encoding with something TextDecoder accepts", () => {
    for (const [id, o] of Object.entries(ORIGINS)) {
      assert.doesNotThrow(() => new TextDecoder(o.encoding), `${id}: ${o.encoding}`);
    }
  });

  it("registers thRO, the second English name source", () => {
    assert.ok(ORIGINS.thro, "thro must stay registered");
    assert.strictEqual(new TextDecoder(ORIGINS.thro.encoding).encoding, "windows-874");
  });
});

describe("ITEM_INFO_FILES", () => {
  // The bug this guards: stage 2 matched only `iteminfo_new.lub`, iRO ships
  // `System/itemInfo.lub`, and iRO therefore read its item names out of a table
  // last patched on 2016-12-01 -- 8,367 names where the lub has 19,763. The
  // probe ledger had recorded `system/iteminfo.lub` inside 33 archives it had
  // already paid to download.
  it("knows both spellings, the common one first", () => {
    assert.deepStrictEqual(ITEM_INFO_FILES, ["iteminfo_new.lub", "iteminfo.lub"]);
    assert.deepStrictEqual(ITEM_INFO_TAILS, [
      "system/iteminfo_new.lub",
      "system/iteminfo.lub",
    ]);
  });

  it("matches the path iRO actually ships, as the probe normalizes it", () => {
    // Built rather than written as a literal: a backslash in a test source
    // is one editor away from being eaten, and this assertion is the point.
    const BS = String.fromCharCode(92);
    const iro = normalizePath("System" + BS + "itemInfo.lub");
    assert.ok(
      ITEM_INFO_TAILS.some((t) => iro.endsWith(t)),
      `${iro} must match one of ${ITEM_INFO_TAILS.join(", ")}`,
    );
    // and the common spelling still matches, from a deeper root
    const twro = normalizePath(["data", "System", "iteminfo_new.lub"].join(BS));
    assert.ok(ITEM_INFO_TAILS.some((t) => twro.endsWith(t)));
  });

  it("does not match a file that merely contains the name", () => {
    for (const p of ["system/iteminfo_new.lub.bak", "system/myiteminfo.lub"]) {
      if (p.endsWith(".bak")) {
        assert.ok(!ITEM_INFO_TAILS.some((t) => p.endsWith(t)), p);
      } else {
        // `myiteminfo.lub` ends with "iteminfo.lub" but not with "system/iteminfo.lub"
        assert.ok(!ITEM_INFO_TAILS.some((t) => p.endsWith(t)), p);
      }
    }
  });
});

describe("rgzProbeOrder", () => {
  // Opening a .rgz costs a full download, so the order decides the bandwidth
  // bill. Taken from the real twRO and jRO rgz ledgers.
  const rows = [
    { seq: "9433", file: "2026-11-17_Raghash_1794814779.rgz" },
    { seq: "9432", file: "2026-11-17_live_client_4597_4601_1794814779.rgz" },
    { seq: "9400", file: "2026-11-01_live_client_4500_4510_1790000000.rgz" },
    { seq: "9410", file: "2026-11-04aRagexe.rgz" },
    { seq: "9420", file: "2026-11-10_something_else.rgz" },
  ];

  it("tries client patches first and the executables and hash files last", () => {
    assert.deepStrictEqual(rgzProbeOrder(rows).map((r) => r.file), [
      "2026-11-17_live_client_4597_4601_1794814779.rgz",
      "2026-11-01_live_client_4500_4510_1790000000.rgz",
      "2026-11-10_something_else.rgz",
      "2026-11-17_Raghash_1794814779.rgz",
      "2026-11-04aRagexe.rgz",
    ]);
  });

  it("keeps the newest first inside a group and does not mutate the input", () => {
    const before = rows.map((r) => r.file);
    const client = rgzProbeOrder(rows).filter((r) => r.file.includes("live_client"));
    assert.deepStrictEqual(client.map((r) => Number(r.seq)), [9432, 9400]);
    assert.deepStrictEqual(rows.map((r) => r.file), before);
  });
});

describe("legacyNameCoverage", () => {
  // This rule decides whether to download tens of MB of .rgz from somebody
  // else's CDN, so each real origin's shape gets a case.
  const views = [
    { view: 1, sprite: "_a" },
    { view: 2, sprite: "_b" },
    { view: 3, sprite: "_c" },
    { view: 4, sprite: "_d" },
  ];

  it("counts a view as named only when the item has a display name too", () => {
    const got = legacyNameCoverage({
      viewRows: views,
      legacyRes: new Map([
        [100, "a"],
        [200, "b"],
      ]),
      legacyNames: new Map([[100, "Chapéu"]]),
    });
    assert.strictEqual(got.named, 1);
    assert.strictEqual(got.withSprite, 4);
    assert.strictEqual(got.thin, true);
  });

  it("treats a resource table with no display table as naming nothing (twRO)", () => {
    const got = legacyNameCoverage({
      viewRows: views,
      legacyRes: new Map([
        [100, "a"],
        [200, "b"],
        [300, "c"],
        [400, "d"],
      ]),
      legacyNames: new Map(),
    });
    assert.strictEqual(got.ratio, 0);
    assert.strictEqual(got.thin, true);
  });

  it("leaves a client alone when its own tables already explain it (jRO)", () => {
    const legacyRes = new Map([
      [100, "a"],
      [200, "b"],
      [300, "c"],
    ]);
    const legacyNames = new Map([
      [100, "um"],
      [200, "dois"],
      [300, "três"],
    ]);
    const got = legacyNameCoverage({ viewRows: views, legacyRes, legacyNames });
    assert.strictEqual(got.named, 3);
    assert.strictEqual(got.thin, false);
  });

  it("ignores views with no sprite, and a deliberately blank one", () => {
    const got = legacyNameCoverage({
      viewRows: [{ view: 1, sprite: "_a" }, { view: 2, sprite: "" }, { view: 3, sprite: null }],
      legacyRes: new Map([[100, "a"]]),
      legacyNames: new Map([[100, "um"]]),
    });
    assert.strictEqual(got.withSprite, 1);
    assert.strictEqual(got.ratio, 1);
    assert.strictEqual(got.thin, false);
  });

  it("matches case-insensitively, since the tables disagree on case", () => {
    const got = legacyNameCoverage({
      viewRows: [{ view: 1, sprite: "_C_Chained_Bear" }],
      legacyRes: new Map([[100, "c_chained_BEAR"]]),
      legacyNames: new Map([[100, "Urso"]]),
    });
    assert.strictEqual(got.named, 1);
  });

  it("calls a client with no views at all thin, since only a probe can tell", () => {
    assert.strictEqual(legacyNameCoverage({ viewRows: [], legacyRes: new Map(), legacyNames: new Map() }).thin, true);
  });
});

describe("targetsOf", () => {
  it("tags the costume's own files core and the aura folder effect", () => {
    const got = targetsOf({ kind: "acc", view: 8, sprite: "_C_Chained_Bear" });
    assert.deepStrictEqual(got.filter((t) => t.tier === "core").map((t) => t.prefix), [
      "/sprite/악세사리/남/남_c_chained_bear.",
      "/sprite/악세사리/여/여_c_chained_bear.",
    ]);
    assert.deepStrictEqual(got.filter((t) => t.tier === "effect").map((t) => t.prefix), [
      "/sprite/이팩트/c_chained_bear/",
    ]);
    // Every target carries the row's key, so a hit can be credited to a view.
    assert.deepStrictEqual(new Set(got.map((t) => t.key)), new Set(["acc:8"]));
  });

  it("calls a garment's own folder core, keeping the effect folder separate", () => {
    const got = targetsOf({ kind: "robe", view: 8, sprite: "C_S_Thanatos_Wing" });
    assert.deepStrictEqual(got.filter((t) => t.tier === "core").map((t) => t.prefix), [
      "/sprite/로브/c_s_thanatos_wing/",
    ]);
    assert.strictEqual((got.filter((t) => t.tier === "effect")).length, 1);
  });
});

describe("rowKey", () => {
  it("separates the two namespaces that share small numbers", () => {
    // LATAM view 8 is a surgical mask as headgear and Rudra's wings as garment.
    assert.strictEqual(rowKey({ kind: "acc", view: "8" }), "acc:8");
    assert.strictEqual(rowKey({ kind: "robe", view: "8" }), "robe:8");
  });
});

describe("coverPlan", () => {
  // Two origins, one view in both: a plan must not fetch it twice.
  const hit = (key, archive, seq, uncompSize = 100, tier = "core") => ({
    key,
    archive,
    seq,
    uncompSize,
    tier,
    path: `p/${key}/${archive}`,
  });
  // A headgear fixture has to carry both sexes, because `originCanDraw` drops
  // an origin that cannot render the view. That is the planner's rule, not the
  // test's: paths that cannot draw are paths no plan should fetch.
  const pair = (key, archive, seq, uncompSize = 50) =>
    [SEX_M, SEX_F].map((sex) => [accPath(sex, key), hit(key, archive, seq, uncompSize)]);

  it("fetches a view shared by two origins from only one of them", () => {
    const byOrigin = new Map([
      ["twro", new Map(pair("acc:1", "t1.gpf", 10))],
      ["jro", new Map(pair("acc:1", "j1.gpf", 20))],
    ]);
    const { steps, unreachable } = coverPlan(byOrigin, ["acc:1"]);
    assert.strictEqual(steps.length, 1);
    assert.deepStrictEqual(unreachable, []);
  });

  it("takes the archive that supplies most first, then the rest", () => {
    const byOrigin = new Map([
      [
        "twro",
        new Map([
          ["robe/a/1.spr", hit("robe:1", "big.gpf", 10)],
          ["robe/b/1.spr", hit("robe:2", "big.gpf", 10)],
          ["robe/a/2.spr", hit("robe:1", "small.gpf", 11)],
        ]),
      ],
    ]);
    const { steps } = coverPlan(byOrigin, ["robe:1", "robe:2"]);
    // big.gpf supplies two files to small.gpf's one, so the greedy takes it
    // first — but small.gpf still holds a file of acc:1, so it is not dropped.
    assert.deepStrictEqual(steps.map((s) => s.archive), ["big.gpf", "small.gpf"]);
  });

  // The bug stage 5 caught: Gravity ships a garment's .act files in one patch
  // and its .spr in another, and counting coverage per view stopped at the
  // first. 29 of 665 costumes arrived as animation data with no artwork.
  it("fetches the rest of a costume whose files are split across patches", () => {
    const byOrigin = new Map([
      [
        "iro",
        new Map([
          ["robe/x/x.act", hit("robe:1", "acts.gpf", 10)],
          ["robe/x/x.spr", hit("robe:1", "sprites.gpf", 11)],
        ]),
      ],
    ]);
    const { steps, unreachable } = coverPlan(byOrigin, ["robe:1"]);
    assert.deepStrictEqual(unreachable, []);
    assert.deepStrictEqual(steps.flatMap((s) => s.files.map((f) => f.norm)).sort(), [
      "robe/x/x.act",
      "robe/x/x.spr",
    ]);
  });

  // The planner picks an origin by how many files it supplies, which is not the
  // same as supplying the right ones: on the first path-covered plan robe:132
  // went to iRO, which has no .spr for it, while twRO has 343.
  it("skips an origin that carries a garment's .act files but no artwork", () => {
    const byOrigin = new Map([
      [
        "iro",
        new Map([
          ["robe/x/1.act", hit("robe:1", "iro.gpf", 10)],
          ["robe/x/2.act", hit("robe:1", "iro.gpf", 10)],
          ["robe/x/3.act", hit("robe:1", "iro.gpf", 10)],
        ]),
      ],
      ["twro", new Map([["robe/x/1.spr", hit("robe:1", "tw.gpf", 5)]])],
    ]);
    const { steps, unreachable } = coverPlan(byOrigin, ["robe:1"]);
    assert.deepStrictEqual(unreachable, []);
    // iRO offers three files to twRO's one and still loses.
    assert.deepStrictEqual(steps.map((s) => s.originId), ["twro"]);
  });

  it("skips an origin that has only one sex of a headgear", () => {
    const byOrigin = new Map([
      ["krozero", new Map([[accPath(SEX_M), hit("acc:1", "kz.gpf", 10)]])],
      [
        "twro",
        new Map([
          [accPath(SEX_M), hit("acc:1", "tw.gpf", 5)],
          [accPath(SEX_F), hit("acc:1", "tw.gpf", 5)],
        ]),
      ],
    ]);
    const { steps } = coverPlan(byOrigin, ["acc:1"]);
    assert.deepStrictEqual(steps.map((s) => s.originId), ["twro"]);
  });

  it("calls a view unreachable when no origin can render it", () => {
    // acc:156 is real: only kRO Zero has it, and only the male sprite. Fetching
    // it would cost bytes and still yield a costume the catalogue throws away.
    const byOrigin = new Map([
      [
        "krozero",
        new Map([[accPath(SEX_M), hit("acc:1", "kz.gpf", 10)]]),
      ],
    ]);
    const { steps, unreachable } = coverPlan(byOrigin, ["acc:1"]);
    assert.deepStrictEqual(steps, []);
    assert.deepStrictEqual(unreachable, ["acc:1"]);
  });

  // One costume, one origin: 282 .act files differ in content between origins,
  // so a garment half from twRO and half from iRO animates against the wrong
  // offsets. The greedy may pick either origin, but not both.
  it("never assembles one costume from two origins", () => {
    const byOrigin = new Map([
      [
        "twro",
        new Map([
          ["robe/x/x.act", hit("robe:1", "tw.gpf", 10)],
          ["robe/x/x.spr", hit("robe:1", "tw.gpf", 10)],
        ]),
      ],
      ["iro", new Map([["robe/x/x.spr", hit("robe:1", "iro.gpf", 99)]])],
    ]);
    const { steps } = coverPlan(byOrigin, ["robe:1"]);
    assert.deepStrictEqual([...new Set(steps.map((s) => s.originId))], ["twro"]);
  });

  it("takes every wanted file an archive carries, not one per view", () => {
    // A headgear needs both sexes; dropping one leaves a half-rendered costume.
    const byOrigin = new Map([
      ["twro", new Map(pair("acc:1", "p.gpf", 10))],
    ]);
    const { steps } = coverPlan(byOrigin, ["acc:1"]);
    assert.strictEqual(steps[0].files.length, 2);
  });

  it("reports views no origin can supply instead of looping forever", () => {
    const byOrigin = new Map([["twro", new Map(pair("acc:1", "p.gpf", 10))]]);
    const { steps, unreachable } = coverPlan(byOrigin, ["acc:1", "acc:999"]);
    assert.strictEqual(steps.length, 1);
    assert.deepStrictEqual(unreachable, ["acc:999"]);
  });

  it("orders the plan oldest patch first, so a later one overwrites it", () => {
    const byOrigin = new Map([
      ["twro", new Map([...pair("acc:1", "new.gpf", 90), ...pair("acc:2", "old.gpf", 10)])],
    ]);
    const { steps } = coverPlan(byOrigin, ["acc:1", "acc:2"]);
    assert.deepStrictEqual(steps.map((s) => s.archive), ["old.gpf", "new.gpf"]);
  });

  it("counts only the tiers it was asked for", () => {
    const byOrigin = new Map([
      [
        "twro",
        new Map([
          ...pair("acc:1", "p.gpf", 10, 50),
          ["data/sprite/이팸트/x/a.tga", hit("acc:1", "p.gpf", 10, 9000, "effect")],
        ]),
      ],
    ]);
    const core = coverPlan(byOrigin, ["acc:1"], { tiers: ["core"] });
    assert.strictEqual(planStats(core, ["acc:1"]).bytes, 100);
    const both = coverPlan(byOrigin, ["acc:1"], { tiers: ["core", "effect"] });
    assert.strictEqual(planStats(both, ["acc:1"]).bytes, 9100);
  });
});

describe("planStats", () => {
  it("splits bytes by tier, which is the number the fetch decision turns on", () => {
    const steps = [
      {
        originId: "twro",
        archive: "p.gpf",
        seq: 1,
        files: [
          { key: "acc:1", tier: "core", uncompSize: 200 },
          { key: "acc:1", tier: "effect", uncompSize: 5000 },
        ],
      },
    ];
    const got = planStats({ steps, unreachable: ["acc:2"] }, ["acc:1", "acc:2"]);
    hasFields(got, {
      wanted: 2,
      covered: 1,
      unreachable: 1,
      archives: 1,
      files: 2,
      bytes: 5200,
      perOrigin: { twro: 1 },
      perTier: { core: 200, effect: 5000 },
    });
  });
});

describe("coalesceSpans", () => {
  it("merges spans close enough that the gap is cheaper than a round trip", () => {
    const got = coalesceSpans(
      [
        { start: 100, length: 50 },
        { start: 200, length: 50 },
      ],
      { gap: 100 },
    );
    assert.strictEqual(got.length, 1);
    hasFields(got[0], { start: 100, end: 249 });
    assert.strictEqual(got[0].spans.length, 2);
  });

  it("keeps spans apart when the gap is wider than the window", () => {
    const got = coalesceSpans(
      [
        { start: 0, length: 10 },
        { start: 1_000_000, length: 10 },
      ],
      { gap: 1024 },
    );
    assert.deepStrictEqual(got.map((r) => [r.start, r.end]), [
      [0, 9],
      [1_000_000, 1_000_009],
    ]);
  });

  it("sorts before merging, since a file table is not in offset order", () => {
    const got = coalesceSpans(
      [
        { start: 300, length: 10 },
        { start: 100, length: 10 },
        { start: 200, length: 10 },
      ],
      { gap: 1000 },
    );
    assert.strictEqual(got.length, 1);
    hasFields(got[0], { start: 100, end: 309 });
  });

  it("merges spans that abut or overlap, and keeps the furthest end", () => {
    // A zero gap must still merge: `end + 1` is the first uncovered byte.
    assert.strictEqual((coalesceSpans([{ start: 0, length: 10 }, { start: 10, length: 10 }], { gap: 0 })).length, 1);
    // A span swallowed by a longer one must not shrink the range.
    const got = coalesceSpans([{ start: 0, length: 100 }, { start: 10, length: 5 }], { gap: 0 });
    assert.strictEqual(got[0].end, 99);
  });

  it("drops the zero-length spans a directory entry produces", () => {
    const got = coalesceSpans([{ start: 50, length: 0 }, { start: 100, length: 10 }], { gap: 0 });
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].start, 100);
  });

  it("defaults to a window where the gap is smaller than a client patch", () => {
    assert.strictEqual(COALESCE_GAP, 262144);
  });
});

describe("rangeCost", () => {
  it("separates the bytes wanted from the bytes read to avoid a round trip", () => {
    const ranges = coalesceSpans(
      [
        { start: 0, length: 100 },
        { start: 1000, length: 100 },
      ],
      { gap: 2000 },
    );
    assert.deepStrictEqual(rangeCost(ranges), {
      requests: 1,
      requested: 1100,
      useful: 200,
      waste: 900,
    });
  });
});

describe("parseSlotValue", () => {
  // Every string below was collected from a real iteminfo_new.lub on disk.
  it("reads the three Chinese head positions", () => {
    assert.deepStrictEqual(parseSlotValue("頭上"), ["top"]);
    assert.deepStrictEqual(parseSlotValue("頭中"), ["mid"]);
    assert.deepStrictEqual(parseSlotValue("頭下"), ["low"]);
  });

  it("reads 披肩 as a garment, not a headgear", () => {
    assert.deepStrictEqual(parseSlotValue("披肩"), ["garment"]);
  });

  it("reads the joined Chinese forms, whatever separator they use", () => {
    assert.deepStrictEqual(parseSlotValue("頭上/中/下"), ["top", "mid", "low"]);
    assert.deepStrictEqual(parseSlotValue("頭上、中、下"), ["top", "mid", "low"]);
    assert.deepStrictEqual(parseSlotValue("頭上中下"), ["top", "mid", "low"]);
    assert.deepStrictEqual(parseSlotValue("頭上/中"), ["top", "mid"]);
    assert.deepStrictEqual(parseSlotValue("頭中/下"), ["mid", "low"]);
    assert.deepStrictEqual(parseSlotValue("頭上、頭中、頭下"), ["top", "mid", "low"]);
  });

  it("cuts the next field off when it runs into the value with no space", () => {
    // twRO ships this: the weight field collides with the position value.
    assert.deepStrictEqual(parseSlotValue("頭上重量: 0"), ["top"]);
    assert.deepStrictEqual(parseSlotValue("頭上/中重量：0"), ["top", "mid"]);
  });

  it("reads the Portuguese forms, joined by 'e' or a comma", () => {
    assert.deepStrictEqual(parseSlotValue("Topo"), ["top"]);
    assert.deepStrictEqual(parseSlotValue("Meio"), ["mid"]);
    assert.deepStrictEqual(parseSlotValue("Baixo"), ["low"]);
    assert.deepStrictEqual(parseSlotValue("Capa"), ["garment"]);
    assert.deepStrictEqual(parseSlotValue("Topo e Meio"), ["top", "mid"]);
    assert.deepStrictEqual(parseSlotValue("Topo, Meio e Baixo"), ["top", "mid", "low"]);
    assert.deepStrictEqual(parseSlotValue("Meio e baixo"), ["mid", "low"]);
    assert.deepStrictEqual(parseSlotValue("Superior"), ["top"]);
  });

  it("returns the slots in priority order however they were written", () => {
    assert.deepStrictEqual(parseSlotValue("Baixo e Meio"), ["mid", "low"]);
    assert.deepStrictEqual(parseSlotValue("頭下/上"), ["top", "low"]);
  });

  it("says nothing rather than guessing when the value names no position", () => {
    assert.deepStrictEqual(parseSlotValue("全職業"), []);
    assert.deepStrictEqual(parseSlotValue(""), []);
    assert.deepStrictEqual(parseSlotValue(undefined), []);
  });

  it("does not read a bare 上 outside a 頭 value as a headgear slot", () => {
    // "位置 : 上" never appears; requiring 頭 keeps an unrelated line from
    // claiming a slot just because it contains the character.
    assert.deepStrictEqual(parseSlotValue("上"), []);
  });
});

describe("parseSlotsFromLines", () => {
  it("finds the labelled line among a description's other lines", () => {
    const got = parseSlotsFromLines([
      "在頭上閃閃發光的小型聖誕樹。",
      "系列 : 服飾裝備 防禦 :  0",
      "位置 : 頭上 重量 : 0",
      "裝備 : 全職業",
    ]);
    assert.deepStrictEqual(got, ["top"]);
  });

  it("strips the colour codes that sit inside the value", () => {
    assert.deepStrictEqual(parseSlotsFromLines(["Equipa em: ^777777Topo e Meio^000000"]), ["top", "mid"]);
  });

  it("accepts the newer LATAM label too", () => {
    assert.deepStrictEqual(parseSlotsFromLines(["Posição: Topo"]), ["top"]);
  });

  it("keeps looking when a labelled line names no position", () => {
    assert.deepStrictEqual(parseSlotsFromLines(["位置 : 全職業", "位置 : 頭下"]), ["low"]);
  });

  it("returns nothing when no line carries the label", () => {
    assert.deepStrictEqual(parseSlotsFromLines(["uma descrição qualquer", "系列 : 服飾裝備"]), []);
  });
});

describe("kindFromSlots", () => {
  it("calls a garment-only item a garment and everything else a headgear", () => {
    assert.strictEqual(kindFromSlots(["garment"]), "robe");
    assert.strictEqual(kindFromSlots(["top"]), "acc");
    assert.strictEqual(kindFromSlots(["top", "mid", "low"]), "acc");
  });

  it("gives no namespace when no slot is known", () => {
    assert.strictEqual(kindFromSlots([]), null);
  });
});

describe("slotRank / bestSlot", () => {
  it("ranks headgear before garments, top before lower", () => {
    assert.deepStrictEqual(SLOT_PRIORITY, ["top", "mid", "low", "garment"]);
    assert.deepStrictEqual([...SLOT_PRIORITY].reverse().sort((a, b) => slotRank(a) - slotRank(b)), SLOT_PRIORITY,);
  });

  it("sorts an unknown slot after every known one", () => {
    assert.ok(slotRank("nonsense") > slotRank("garment"), "an unknown slot must sort last");
  });

  it("takes the most wanted slot of a multi-slot costume", () => {
    assert.strictEqual(bestSlot(["low", "top"]), "top");
    assert.strictEqual(bestSlot(["garment"]), "garment");
    assert.strictEqual(bestSlot([]), null);
    assert.strictEqual(bestSlot(undefined), null);
  });
});

describe("slot ordering of a plan", () => {
  const hit = (key, archive, seq) => ({
    key,
    archive,
    seq,
    uncompSize: 10,
    tier: "core",
    path: `p/${key}`,
  });
  const pair = (key, archive, seq) =>
    [SEX_M, SEX_F].map((sex) => [accPath(sex, key), hit(key, archive, seq)]);

  it("ranks a step by the most wanted slot it covers", () => {
    const step = { files: [hit("acc:1", "p.gpf", 1), hit("acc:2", "p.gpf", 1)] };
    const slotOf = new Map([
      ["acc:1", "low"],
      ["acc:2", "top"],
    ]);
    assert.strictEqual(bestSlotOfStep(step, slotOf), "top");
  });

  it("gives a step no rank when none of its views has a known slot", () => {
    const step = { files: [hit("acc:9", "p.gpf", 1)] };
    assert.strictEqual(bestSlotOfStep(step, new Map()), null);
  });

  it("fetches headgear before garments when a slot index is given", () => {
    const byOrigin = new Map([
      [
        "twro",
        new Map([
          ["data/sprite/로브/capa/1.spr", hit("robe:1", "capes.gpf", 10)],
          ...pair("acc:1", "hats.gpf", 99),
        ]),
      ],
    ]);
    const slotOf = new Map([
      ["robe:1", "garment"],
      ["acc:1", "top"],
    ]);
    // Without the index, patch order wins and the older cape patch comes first.
    assert.deepStrictEqual(coverPlan(byOrigin, ["acc:1", "robe:1"]).steps.map((s) => s.archive), [
      "capes.gpf",
      "hats.gpf",
    ]);
    // With it, the hats come first although their patch is newer.
    assert.deepStrictEqual(coverPlan(byOrigin, ["acc:1", "robe:1"], { slotOf }).steps.map((s) => s.archive), ["hats.gpf", "capes.gpf"]);
  });

  it("falls back to patch order between steps of the same slot", () => {
    const byOrigin = new Map([
      ["twro", new Map([...pair("acc:1", "new.gpf", 90), ...pair("acc:2", "old.gpf", 10)])],
    ]);
    const slotOf = new Map([
      ["acc:1", "top"],
      ["acc:2", "top"],
    ]);
    assert.deepStrictEqual(coverPlan(byOrigin, ["acc:1", "acc:2"], { slotOf }).steps.map((s) => s.archive), ["old.gpf", "new.gpf"]);
  });
});

describe("fileEntries", () => {
  // GRF names are Windows-style; building them keeps a literal backslash out
  // of the source, where it would read as an escape.
  const BS = String.fromCharCode(92);
  const name = (...parts) => ["data", "sprite", "로부", "c_cape", ...parts].join(BS);

  it("drops the directory entries a GRF table lists beside its files", () => {
    // The real shape: a garment folder ships 남/여 as directories and the
    // sprites under them as files. Writing the directories as empty files is
    // what made the first twRO fetch die with EEXIST.
    const entries = [
      { filename: name("남"), flags: 0x00 },
      { filename: name("남", "x.act"), flags: 0x01 },
      { filename: name("여"), flags: 0x02 },
    ];
    assert.deepStrictEqual(fileEntries(entries).map((e) => e.filename), [name("남", "x.act")]);
  });

  it("keeps an encrypted file, whose flags carry the file bit plus more", () => {
    assert.strictEqual((fileEntries([{ flags: 0x01 | 0x02 }, { flags: 0x01 | 0x04 }])).length, 2);
  });

  it("drops the v0x300 entries whose flags carry 0x80 and no file bit", () => {
    assert.deepStrictEqual(fileEntries([{ flags: 0x80 }]), []);
  });
});

describe("blockedFrom", () => {
  // The real ledger shapes: jRO has 2,639 ok / 733 rgz / 68 blocked, kRO also
  // carries an "unsupported GRF version" row.
  const rows = [
    { file: "a.gpf", status: "ok", note: "" },
    { file: "b.gsf", status: "blocked", note: "v0x300 payloads do not extract yet" },
    { file: "c.rgz", status: "rgz", note: "no file table" },
    { file: "d.grf", status: "blocked", note: "unsupported GRF version 0x201" },
  ];

  it("names only the archives that could not be read", () => {
    assert.deepStrictEqual(blockedFrom(rows), new Set(["b.gsf", "d.grf"]));
  });

  it("does not treat a tableless rgz as blocked — it is simply not in the index", () => {
    assert.strictEqual(blockedFrom(rows).has("c.rgz"), false);
  });

  it("is empty for a ledger with nothing blocked", () => {
    assert.deepStrictEqual(blockedFrom([{ file: "a.gpf", status: "ok" }]), new Set());
  });
});

describe("originCanDraw", () => {
  const sex = (s) => `data/sprite/악세사리/${s}/${s}chapeu.spr`;

  it("needs both sexes for a headgear", () => {
    assert.strictEqual(originCanDraw("acc", [sex("남"), sex("여")]), true);
    assert.strictEqual(originCanDraw("acc", [sex("남")]), false);
    assert.strictEqual(originCanDraw("acc", [sex("여")]), false);
  });

  it("reads the sex from the file name, not from the folder", () => {
    // The male sprite copied into the female folder is still the male sprite:
    // the client resolves the file name.
    const maleInFemaleFolder = `data/sprite/악세사리/${SEX_F}/${SEX_M}chapeu.spr`;
    assert.strictEqual(originCanDraw("acc", [sex(SEX_M), maleInFemaleFolder]), false);
    assert.strictEqual(originCanDraw("acc", [sex(SEX_M), sex(SEX_F)]), true);
  });

  it("needs one .spr anywhere in a garment folder, and .act alone is not it", () => {
    assert.strictEqual(originCanDraw("robe", ["robe/x/a.act", "robe/x/deep/b.spr"]), true);
    assert.strictEqual(originCanDraw("robe", ["robe/x/a.act", "robe/x/b.act"]), false);
  });

  it("is false for nothing at all", () => {
    assert.strictEqual(originCanDraw("robe", []), false);
  });
});

describe("planByCostume", () => {
  it("groups a view's files and keeps the origin that supplies them", () => {
    const got = planByCostume([
      { kind: "robe", view: "7", origin: "iro", path: "data/sprite/x.spr" },
      { kind: "robe", view: "7", origin: "iro", path: "data/sprite/x.act" },
      { kind: "acc", view: "7", origin: "twro", path: "data/sprite/h.spr" },
    ]);
    // Same view id in two namespaces is two costumes, not one.
    assert.deepStrictEqual([...got.keys()], ["robe:7", "acc:7"]);
    assert.deepStrictEqual(got.get("robe:7"), {
      kind: "robe",
      view: 7,
      origin: "iro",
      files: ["data/sprite/x.spr", "data/sprite/x.act"],
    });
  });
});

describe("slotsByCostume", () => {
  it("splits the slot column and leaves an unknown slot empty", () => {
    const got = slotsByCostume([
      { kind: "acc", view: "1", slots: "top,mid" },
      { kind: "acc", view: "2", slots: "" },
    ]);
    assert.deepStrictEqual(got.get("acc:1"), ["top", "mid"]);
    assert.deepStrictEqual(got.get("acc:2"), []);
  });
});

describe("costumeDraws", () => {
  const probe = {
    robeHasSprite: (origin, sprite) => sprite === "capa_boa",
    headgearPair: (origin, sprite) => sprite === "chapeu_bom",
  };

  it("asks the right question per namespace", () => {
    assert.strictEqual(costumeDraws({ kind: "robe" }, "capa_boa", probe), true);
    assert.strictEqual(costumeDraws({ kind: "robe" }, "chapeu_bom", probe), false);
    assert.strictEqual(costumeDraws({ kind: "acc" }, "chapeu_bom", probe), true);
  });

  it("is false without a sprite name, since nothing can resolve it", () => {
    assert.strictEqual(costumeDraws({ kind: "acc" }, "", probe), false);
  });
});

describe("treeProbe", () => {
  // A fake tree below the garment root, in the shape the mirror has. The probe
  // builds absolute paths through `paths.mirrorDir`, so the fake keys on what
  // follows the Korean garment folder rather than on the whole path.
  const ROOT = "로브/";
  const tree = {
    capa_boa: ["frames"],
    "capa_boa/frames": ["a.spr", "a.act"],
    capa_vazia: ["b.act"],
  };
  const under = (dir) => {
    const rel = dir.split(sep).join("/");
    const i = rel.indexOf(ROOT);
    return i === -1 ? rel : rel.slice(i + ROOT.length);
  };
  const probe = treeProbe({
    readdirSync: (dir) => {
      const entries = tree[under(dir)];
      if (!entries) throw new Error("ENOENT");
      return entries.map((name) => ({
        name,
        isDirectory: () => Boolean(tree[`${under(dir)}/${name}`]),
      }));
    },
    existsSync: (p) => /[남여]chapeu_bom[.]spr$|남meio[.]spr$/.test(p),
  });

  it("finds a .spr nested below the garment folder", () => {
    assert.strictEqual(probe.robeHasSprite("iro", "capa_boa"), true);
  });

  it("matches the folder case-insensitively, as the mirror is written", () => {
    assert.strictEqual(probe.robeHasSprite("iro", "CAPA_BOA"), true);
  });

  it("drops the leading underscore a sprite name may carry", () => {
    assert.strictEqual(probe.robeHasSprite("iro", "_capa_boa"), true);
  });

  it("is false for a folder with only .act files, and for one that is absent", () => {
    // The 27 garments the old plan left as animation data with no artwork.
    assert.strictEqual(probe.robeHasSprite("iro", "capa_vazia"), false);
    assert.strictEqual(probe.robeHasSprite("iro", "nao_existe"), false);
  });

  it("requires both sexes for a headgear", () => {
    assert.strictEqual(probe.headgearPair("iro", "chapeu_bom"), true);
    // Only the male sprite exists: a costume half the players cannot see is
    // not listed. Two kRO Zero hats arrived exactly like this.
    assert.strictEqual(probe.headgearPair("iro", "meio"), false);
  });
});

describe("originsFromPaths", () => {
  const costumes = [
    { kind: "acc", view: 1, sprite: "_chapeu" },
    { kind: "robe", view: 2, sprite: "capa" },
    { kind: "acc", view: 3, sprite: "" },
  ];
  const acc = (sex, name) => `data\\sprite\\악세사리\\${sex}\\${sex}${name}`;
  const index = new Map([
    // Ships both sexes of the hat and a sprite inside the garment's folder.
    [
      "iro",
      [acc("남", "_chapeu.spr"), acc("여", "_chapeu.spr"), "data\\sprite\\로브\\capa\\남_capa.spr"],
    ],
    // Only the male hat, and only animation data for the garment.
    ["twro", [acc("남", "_Chapeu.SPR"), "data\\sprite\\로브\\capa\\남_capa.act"]],
    // Has the garment, not the hat.
    ["jro", ["data\\sprite\\로브\\capa\\여_capa.spr"]],
  ]);
  const holders = originsFromPaths(costumes, index);

  it("credits a server only when it ships both sexes of a headgear", () => {
    // twRO ships the male sprite alone -- the same rule costumeDraws applies,
    // because "has it" has to mean "could draw it".
    assert.deepStrictEqual(holders.get("acc:1"), ["iro"]);
  });

  it("credits a garment to every server with a sprite in its folder", () => {
    // twRO's folder holds only an .act, which draws nothing.
    assert.deepStrictEqual(holders.get("robe:2"), ["iro", "jro"]);
  });

  it("matches regardless of the case and slashes an archive used", () => {
    // Paths inside a GRF are Windows-style and inconsistently cased; iRO's
    // rows above are lowercase and twRO's are not.
    assert.deepStrictEqual(originsFromPaths([costumes[0]], new Map([["twro", [acc("남", "_CHAPEU.spr"), acc("여", "_chapeu.SPR")]]])).get("acc:1"), ["twro"]);
  });

  it("credits nothing to a costume with no sprite name", () => {
    assert.deepStrictEqual(holders.get("acc:3"), []);
  });
});

describe("buildCatalogue", () => {
  const plan = [
    { kind: "acc", view: "1", origin: "twro", path: "a.spr" },
    { kind: "acc", view: "1", origin: "twro", path: "b.spr" },
    { kind: "acc", view: "2", origin: "iro", path: "c.spr" },
    { kind: "acc", view: "3", origin: "iro", path: "d.spr" },
  ];
  const shortlist = [
    { kind: "acc", view: "1", sprite: "bom", name: "Chapéu Bom", nameOrigin: "latam", aegis: "C_Good" },
    { kind: "acc", view: "2", sprite: "quebrado", name: "", nameOrigin: "", aegis: "" },
  ];
  const slots = [{ kind: "acc", view: "1", slots: "top" }];
  const probe = { headgearPair: (o, sprite) => sprite === "bom", robeHasSprite: () => false };
  const built = buildCatalogue({
    plan,
    shortlist,
    slots,
    probe,
    present: (origin, path) => path !== "b.spr",
  });

  it("lists only the costumes that draw", () => {
    assert.strictEqual(built.costumes.length, 1);
    assert.deepStrictEqual(built.costumes[0], {
      kind: "acc",
      view: 1,
      sprite: "bom",
      origin: "twro",
      // No path index was given, so the only server known to have it is the
      // tree it came from.
      origins: ["twro"],
      name: "Chapéu Bom",
      nameOrigin: "latam",
      aegis: "C_Good",
      slots: ["top"],
      // What is on disk, which after --prune-robes is not what the plan listed.
      files: 1,
    });
  });

  it("counts the two reasons a costume is left out separately", () => {
    assert.deepStrictEqual(built.stats.skipped, { incomplete: 1, unknownToShortlist: 1 });
  });

  it("totals by origin and by slot, with an unknown slot as ?", () => {
    hasFields(built.stats, {
      total: 1,
      named: 1,
      withAegis: 1,
      perOrigin: { twro: 1 },
      perSlot: { top: 1 },
    });
  });

  it("marks a costume with no slot line as ? rather than dropping it", () => {
    const other = buildCatalogue({
      plan: [{ kind: "acc", view: "1", origin: "twro", path: "a.spr" }],
      shortlist,
      slots: [],
      probe,
      present: () => true,
    });
    assert.deepStrictEqual(other.costumes[0].slots, []);
    assert.deepStrictEqual(other.stats.perSlot, { "?": 1 });
  });

  it("carries every client's name, keyed by the normalised sprite", () => {
    const withNames = buildCatalogue({
      plan,
      shortlist,
      slots,
      probe,
      present: (origin, path) => path !== "b.spr",
      // The catalogue's sprite is `bom`; a client's table would hold `_Bom`.
      clientNames: new Map([["bom", { iro: "Good Hat", jro: "[衣装] 良い帽子" }]]),
    });
    assert.deepStrictEqual(withNames.costumes[0].names, {
      iro: "Good Hat",
      jro: "[衣装] 良い帽子",
    });
    hasFields(withNames.stats, {
      withNames: 1,
      namesPerOrigin: { iro: 1, jro: 1 },
    });
  });

  it("omits `names` rather than publishing an empty object", () => {
    // kRO Zero ships no item table at all, so "no key" is the honest statement
    // and `{}` would claim we looked and found nothing.
    for (const clientNames of [new Map(), new Map([["bom", {}]])]) {
      const got = buildCatalogue({
        plan,
        shortlist,
        slots,
        probe,
        present: (origin, path) => path !== "b.spr",
        clientNames,
      });
      assert.ok(!("names" in got.costumes[0]));
      hasFields(got.stats, { withNames: 0, namesPerOrigin: {} });
    }
  });
});

describe("clientNamesBySprite", () => {
  const tables = [
    {
      origin: "iro",
      // The .txt tables store names underscore-joined; the client spaces them.
      items: [[2211, "두건"], [20203, "두건"]],
      names: new Map([[2211, "Bandana"], [20203, "Costume:_Bandana"]]),
      underscored: true,
    },
    {
      origin: "twro",
      items: [[2211, "두건"], [20203, "두건"]],
      names: new Map([[2211, "方頭巾"], [20203, "(服飾)方頭巾"]]),
      underscored: false,
    },
  ];

  it("prefers the costume-flagged id when several items share a sprite", () => {
    const got = clientNamesBySprite({ tables, isCostume: (id) => id === 20203 });
    assert.deepStrictEqual(got.get("두건"), {
      iro: "Costume: Bandana",
      twro: "(服飾)方頭巾",
    });
  });

  it("falls back to the lowest id when nothing is flagged", () => {
    const got = clientNamesBySprite({ tables });
    assert.deepStrictEqual(got.get("두건"), { iro: "Bandana", twro: "方頭巾" });
  });

  it("keys on the normalised sprite, so `_Name` and `name` meet", () => {
    const got = clientNamesBySprite({
      tables: [
        {
          origin: "jro",
          items: [[1, "_C_Rhythm_Hairband"]],
          names: new Map([[1, "リズム"]]),
        },
      ],
    });
    assert.deepStrictEqual(got.get("c_rhythm_hairband"), { jro: "リズム" });
    assert.strictEqual(got.get("_c_rhythm_hairband"), undefined);
  });

  it("leaves the costume markers alone", () => {
    const got = clientNamesBySprite({ tables, isCostume: (id) => id === 20203 });
    // `(服飾)` is the only thing separating this from the base item of the same
    // name, so it is published as the client writes it.
    assert.match(got.get("두건").twro, /^[(（]服飾/);
  });

  it("drops a client that has no name table rather than keying it empty", () => {
    const got = clientNamesBySprite({
      tables: [{ origin: "krozero", items: [[1, "두건"]], names: new Map() }, ...tables],
    });
    assert.ok(!("krozero" in got.get("두건")));
  });

  it("skips the placeholders the clients ship for unreleased rows", () => {
    const got = clientNamesBySprite({
      tables: [
        {
          origin: "kro",
          items: [[1, "x"], [2, "y"], [3, "z"]],
          names: new Map([[1, "#비매품#"], [2, "  "], [3, "Sprite Name"]]),
        },
      ],
    });
    assert.strictEqual(got.size, 0);
  });
});

describe("the name helpers", () => {
  it("normResource lowercases and drops the accessory underscore", () => {
    assert.strictEqual(normResource("_C_Rhythm_Hairband"), "c_rhythm_hairband");
    assert.strictEqual(normResource("__두건"), "두건");
    assert.strictEqual(normResource(undefined), "");
  });

  it("spaceOut undoes the .txt tables' underscore convention", () => {
    assert.strictEqual(spaceOut("Costume:_Shining_Sun"), "Costume: Shining Sun");
    assert.strictEqual(spaceOut("Red_Potion"), "Red Potion");
  });

  it("isPlaceholderName catches the stubs and nothing real", () => {
    for (const bad of ["", "   ", "#비매품#", "Sprite Name", null, undefined]) {
      assert.ok(isPlaceholderName(bad), `${bad} should be a placeholder`);
    }
    for (const good of ["Bandana", "(服飾)方頭巾", "두건"]) {
      assert.ok(!isPlaceholderName(good), `${good} should be kept`);
    }
  });
});

describe("catalogueDocument", () => {
  const doc = catalogueDocument(
    {
      costumes: [
        { kind: "acc", view: 1, sprite: "bom", origin: "twro", slots: ["top"] },
        { kind: "robe", view: 2, sprite: "capa", origin: "iro", slots: [] },
      ],
      stats: { total: 2, named: 1, withAegis: 0, perOrigin: { twro: 1, iro: 1 }, perSlot: {} },
    },
    { generatedAt: "2026-11-18" },
  );

  it("names every origin it used, so a consumer can label a badge", () => {
    assert.deepStrictEqual(Object.keys(doc.origins).sort(), ["iro", "twro"]);
    assert.strictEqual(doc.origins.twro.label, ORIGINS.twro.label);
    assert.strictEqual(doc.origins.twro.assets, "mirror/twro");
  });

  it("carries the sprite name, not just the view id", () => {
    // A foreign view id may be absent from the LATAM table, or mean something
    // else there, so the name is what a consumer resolves by.
    assert.deepStrictEqual(doc.costumes.map((c) => c.sprite), ["bom", "capa"]);
    assert.strictEqual(doc.version, 1);
    assert.strictEqual(doc.generatedAt, "2026-11-18");
  });
});
