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
import { join, sep } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// The sex marks that prefix every headgear sprite file name.
const SEX_M = "남";
const SEX_F = "여";
// A headgear sprite's real path shape, which `originCanDraw` reads.
const accPath = (sex, key = "chapeu") =>
  `data/sprite/악세사리/${sex}/${sex}${key}.spr`;
import { ORIGINS, parsePatchList, rgzProbeOrder, selectOrigins, GRF_EXT, RGZ_EXT } from "./origins.mjs";
import { ITEM_INFO_FILES, ITEM_INFO_TAILS } from "./iteminfo.mjs";
import {
  ACTIONS,
  GENDERS,
  VIEW_PARAM,
  firstPoseThatDraws,
  ladderFor,
  poseLadder,
  probeRenderable,
} from "./renderprobe.mjs";
import { readAppViews, readRenderProbe } from "./stage3-shortlist.mjs";
import { tableFor } from "./slotindex.mjs";
import { diffCatalogues, indexRows } from "./diff-catalogues.mjs";
import {
  effectFolders,
  effectTargets,
  isEffectTarget,
  normalizePath,
  robeTargets,
  spriteTargets,
  targetsFor,
} from "./pathshapes.mjs";
import { legacyNameCoverage } from "./coverage.mjs";
import { viewsFromItems } from "./stage2-catalogue.mjs";
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
    assert.deepStrictEqual(targetsFor("acc", "_C_Chained_Bear"), [
      ...spriteTargets("_C_Chained_Bear"),
      ...effectTargets("_C_Chained_Bear"),
    ]);
    assert.deepStrictEqual(targetsFor("robe", "기린의날개"), [
      ...robeTargets("기린의날개"),
      ...effectTargets("기린의날개"),
    ]);
  });

  it("asks for the .str folder in both namespaces", () => {
    for (const kind of ["acc", "robe"]) {
      assert.ok(
        targetsFor(kind, "_C_CLB_SS_LL").includes("/texture/effect/efst_c_clb_ss_ll/"),
        kind,
      );
    }
  });
});

describe("effectTargets", () => {
  it("names the folder after the sprite, and after the sprite without its c_", () => {
    // Both forms exist in the clients' patches: the costume's own
    // `efst_C_CLB_SS_LL`, and `efst_flutterbutterfly_bl` for a costume whose
    // sprite is `_C_FlutterButterfly_BL`.
    assert.deepStrictEqual(effectTargets("_C_CLB_SS_LL"), [
      "/texture/effect/efst_c_clb_ss_ll/",
      "/texture/effect/efst_clb_ss_ll/",
      "/texture/effect/c_clb_ss_ll/",
    ]);
    assert.deepStrictEqual(effectTargets("_C_FlutterButterfly_BL"), [
      "/texture/effect/efst_c_flutterbutterfly_bl/",
      "/texture/effect/efst_flutterbutterfly_bl/",
      "/texture/effect/c_flutterbutterfly_bl/",
    ]);
  });

  it("asks for the unprefixed folder too, but never for a stripped name", () => {
    // `robe:94 C_Rotating_Gears` keeps its animation in
    // `/texture/effect/C_Rotating_Gears/gearwheel.str`, with no `efst_`. The
    // stripped form is only ever asked for WITH the prefix: `/texture/effect/`
    // is the game's whole effect library, and `rotating_gears` there could be
    // anybody's folder.
    assert.deepStrictEqual(effectTargets("C_Rotating_Gears"), [
      "/texture/effect/efst_c_rotating_gears/",
      "/texture/effect/efst_rotating_gears/",
      "/texture/effect/c_rotating_gears/",
    ]);
    assert.strictEqual(
      effectTargets("C_Rotating_Gears").includes("/texture/effect/rotating_gears/"),
      false,
    );
  });

  it("asks once per form when the sprite has no c_ to strip", () => {
    assert.deepStrictEqual(effectTargets("_Jirant_Circlet"), [
      "/texture/effect/efst_jirant_circlet/",
      "/texture/effect/jirant_circlet/",
    ]);
    assert.deepStrictEqual(effectTargets("_붉은고양이귀케이프"), [
      "/texture/effect/efst_붉은고양이귀케이프/",
      "/texture/effect/붉은고양이귀케이프/",
    ]);
  });

  it("names the folders the mirror would hold, for stage 5 to look inside", () => {
    // Same list as the targets, minus the directory, because the two must not
    // disagree: the planner fetches by prefix and the catalogue looks for a
    // `.str` by folder name.
    assert.deepStrictEqual(effectFolders("_C_CLB_SS_LL"), [
      "efst_c_clb_ss_ll",
      "efst_clb_ss_ll",
      "c_clb_ss_ll",
    ]);
    assert.deepStrictEqual(
      effectTargets("_C_CLB_SS_LL"),
      effectFolders("_C_CLB_SS_LL").map((f) => `/texture/effect/${f}/`),
    );
  });

  it("matches the real .str path a patch table carries", () => {
    const targets = effectTargets("_C_CLB_SS_LL");
    for (const p of [
      String.raw`data\texture\effect\efst_C_CLB_SS_LL\bbcat.str`,
      String.raw`data\texture\effect\efst_C_CLB_SS_LL\catan01.TGA`,
    ]) {
      const norm = normalizePath(p);
      assert.strictEqual(targets.some((t) => norm.includes(t)), true, p);
    }
  });

  it("skips a name the table does not have", () => {
    assert.deepStrictEqual(effectTargets(null, "", undefined), []);
  });

  it("counts both effect trees as the effect tier", () => {
    assert.strictEqual(isEffectTarget("/sprite/이팩트/c_chained_bear/"), true);
    assert.strictEqual(isEffectTarget("/texture/effect/efst_c_clb_ss_ll/"), true);
    assert.strictEqual(isEffectTarget("/sprite/악세사리/남/남_c_chained_bear."), false);
    assert.strictEqual(isEffectTarget("/sprite/로브/기린의날개/"), false);
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

describe("poseLadder", () => {
  const BODY = "job=0&frame=0";

  it("tries the thumbnail pose first", () => {
    // Almost every item is settled by one request, so the pose the grid uses
    // has to be the one that request spends.
    assert.strictEqual(poseLadder(BODY)[0], `${BODY}&gender=male&action=0`);
  });

  it("covers every action in both genders, and nothing twice", () => {
    const ladder = poseLadder(BODY);
    assert.strictEqual(ladder.length, ACTIONS.length * GENDERS.length);
    assert.strictEqual(new Set(ladder).size, ladder.length);
  });
});

describe("firstPoseThatDraws", () => {
  // A fake gateway. The bare character is whatever a pose query alone returns;
  // a probe for an item renders `<pose>&item=<id>`. `draws` says which poses a
  // given item is visible in — everything else comes back byte-identical to
  // the bare character, which is exactly how /image behaves.
  const fakeGateway = (draws) => async (url) => {
    const query = String(url).split("?")[1];
    const m = /&item=([a-z]+)$/.exec(query);
    const pose = m ? query.slice(0, m.index) : query;
    const body = m && (draws[m[1]] ?? []).includes(pose) ? `${m[1]}@${pose}` : `bare@${pose}`;
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body) };
  };

  const run = (items, ladder) =>
    firstPoseThatDraws({
      items,
      ladder,
      base: "http://probe.invalid",
      width: 1,
      queryFor: (item, pose) => `${pose}&item=${item}`,
    });

  /** Swaps in the fake gateway for one call and always puts the real one back. */
  async function withGateway(fetchImpl, body) {
    const real = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      return await body();
    } finally {
      globalThis.fetch = real;
    }
  }

  it("stops at the first pose that draws, and charges nothing extra for it", async () => {
    const ladder = poseLadder("b");
    let calls = 0;
    const gateway = fakeGateway({ hat: [ladder[0]] });
    const r = await withGateway(
      async (url) => {
        calls++;
        return gateway(url);
      },
      () => run(["hat"], ladder),
    );
    assert.strictEqual(r.drew.get("hat").pose, ladder[0]);
    assert.strictEqual(r.extra, 0);
    // One baseline per pose, then a single probe: an item that draws standing
    // costs one request, which is what keeps a whole-catalogue sweep affordable.
    assert.strictEqual(calls, ladder.length + 1);
  });

  it("finds a sprite that only draws once the character moves", async () => {
    // The case a single-pose probe gets wrong, and the reason the ladder
    // exists: iRO's _low_pony_bu is empty standing, sitting and walking.
    const ladder = poseLadder("b");
    const late = ladder[3];
    const r = await withGateway(fakeGateway({ late: [late] }), () => run(["late"], ladder));
    assert.strictEqual(r.drew.get("late").pose, late);
    assert.strictEqual(r.extra, 3);
  });

  it("calls a sprite blank only after every pose, and never on an error", async () => {
    const ladder = poseLadder("b");
    const bare = fakeGateway({});
    const r = await withGateway(
      async (url) => (String(url).includes("item=boom") ? { ok: false, status: 503 } : bare(url)),
      () => run(["ghost", "boom"], ladder),
    );
    // Nothing drew in any pose: that, and only that, is the blank verdict.
    assert.strictEqual(r.drew.get("ghost"), null);
    // A request that could not be made is not a verdict about the sprite. The
    // blank sweep deletes tiles from the app's catalogue on this answer.
    assert.notStrictEqual(r.drew.get("boom"), null);
    assert.ok(r.drew.get("boom").error, "an unreachable probe must report an error");
    assert.strictEqual(r.errors, 1);
  });
});

describe("probeRenderable across both sprite tables", () => {
  // The regression this directory paid for in a wrong audit: the probe drove
  // `headgear=` only, renderable.tsv carried no kind column, and stage 3 read
  // every row as an accessory — so no garment view was ever asked about and
  // the shortlist could not say `draws` for one. See renderprobe.mjs.
  const asked = [];
  const gateway = async (url) => {
    const query = String(url).split("?")[1];
    asked.push(query);
    // Only `garment=7` draws anything; everything else is the bare character.
    const body = /&garment=7$/.test(query) ? "cape" : "bare";
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body) };
  };
  async function withGateway(body) {
    const real = globalThis.fetch;
    globalThis.fetch = gateway;
    try {
      return await body();
    } finally {
      globalThis.fetch = real;
    }
  }

  it("drives garment= for a robe view and headgear= for an accessory", async () => {
    asked.length = 0;
    const r = await withGateway(() =>
      probeRenderable(
        [
          { kind: "acc", view: 7, sprite: "_hat" },
          { kind: "robe", view: 7, sprite: "wing" },
        ],
        { base: "http://probe.invalid", width: 1 },
      ),
    );
    // Same number in two tables, two different answers — which is the whole
    // reason the key is (kind, view) and not view.
    assert.deepStrictEqual(
      r.rows.map((x) => [x.kind, x.view, x.result]),
      [
        ["acc", 7, "blank"],
        ["robe", 7, "drew"],
      ],
    );
    assert.ok(asked.some((q) => q.endsWith("&headgear=7")), "the accessory view must be asked as headgear=");
    assert.ok(asked.some((q) => q.endsWith("&garment=7")), "the garment view must be asked as garment=");
    assert.deepStrictEqual(r.byKind.acc, { drew: 0, blank: 1, error: 0 });
    assert.deepStrictEqual(r.byKind.robe, { drew: 1, blank: 0, error: 0 });
  });

  it("defaults a view with no kind to the accessory table", async () => {
    // Keeps every caller that predates the split reading the same way.
    const r = await withGateway(() =>
      probeRenderable([{ view: 7, sprite: "_hat" }], { base: "http://probe.invalid", width: 1 }),
    );
    assert.strictEqual(r.rows[0].kind, "acc");
  });

  it("keeps the class in the pose it recorded, because the garment ladder varies it", async () => {
    const r = await withGateway(() =>
      probeRenderable([{ kind: "robe", view: 7, sprite: "wing" }], {
        base: "http://probe.invalid",
        job: 4054,
        width: 1,
      }),
    );
    // A garment that draws only on one class is a fact worth not re-probing for.
    assert.match(r.rows[0].pose, /^job=4054&gender=male&action=0$/);
  });
});

describe("ladderFor", () => {
  it("spends the same poses on a garment as on a headgear", () => {
    // Walking extra classes for garments was tried and measured away: over all
    // 330 of LATAM's garment views, every one of the 223 that draws is settled
    // on the asked-for class. See the note in renderprobe.mjs.
    const acc = ladderFor("acc", 4054);
    const robe = ladderFor("robe", 4054);
    assert.deepStrictEqual(robe, acc);
    assert.strictEqual(acc.length, ACTIONS.length * GENDERS.length);
  });

  it("names a parameter for every kind it can probe", () => {
    // A kind with no parameter would build `undefined=<view>` and read blank
    // for every view in that table — the failure this whole change is about.
    assert.deepStrictEqual(Object.keys(VIEW_PARAM).sort(), ["acc", "robe"]);
  });
});

describe("readRenderProbe", () => {
  const write = (text) => {
    const f = join(mkdtempSync(join(tmpdir(), "renderprobe-")), "renderable.tsv");
    writeFileSync(f, text, "utf8");
    return f;
  };

  it("keys a kinded file by both namespaces", () => {
    const got = readRenderProbe(
      write(
        [
          "kind\tview\tsprite\tresult\tpose\tbytes",
          "acc\t8\t_mask\tdrew\tjob=4054&gender=male&action=0\t900",
          "robe\t8\twing\tblank\t\t0",
        ].join("\n"),
      ),
    );
    // LATAM's 8 is a surgical mask as a headgear and Rudra's wings as a
    // garment. One of them draws here and the other does not.
    assert.strictEqual(got.get("acc:8"), "drew");
    assert.strictEqual(got.get("robe:8"), "blank");
  });

  it("still reads a file written before the kind column, as accessories", () => {
    // That is what those rows meant: the old probe only ever drove headgear=.
    const got = readRenderProbe(
      write(["view\tsprite\tresult\tpose\tbytes", "8\t_mask\tdrew\tgender=male&action=0\t900"].join("\n")),
    );
    assert.deepStrictEqual([...got], [["acc:8", "drew"]]);
  });

  it("is empty for a file that is not there, rather than throwing", () => {
    // Both of stage 3's inputs are optional; a run without one says so.
    assert.strictEqual(readRenderProbe(join(tmpdir(), "no-such-renderable.tsv")).size, 0);
  });
});

describe("readAppViews", () => {
  const write = (doc) => {
    const f = join(mkdtempSync(join(tmpdir(), "appviews-")), "costumes.json");
    writeFileSync(f, JSON.stringify(doc), "utf8");
    return f;
  };

  it("takes the namespace from the slot when the app says nothing else", () => {
    const got = readAppViews(
      write({
        items: [
          { id: 1, name: "hat", slots: ["top"], view: 11 },
          { id: 2, name: "cape", slots: ["garment"], view: 11 },
        ],
      }),
    );
    assert.deepStrictEqual([...got].sort(), ["acc:11", "robe:11"]);
  });

  it("obeys viewKind, which the app publishes only when the slot is wrong", () => {
    // "Buquê Gigantesco" equips in Baixo and its 128 is the C_Clutch_Bouquet
    // robe; two shields equip in Capa and their ids are accessory ids. Reading
    // the slot alone got all three backwards — it marked a view listed that is
    // a different costume in the other table, and left the real one unlisted.
    const got = readAppViews(
      write({
        items: [
          { id: 480177, name: "Buquê Gigantesco", slots: ["low"], viewKind: "garment", view: 128 },
          { id: 480807, name: "Escudo Petulante", slots: ["garment"], viewKind: "headgear", view: 2828 },
        ],
      }),
    );
    assert.deepStrictEqual([...got].sort(), ["acc:2828", "robe:128"]);
  });

  it("skips a row with no usable view id", () => {
    // View 0 is the invisible costumes; a missing one is an effect-only row.
    const got = readAppViews(
      write({ items: [{ id: 1, slots: ["top"], view: 0 }, { id: 2, slots: ["top"] }] }),
    );
    assert.strictEqual(got.size, 0);
  });
});

describe("diffCatalogues", () => {
  it("skips the header row rather than reading it as a view", () => {
    // readRows already strips it; the guard is for a hand-made TSV, and for the
    // app-repo original's habit of splitting every line positionally.
    const s = indexRows([{ view: "view", sprite: "sprite" }, { view: "7", sprite: "_hat" }]);
    assert.deepStrictEqual([...s.byView.keys()], [7]);
  });

  it("takes the Korean sprite name, falling back to the English one", () => {
    const s = indexRows([
      { view: "1", sprite: "_kr", spriteEng: "eng" },
      { view: "2", sprite: "", spriteEng: "only_eng" },
    ]);
    assert.strictEqual(s.byView.get(1).sprite, "_kr");
    assert.strictEqual(s.byView.get(2).sprite, "only_eng");
  });

  it("separates a real disagreement from a view only one side names", () => {
    // The app-repo original conflated the two, which is why LATAM against jRO
    // read as 3 accessory conflicts where this repo has always recorded 2.
    const a = indexRows([
      { view: "1", sprite: "_same" },
      { view: "2", sprite: "_ours" },
      { view: "3", sprite: "_only_we_name_it" },
    ]);
    const b = indexRows([
      { view: "1", sprite: "_same" },
      { view: "2", sprite: "_theirs" },
      { view: "3", sprite: "" },
    ]);
    const d = diffCatalogues(a, b);
    assert.deepStrictEqual(d.viewConflicts, [2]);
    assert.deepStrictEqual(d.viewUnnamedOneSide, [3]);
    assert.strictEqual(d.bothNamed.length, 2);
  });

  it("reports a name that moved view id, and one new to the other side", () => {
    const a = indexRows([{ view: "10", sprite: "_moved" }, { view: "11", sprite: "_ours" }]);
    const b = indexRows([{ view: "20", sprite: "_moved" }, { view: "21", sprite: "_theirs" }]);
    const d = diffCatalogues(a, b);
    assert.deepStrictEqual(d.movedNames, ["_moved"]);
    assert.deepStrictEqual(d.onlyA, ["_ours"]);
    assert.deepStrictEqual(d.onlyB, ["_theirs"]);
  });

  it("flags a sprite name used by two view ids in one client", () => {
    // Where that happens, keying by name is itself ambiguous, so it is a
    // finding to report and not a duplicate to tidy away.
    const a = indexRows([{ view: "1", sprite: "_twice" }, { view: "2", sprite: "_twice" }]);
    const d = diffCatalogues(a, indexRows([]));
    assert.deepStrictEqual(
      d.dupesA.map(([n, rows]) => [n, rows.map((r) => r.view)]),
      [["_twice", [1, 2]]],
    );
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

describe("viewsFromItems", () => {
  // The real case: jRO's AccessoryId declares view 881 and no client's AccName
  // names it, while five item tables carry item 18742, ClassNum 881, resource
  // 달과별의장식, equip mid, and the costume flag on two of them.
  const tables = {
    accSprites: new Set(["_고글"]),
    robeSprites: new Set(["기린의날개"]),
    accViews: new Set([1]),
    robeViews: new Set([3]),
  };
  const item = (view, resource, equip, extra = {}) => ({
    view,
    resource,
    equip,
    name: null,
    costume: false,
    ...extra,
  });

  it("places a headgear the sprite tables never named", () => {
    const got = viewsFromItems(new Map([[18742, item(881, "달과별의장식", ["mid"])]]), tables);
    assert.deepStrictEqual(got.acc, [
      { view: 881, sprite: "_달과별의장식", item: 18742, costume: false },
    ]);
    assert.deepStrictEqual(got.robe, []);
  });

  it("places a garment by its equip position, with the folder name as it stands", () => {
    const got = viewsFromItems(new Map([[480874, item(322, "C_Gerero_Spear", ["garment"])]]), tables);
    assert.deepStrictEqual(got.robe, [
      { view: 322, sprite: "C_Gerero_Spear", item: 480874, costume: false },
    ]);
  });

  it("leaves a weapon out: a ClassNum with no equip position places nothing", () => {
    // ~2,000 items per client look like this, and their ClassNum is a third
    // numbering that means nothing in either namespace.
    const got = viewsFromItems(new Map([[1201, item(4, "커터", [])]]), tables);
    assert.deepStrictEqual([got.acc, got.robe], [[], []]);
  });

  it("yields to the sprite table on a view it already has", () => {
    const got = viewsFromItems(new Map([[9, item(1, "outro", ["top"])]]), tables);
    assert.deepStrictEqual(got.acc, []);
  });

  it("skips an item whose resource a sprite table already places", () => {
    const got = viewsFromItems(new Map([[2224, item(77, "고글", ["top"])]]), tables);
    assert.deepStrictEqual(got.acc, []);
  });

  it("prefers the costume item on a view, then the lowest id", () => {
    const got = viewsFromItems(
      new Map([
        [500, item(881, "velho", ["mid"])],
        [400, item(881, "fantasia", ["mid"], { costume: true })],
        [300, item(882, "a", ["mid"])],
        [200, item(882, "b", ["mid"])],
      ]),
      tables,
    );
    assert.deepStrictEqual(
      got.acc.map((r) => [r.view, r.item]),
      [
        [881, 400],
        [882, 200],
      ],
    );
  });

  it("has nothing to say about an origin read from the legacy .txt tables", () => {
    // Those carry no ClassNum and no equip line, so `readItemInfo` never ran.
    assert.deepStrictEqual(viewsFromItems(null, tables), { acc: [], robe: [] });
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
    // Both effect trees: the sprite-shaped aura and the `.str` folder.
    assert.deepStrictEqual(got.filter((t) => t.tier === "effect").map((t) => t.prefix), [
      "/sprite/이팩트/c_chained_bear/",
      "/texture/effect/efst_c_chained_bear/",
      "/texture/effect/efst_chained_bear/",
      "/texture/effect/c_chained_bear/",
    ]);
    // Every target carries the row's key, so a hit can be credited to a view.
    assert.deepStrictEqual(new Set(got.map((t) => t.key)), new Set(["acc:8"]));
  });

  it("calls a garment's own folder core, keeping the effect folder separate", () => {
    const got = targetsOf({ kind: "robe", view: 8, sprite: "C_S_Thanatos_Wing" });
    assert.deepStrictEqual(got.filter((t) => t.tier === "core").map((t) => t.prefix), [
      "/sprite/로브/c_s_thanatos_wing/",
    ]);
    assert.deepStrictEqual(got.filter((t) => t.tier === "effect").map((t) => t.prefix), [
      "/sprite/이팩트/c_s_thanatos_wing/",
      "/texture/effect/efst_c_s_thanatos_wing/",
      "/texture/effect/efst_s_thanatos_wing/",
      "/texture/effect/c_s_thanatos_wing/",
    ]);
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

  it("reads the English forms iRO and thRO write", () => {
    assert.deepStrictEqual(parseSlotValue("Upper"), ["top"]);
    assert.deepStrictEqual(parseSlotValue("Middle"), ["mid"]);
    assert.deepStrictEqual(parseSlotValue("Lower"), ["low"]);
    assert.deepStrictEqual(parseSlotValue("Garment"), ["garment"]);
    assert.deepStrictEqual(parseSlotValue("Upper, Middle, Lower"), ["top", "mid", "low"]);
    assert.deepStrictEqual(parseSlotValue("Upper & Middle"), ["top", "mid"]);
    assert.deepStrictEqual(parseSlotValue("Upper.Mid"), ["top", "mid"]);
    // iRO's abbreviations, and its one hyphenated value.
    assert.deepStrictEqual(parseSlotValue("Low"), ["low"]);
    assert.deepStrictEqual(parseSlotValue("mid-low"), ["mid", "low"]);
    // thRO: a Thai label, then an English value and a Thai weight field.
    assert.deepStrictEqual(parseSlotValue("Garment น้ำหนัก : 0"), ["garment"]);
  });

  it("does not take an English word that is only part of another", () => {
    // The pt branch matches substrings, which is safe for Topo/Meio/Baixo and
    // would not be for low/mid: these are the values that pay for the \b.
    assert.deepStrictEqual(parseSlotValue("Yellow"), []);
    assert.deepStrictEqual(parseSlotValue("Midgard"), []);
    assert.deepStrictEqual(parseSlotValue("Supper"), []);
  });

  it("still names no slot for the equipment positions we do not model", () => {
    for (const v of ["Weapon", "Armor", "Shoes", "Shield", "Pendant", "Earring", "Headgear"]) {
      assert.deepStrictEqual(parseSlotValue(v), [], v);
    }
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

  it("accepts the labels iRO writes, including the prefixed ones", () => {
    assert.deepStrictEqual(parseSlotsFromLines(["Position : Upper"]), ["top"]);
    assert.deepStrictEqual(parseSlotsFromLines(["Location : Garment"]), ["garment"]);
    assert.deepStrictEqual(parseSlotsFromLines(["Head Location : Lower"]), ["low"]);
    assert.deepStrictEqual(parseSlotsFromLines(["Item Position : Upper  Weight : 80"]), ["top"]);
    assert.deepStrictEqual(parseSlotsFromLines(["location : lower  weight : 5"]), ["low"]);
  });

  it("does not read iRO's list of towns as a position", () => {
    // "Locations" is where an item teleports you. It is excluded by the colon
    // the label has to be followed by, and this is the line that proves it.
    assert.deepStrictEqual(
      parseSlotsFromLines(['Locations : "Juno", "Lighthalzen", "Einbroch"']),
      [],
    );
  });

  it("accepts thRO's Thai label with its English value", () => {
    assert.deepStrictEqual(parseSlotsFromLines(["ตำแหน่ง : Lower น้ำหนัก : 10"]), ["low"]);
    assert.deepStrictEqual(parseSlotsFromLines(["ตำแหน่งที่สวมใส่ : Garment  น้ำหนัก : 0"]), [
      "garment",
    ]);
  });

  it("accepts the two older LATAM labels as well", () => {
    assert.deepStrictEqual(parseSlotsFromLines(["Equipado em : Topo"]), ["top"]);
    assert.deepStrictEqual(parseSlotsFromLines(["Equipar em : Topo, Meio e Baixo"]), [
      "top",
      "mid",
      "low",
    ]);
  });
});

describe("tableFor", () => {
  // The accessory table defines 2579 (the candy pouch) and the robe table does
  // not; both define 8, which is a surgical mask and Rudra's wings.
  const tables = { acc: new Set([8, 2579]), robe: new Set([8, 128]) };

  it("keys a costume by the table its art is in, not by the slot it equips in", () => {
    // Item 480494: "Position : Garment", art in the accessory table. Keyed by
    // the slot it became robe:2579, which no client defines and the app can
    // never join against.
    assert.strictEqual(tableFor(2579, ["garment"], tables), "acc");
    // And the mirror case, which is the app's own `viewKind` row: a bouquet
    // that equips in Baixo whose 128 is a robe.
    assert.strictEqual(tableFor(128, ["low"], tables), "robe");
  });

  it("leaves a view both tables define to the slot", () => {
    assert.strictEqual(tableFor(8, ["garment"], tables), "robe");
    assert.strictEqual(tableFor(8, ["top"], tables), "acc");
  });

  it("leaves a view neither table defines where the slot put it", () => {
    assert.strictEqual(tableFor(9999, ["garment"], tables), "robe");
    assert.strictEqual(tableFor(9999, ["top"], tables), "acc");
  });

  it("falls back to the slot alone when no tables were read", () => {
    assert.strictEqual(tableFor(2579, ["garment"], null), "robe");
    assert.strictEqual(tableFor(2579, [], null), null);
  });

  it("gives no namespace when no slot is known, tables or not", () => {
    assert.strictEqual(tableFor(2579, [], tables), null);
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

  it("takes a .str as the whole artwork, in either namespace", () => {
    // An effect costume IS its animation. Demanding a sprite dropped the
    // candidate group, which is why the plan then said no archive carried the
    // view at all: `robe:94 C_Rotating_Gears`, `acc:2420 C_Fluttering_Haze`,
    // `robe:134 C_Astra_Blessing`.
    const str = "data/texture/effect/efst_c_astra_blessing/astra.str";
    assert.strictEqual(originCanDraw("robe", [str, "data/texture/effect/x/astra.tga"]), true);
    assert.strictEqual(originCanDraw("acc", [str]), true);
    // Textures with no animation to play them are not a costume.
    assert.strictEqual(originCanDraw("robe", ["data/texture/effect/x/gear1.tga"]), false);
  });

  it("excuses an effect costume the sex pair, since its sprite is a placeholder", () => {
    assert.strictEqual(
      originCanDraw("acc", [sex("남"), "data/texture/effect/efst_c_fluttering_haze/skaura33.str"]),
      true,
    );
    assert.strictEqual(originCanDraw("acc", [sex("남"), "data/texture/effect/x/a.tga"]), false);
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

  it("takes an effect folder with a .str as drawing, whatever the namespace", () => {
    // Has to agree with `originCanDraw`: the plan fetched the `.str` tier for
    // these, and asking the tree for a sprite threw every one of them away.
    const withEffect = { ...probe, effectStr: (origin, sprite) => sprite === "C_Astra_Blessing" };
    assert.strictEqual(costumeDraws({ kind: "robe" }, "C_Astra_Blessing", withEffect), true);
    assert.strictEqual(costumeDraws({ kind: "acc" }, "C_Astra_Blessing", withEffect), true);
    assert.strictEqual(costumeDraws({ kind: "robe" }, "sem_nada", withEffect), false);
  });

  it("works against a probe that has no effect question at all", () => {
    // `treeProbe` grew `effectStr`; a caller's fake probe need not have it.
    assert.strictEqual(costumeDraws({ kind: "acc" }, "chapeu_bom", probe), true);
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

  it("credits an effect costume to a server that carries only its .str", () => {
    // `robe:94` ships no sprite anywhere: the whole visual is gearwheel.str,
    // which iRO and kRO keep in different trees under the same folder name.
    const effect = [{ kind: "robe", view: 94, sprite: "C_Rotating_Gears" }];
    const got = originsFromPaths(
      effect,
      new Map([
        ["iro", ["data\\texture\\effect\\C_Rotating_Gears\\gearwheel.str"]],
        ["kro", ["data\\sprite\\로브\\c_rotating_gears\\gearwheel.str"]],
        ["jro", ["data\\texture\\effect\\c_rotating_gears\\gear1.tga"]],
      ]),
    );
    assert.deepStrictEqual(got.get("robe:94"), ["iro", "kro"]);
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

  it("publishes a view our own instance draws, which no plan ever fetched", () => {
    // `latam=draws` is the render probe's verdict, so there is nothing on disk
    // to check and nothing to download: the art is already in our resources.
    const b = buildCatalogue({
      plan: [],
      shortlist: [
        { kind: "acc", view: "845", sprite: "_토끼리본모자", name: "Chapéu do Coelho", nameOrigin: "latam", aegis: "", latam: "draws", costume: "yes" },
      ],
      slots: [{ kind: "acc", view: "845", slots: "top" }],
      probe: { headgearPair: () => false, robeHasSprite: () => false },
      present: () => false,
    });
    assert.strictEqual(b.costumes.length, 1);
    hasFields(b.costumes[0], {
      kind: "acc",
      view: 845,
      origin: "latam",
      local: true,
      costume: true,
      slots: ["top"],
      // It planned nothing, so there is nothing on disk to count.
      files: 0,
    });
    hasFields(b.stats, { total: 1, local: 1, localPublishable: 1, skipped: { incomplete: 0, unknownToShortlist: 0 } });
  });

  it("leaves the local source out when asked, so a run can be compared", () => {
    const b = buildCatalogue({
      plan: [],
      shortlist: [{ kind: "acc", view: "845", sprite: "x", latam: "draws", costume: "yes" }],
      slots: [],
      includeLocal: false,
    });
    assert.deepStrictEqual(b.costumes, []);
    assert.strictEqual(b.stats.local, 0);
  });

  it("lets a planned row win over a local one for the same view", () => {
    // Normally disjoint — stage 4 does not plan what we already draw — but the
    // LATAM tree is a source too, and that row describes real files.
    const b = buildCatalogue({
      plan: [{ kind: "acc", view: "1", origin: "latam", path: "a.spr" }],
      shortlist: [{ kind: "acc", view: "1", sprite: "bom", name: "Chapéu Bom", latam: "draws" }],
      slots: [],
      probe,
      present: () => true,
    });
    assert.strictEqual(b.costumes.length, 1);
    assert.strictEqual(b.costumes[0].local, undefined);
    assert.strictEqual(b.costumes[0].files, 1);
  });

  it("does not publish a local row with no sprite name to key an icon by", () => {
    const b = buildCatalogue({
      plan: [],
      shortlist: [{ kind: "acc", view: "7", sprite: "", latam: "draws" }],
      slots: [],
    });
    assert.deepStrictEqual(b.costumes, []);
  });

  it("publishes the costume flag, so a consumer can tell a hat from a costume", () => {
    // `acc:11` is the Biretta: a view our client defines, drawn perfectly well,
    // and ordinary equipment. Showing it as a costume would be wrong, and the
    // flag is the only thing that says so.
    const b = buildCatalogue({
      plan: [],
      shortlist: [
        { kind: "acc", view: "11", sprite: "_비레타", name: "Solidéu", latam: "draws", costume: "no" },
        { kind: "acc", view: "12", sprite: "_x", name: "X", latam: "draws", costume: "" },
      ],
      slots: [],
    });
    assert.strictEqual(b.costumes.find((c) => c.view === 11).costume, false);
    // No client shipping a flag is not a client saying no.
    assert.strictEqual("costume" in b.costumes.find((c) => c.view === 12), false);
    assert.strictEqual(b.stats.localPublishable, 0);
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
      clientNames: new Map([
        ["bom", { names: { iro: "Good Hat", jro: "[衣装] 良い帽子" }, ids: { iro: 20073, jro: 20073 } }],
      ]),
    });
    assert.deepStrictEqual(withNames.costumes[0].names, {
      iro: "Good Hat",
      jro: "[衣装] 良い帽子",
    });
    assert.deepStrictEqual(withNames.costumes[0].ids, { iro: 20073, jro: 20073 });
    hasFields(withNames.stats, {
      withNames: 1,
      namesPerOrigin: { iro: 1, jro: 1 },
      withIds: 1,
      idsPerOrigin: { iro: 1, jro: 1 },
      idsAgree: 1,
      idsDisagree: 0,
    });
  });

  it("omits `names` rather than publishing an empty object", () => {
    // kRO Zero ships no item table at all, so "no key" is the honest statement
    // and `{}` would claim we looked and found nothing.
    for (const clientNames of [new Map(), new Map([["bom", { names: {}, ids: {} }]])]) {
      const got = buildCatalogue({
        plan,
        shortlist,
        slots,
        probe,
        present: (origin, path) => path !== "b.spr",
        clientNames,
      });
      assert.ok(!("names" in got.costumes[0]));
      assert.ok(!("ids" in got.costumes[0]));
      hasFields(got.stats, { withNames: 0, namesPerOrigin: {}, withIds: 0, idsPerOrigin: {} });
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
    assert.deepStrictEqual(got.get("두건").names, {
      iro: "Costume: Bandana",
      twro: "(服飾)方頭巾",
    });
    // The id published is the one that very name was read from.
    assert.deepStrictEqual(got.get("두건").ids, { iro: 20203, twro: 20203 });
  });

  it("falls back to the lowest id when nothing is flagged", () => {
    const got = clientNamesBySprite({ tables });
    assert.deepStrictEqual(got.get("두건").names, { iro: "Bandana", twro: "方頭巾" });
    assert.deepStrictEqual(got.get("두건").ids, { iro: 2211, twro: 2211 });
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
    assert.deepStrictEqual(got.get("c_rhythm_hairband").names, { jro: "リズム" });
    assert.deepStrictEqual(got.get("c_rhythm_hairband").ids, { jro: 1 });
    assert.strictEqual(got.get("_c_rhythm_hairband"), undefined);
  });

  it("leaves the costume markers alone", () => {
    const got = clientNamesBySprite({ tables, isCostume: (id) => id === 20203 });
    // `(服飾)` is the only thing separating this from the base item of the same
    // name, so it is published as the client writes it.
    assert.match(got.get("두건").names.twro, /^[(（]服飾/);
  });

  it("drops a client that has no name table rather than keying it empty", () => {
    const got = clientNamesBySprite({
      tables: [{ origin: "krozero", items: [[1, "두건"]], names: new Map() }, ...tables],
    });
    // No name table, so no name — but it still knows the item id.
    assert.ok(!("krozero" in got.get("두건").names));
    assert.strictEqual(got.get("두건").ids.krozero, 1);
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
    // No usable name anywhere, but the ids are still worth publishing.
    assert.strictEqual([...got.values()].filter((r) => Object.keys(r.names).length).length, 0);
    assert.deepStrictEqual(got.get("x").ids, { kro: 1 });
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
