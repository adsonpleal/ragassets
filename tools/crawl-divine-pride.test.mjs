// Tests for the divine-pride crawler's parser and for the RagnaPlace ↔ divine-pride
// cross-check in scrape-mobs.mjs. Run with: node --test
//
// The page fixtures below are **written here, not scraped**. Checking in copies of
// divine-pride's own HTML would redistribute their markup under this repo's MIT
// licence, so `page()` and `statBlock()` emit the minimum structure the parser
// keys on — the element ids, the section headings and the cell shapes that make
// up the contract between their page and this parser — and nothing else. The
// numbers in them are game facts, verified by hand against the live site.
//
// The cost of synthesising is real and worth naming: these fixtures can only
// encode what we *believe* the markup is, so they cannot catch divine-pride
// changing it. That is what the DP_LIVE tests at the bottom are for. Run them
// before trusting a crawl after any long gap:
//
//     DP_LIVE=1 node --test tools/crawl-divine-pride.test.mjs
//
// They fetch four real pages and assert this file's assumptions still hold —
// including that the LATAM block is still neither first nor identical to the
// others. Keep them opt-in: they hit a third party and need the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { parseMonsterPage, noStatsReason, fetchPage, ParseError } from "./crawl-divine-pride.mjs";
import { checkAgainstDp, canonRace, mergeDp, CROSS_CHECKED } from "./scrape-mobs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixture builders — the parsing contract, expressed as markup
// ---------------------------------------------------------------------------

// A stat cell reads "<value> <label>". Whitespace between them is deliberate and
// generous: the real page indents heavily, and the parser must not depend on it.
const cell = (value, label) =>
  `<td class="right">\n      <span style="font-weight: bold;">${value}</span>\n      ${label}\n    </td>`;

// Res/Mres render differently from every other stat — the label sits in its own
// <span> and a derived percentage follows, which must not be read as the value.
const resCell = (value, label, pct) =>
  `<td class="right">\n      <span style="font-weight: bold;">${value}</span><span> ${label}</span>\n` +
  `      <span> (${pct}%)</span>\n    </td>`;

const row = (...tds) => `  <tr>\n    ${tds.join("\n    ")}\n  </tr>`;
const heading = (title) => `  <tr>\n    <th colspan="3">${title}</th>\n  </tr>`;
const blank = "<td></td>";

// Values verified by hand on divine-pride for 21360 Schulang, 2026-08-14.
const SCHULANG = {
  id: 21360, level: 224, race: "Demon", size: "Medium", property: "Ghost", propertyLevel: 2,
  str: 257, agi: 178, vit: 146, int: 145, dex: 170, luk: 199,
  hp: "2,000,000,000", def: 217, mdef: 70, range: 3,
  attack: "7,076 - 10,373", matk: "1,106 - 1,737", hit: 602, flee: 564,
  res: 205, resPct: "-27.11", mres: 368, mresPct: "-38.33",
};

// One `<div class="alternatestats" id="alternatestats_<source>">` — the unit the
// parser selects between. `omit` drops a row so a degraded page can be modelled.
function statBlock(source, m, { omit = [] } = {}) {
  const has = (k) => !omit.includes(k);
  const element = m.propertyLevel == null ? m.property : `${m.property} ${m.propertyLevel}`;
  const rows = [
    heading("Basic Info"),
    row(`<td><strong>${m.id}</strong></td>`, `<td>\n      Lv.\n      <strong>${m.level}</strong>\n    </td>`, blank),
    has("identity")
      ? row(
          `<td>\n      <span>${m.race}</span>\n    </td>`,
          `<td>\n      <span>${m.size}</span>\n    </td>`,
          `<td class="property_telekinesis">\n      <span>${element}</span>\n    </td>`,
        )
      : null,
    heading("Primary stats"),
    row(cell(m.str, "STR"), cell(m.agi, "AGI"), cell(m.vit, "VIT")),
    row(cell(m.int, "INT"), cell(m.dex, "DEX"), cell(m.luk, "LUK")),
    heading("Secondary stats"),
    has("hp") ? row(cell(m.hp, "Health"), cell(m.def, "Def"), cell(m.mdef, "MDef")) : null,
    row(cell(m.range, "Range"), cell(m.attack, "Attack"), cell(m.matk, "MATK")),
    row(blank, cell(m.hit, "Req. Hit"), cell(m.flee, "Req. Flee")),
    has("res")
      ? row(blank, resCell(m.res, "Res", m.resPct), resCell(m.mres, "Mres", m.mresPct))
      : null,
    // Present on the real page and deliberately unhandled — the parser must skip
    // labels it doesn't know rather than choke on them.
    heading("Misc"),
    `  <tr>\n    <td colspan="3" class="right">\n      <span style="font-weight: bold;">6.67</span>\n      Speed (cells/sec)\n    </td>\n  </tr>`,
  ].filter(Boolean);

  // The nesting is load-bearing: the parser balances <div> tags to find the end
  // of a block, because the blocks are siblings and "the next </table>" would run
  // straight past an empty one into the following server's numbers.
  return (
    `<div class="alternatestats" id="alternatestats_${source}"${source === "default" ? "" : ' style="display:none;"'}>\n` +
    `  <div id="lvStats" class="listview">\n    <div class="listview-scroller-horizontal">\n` +
    `      <div class="listview-scroller-vertical">\n` +
    `<table class='table table-bordered table-striped table-full table-condensed listview-mode-default'>\n` +
    `<tbody>\n${rows.join("\n")}\n</tbody>\n</table>\n` +
    `      </div>\n    </div>\n  </div>\n</div>`
  );
}

const page = (title, body) =>
  `<html>\n<head>\n<title>\n        Divine Pride - Monster - ${title}\n    </title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

// The real ordering: LATAM is last, behind up to four other servers.
const monsterPage = (title, m, opts) =>
  page(title, [
    statBlock("iRO_17_1", { ...m, hp: "60", attack: "13 - 16" }),
    statBlock("kRO_EP_20", m),
    statBlock("default", m, opts),
  ].join("\n"));

const PAGE_21360 = monsterPage("슐랑", SCHULANG);

// divine-pride answers an unknown id with HTTP 200 and this, not a 404.
const PAGE_NOT_FOUND = page(
  "Monster not found",
  `<div class="widget-content">\n  <legend class="entry-title">Monster not found</legend>\n` +
    `  <p>Sorry, but you are looking for something that isn't here.</p>\n</div>`,
);

// A monster the site lists but has no numbers for: every cell is "?" and the
// page carries no per-server blocks at all, since there are no variants to offer.
const PAGE_NO_DATA = page(
  "",
  `<div class="widget-content">\n  <legend class="entry-title">C4_SASQUATCH</legend>\n` +
    `<table>\n<tbody>\n${heading("Basic Info")}\n` +
    row(`<td><strong>25239</strong></td>`, `<td>\n      Lv.\n      <strong></strong>\n    </td>`, blank) +
    `\n${row(
      `<td><abbr title="We don&#39;t have this yet :(">?</abbr></td>`,
      `<td><abbr title="We don&#39;t have this yet :(">?</abbr></td>`,
      `<td class="property_nothing"><abbr title="We don&#39;t have this yet :(">?</abbr></td>`,
    )}\n</tbody>\n</table>\n</div>`,
);

const blockIds = (html) => [...html.matchAll(/id="(alternatestats[^"]*)"/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// The fixtures themselves
// ---------------------------------------------------------------------------

// If the builder ever stops producing a decoy ahead of the LATAM block, every
// ordering test below would still pass while testing nothing.
test("the built page puts alternatestats_default last, behind decoys", () => {
  const ids = blockIds(PAGE_21360);
  assert.deepEqual(ids, ["alternatestats_iRO_17_1", "alternatestats_kRO_EP_20", "alternatestats_default"]);
  assert.notEqual(ids[0], "alternatestats_default");
});

// ---------------------------------------------------------------------------
// Picking the right stat block
// ---------------------------------------------------------------------------

test("the LATAM block is selected by id, not by position", () => {
  const m = parseMonsterPage(PAGE_21360, 21360);
  assert.equal(m.hp, 2_000_000_000);
  assert.equal(m.attackMin, 7076);

  // Same page, same parser, block renamed: the first block holds other numbers.
  const iroAsDefault = PAGE_21360
    .replaceAll('id="alternatestats_default"', 'id="alternatestats_x"')
    .replaceAll('id="alternatestats_iRO_17_1"', 'id="alternatestats_default"');
  const iro = parseMonsterPage(iroAsDefault, 21360);
  assert.equal(iro.hp, 60);
  assert.equal(iro.attackMin, 13);
});

test("a page without the LATAM block is an error, never a fallback to another server", () => {
  const noDefault = PAGE_21360.replaceAll('id="alternatestats_default"', 'id="alternatestats_x"');
  assert.throws(() => parseMonsterPage(noDefault, 21360), (err) => {
    assert.ok(err instanceof ParseError);
    // The message has to name what it *did* find, or the failure is unactionable.
    assert.match(err.message, /alternatestats_iRO_17_1/);
    assert.match(err.message, /Refusing to fall back/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Reading the block
// ---------------------------------------------------------------------------

test("21360 Schulang parses to the hand-verified LATAM values", () => {
  const m = parseMonsterPage(PAGE_21360, 21360);
  assert.equal(m.res, 205);
  assert.equal(m.mres, 368);
  assert.equal(m.def, 217);
  assert.equal(m.mdef, 70);
  assert.equal(m.level, 224);
  assert.equal(m.race, "Demon");
  assert.equal(m.size, "Medium");
  assert.equal(m.property, "Ghost");
  assert.equal(m.propertyLevel, 2);
  assert.equal(m.hp, 2_000_000_000);
});

// The control from the brief: 21361 Twisted God Freyja's four secondary stats
// match, to the number, the record an older divine-pride scraper produced before
// the RagnaPlace migration dropped it. Verified against the live page 2026-08-14.
test("21361 Twisted God Freyja parses to the values the old scraper had", () => {
  const freyja = { ...SCHULANG, id: 21361, race: "Angel", property: "Holy",
    def: 314, mdef: 520, res: 249, mres: 499 };
  const m = parseMonsterPage(monsterPage("Twisted God", freyja), 21361);
  assert.equal(m.res, 249);
  assert.equal(m.mres, 499);
  assert.equal(m.def, 314);
  assert.equal(m.mdef, 520);
  assert.equal(m.level, 224);
  assert.equal(m.race, "Angel");
});

// The percentage rendered beside each resistance must not be read as the value
// or bleed into the label.
test("the derived percentage beside Res/Mres is discarded", () => {
  const m = parseMonsterPage(PAGE_21360, 21360);
  assert.equal(m.res, 205);
  assert.equal(m.mres, 368);
  assert.equal(typeof m.res, "number");
});

test("thousands separators and attack ranges are parsed, not truncated", () => {
  const m = parseMonsterPage(PAGE_21360, 21360);
  assert.equal(m.hp, 2_000_000_000); // "2,000,000,000"
  assert.equal(m.attackMin, 7076); // "7,076 - 10,373"
  assert.equal(m.attackMax, 10_373);
  assert.equal(m.matkMin, 1106);
  assert.equal(m.matkMax, 1737);
});

// res 0 is the correct answer for any pre-4th-job monster, and the bug this
// pipeline exists to fix is 0 and "unknown" being the same value.
test("a genuine zero resistance parses as 0, not null", () => {
  const poring = { ...SCHULANG, id: 1002, level: 1, hp: "55", def: 2, mdef: 5,
    res: 0, resPct: "0.00", mres: 0, mresPct: "0.00" };
  const m = parseMonsterPage(monsterPage("Poring", poring), 1002);
  assert.equal(m.res, 0);
  assert.equal(m.mres, 0);
  assert.notEqual(m.res, null);
});

test("an unhandled Misc label is skipped rather than breaking the parse", () => {
  assert.match(PAGE_21360, /Speed \(cells\/sec\)/, "the fixture should still carry an unhandled label");
  assert.equal(parseMonsterPage(PAGE_21360, 21360).res, 205);
});

// ---------------------------------------------------------------------------
// Absent vs broken
// ---------------------------------------------------------------------------

test("an unknown id yields null — divine-pride answers 200, not 404", () => {
  assert.equal(parseMonsterPage(PAGE_NOT_FOUND, 29999), null);
  assert.equal(noStatsReason(PAGE_NOT_FOUND), "no-page");
});

// The state that stopped the first full crawl, at 25239 C4_SASQUATCH.
test("a monster divine-pride has no numbers for yields null, not an error", () => {
  assert.equal(parseMonsterPage(PAGE_NO_DATA, 25239), null);
  assert.equal(noStatsReason(PAGE_NO_DATA), "no-data");
  assert.equal(blockIds(PAGE_NO_DATA).length, 0, "such a page carries no stat blocks at all");
});

// Ten monsters get a real block full of zeroes instead. Six of them have good
// RagnaPlace records, so trusting the zeroes would publish "no resistance" off a
// blank page.
test("a blank stat block is no data either — level 0 with 0 HP", () => {
  const empty = { ...SCHULANG, id: 2504, level: 0, hp: "0", def: 0, mdef: 0,
    str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0, propertyLevel: null,
    property: "Neutral", res: 0, resPct: "0.00", mres: 0, mresPct: "0.00" };
  assert.equal(parseMonsterPage(monsterPage("Kukre", empty), 2504), null);

  // 0 HP alone must NOT trigger it: 1210 and the twelve Agni/Varuna/Vayu/Chandra
  // spirits carry 0 HP with a real level, and RagnaPlace independently agrees.
  const spirit = { ...SCHULANG, id: 2114, level: 100, hp: "0" };
  const parsed = parseMonsterPage(monsterPage("Agni", spirit), 2114);
  assert.notEqual(parsed, null, "0 HP with a real level is a real record");
  assert.equal(parsed.hp, 0);
});

test("a page that is neither a monster nor a known no-data page throws", () => {
  assert.throws(
    () => parseMonsterPage("<html><body>please log in</body></html>", 1002),
    (err) => err instanceof ParseError && /layout changed|login/.test(err.message),
  );
});

// A layout that dropped the resistances would otherwise publish null for a
// monster whose page we fetched perfectly well — indistinguishable, downstream,
// from a monster divine-pride has never heard of.
test("a stat block with no Res row throws instead of yielding null resistances", () => {
  assert.throws(
    () => parseMonsterPage(monsterPage("슐랑", SCHULANG, { omit: ["res"] }), 21360),
    (err) => err instanceof ParseError && /carries no res, mres/.test(err.message),
  );
});

// The cross-check skips any field either side leaves null, so a parser that
// quietly returned nulls would also switch off the net meant to catch it.
test("a stat block missing a cross-checked field throws rather than nulling it", () => {
  assert.throws(
    () => parseMonsterPage(monsterPage("슐랑", SCHULANG, { omit: ["hp"] }), 21360),
    (err) => err instanceof ParseError && /carries no hp\b/.test(err.message),
  );
  assert.throws(
    () => parseMonsterPage(monsterPage("슐랑", SCHULANG, { omit: ["identity"] }), 21360),
    (err) => err instanceof ParseError && /carries no .*\brace\b/.test(err.message),
  );
});

// 3130 GM Cultist really does render a bare "Neutral" with no level, alongside
// level 75 and 4,835 HP — so this one absence must not be fatal.
test("an element with no level is allowed, unlike the other cross-checked fields", () => {
  const cultist = { ...SCHULANG, id: 3130, level: 75, hp: "4,835", property: "Neutral", propertyLevel: null };
  const m = parseMonsterPage(monsterPage("GM Cultist", cultist), 3130);
  assert.equal(m.property, "Neutral");
  assert.equal(m.propertyLevel, null);
  assert.equal(m.level, 75);
});

test("a page whose own id differs from the one requested throws", () => {
  assert.throws(
    () => parseMonsterPage(PAGE_21360, 21361),
    (err) => err instanceof ParseError && /the page's own id is 21360/.test(err.message),
  );
});

// divine-pride serves the Korean name; mobs.json must keep RagnaPlace's pt-BR
// one. The field is parsed for debugging, and this pins down why it isn't used.
test("the divine-pride name is Korean and therefore not the published name", () => {
  assert.equal(parseMonsterPage(PAGE_21360, 21360).name, "슐랑");
});

// ---------------------------------------------------------------------------
// Cross-validation
// ---------------------------------------------------------------------------

const noLedger = { path: "(none)", accepted: new Map(), untrustedResistances: new Set() };
// A RagnaPlace record and its divine-pride block that agree on everything.
const rp = () => ({
  id: 21360, aegisId: "EP18_MD_SCHULANG_L", name: "Schulang", level: 224, hp: 2_000_000_000,
  def: 217, mdef: 70, attack: 7076, str: 257, agi: 178, vit: 146, int: 145, dex: 170, luk: 199,
  race: "Demon", size: "Medium", property: "Ghost", propertyLevel: 2, res: null, mres: null,
});
const dp = () => parseMonsterPage(PAGE_21360, 21360);

test("matching records produce no findings", () => {
  assert.deepEqual(checkAgainstDp(rp(), dp(), noLedger), []);
});

test("a disagreement is reported with both values", () => {
  const [p, ...rest] = checkAgainstDp({ ...rp(), mdef: 71 }, dp(), noLedger);
  assert.equal(rest.length, 0);
  assert.equal(p.field, "mdef");
  assert.equal(p.ragnaplace, 71);
  assert.equal(p.divinePride, 70);
  assert.equal(p.id, 21360);
});

// Baphomet is 2520 on RagnaPlace and "2,721 - 3,981" on divine-pride: the first
// is the database's raw attack, the second the computed renewal range. Comparing
// them fires on ~95% of the catalogue and would bury every real finding.
test("attack is not cross-checked — the two sources publish different quantities", () => {
  assert.ok(!CROSS_CHECKED.some(([f]) => f === "attack"));
  assert.deepEqual(checkAgainstDp({ ...rp(), attack: 2520 }, dp(), noLedger), []);
});

test("a null on either side is not a disagreement", () => {
  assert.deepEqual(checkAgainstDp({ ...rp(), race: null }, dp(), noLedger), []);
  assert.deepEqual(checkAgainstDp(rp(), { ...dp(), mdef: null }, noLedger), []);
});

// Vocabulary, not data: kRO renamed Demi-Human to Human, and laro-pt leaks the
// untranslated pt-BR label for Formless on 449 rows.
test("race vocabulary differences are normalised away", () => {
  assert.equal(canonRace("fantasma"), canonRace("Formless"));
  assert.equal(canonRace("Demihuman"), canonRace("Human"));
  assert.equal(canonRace("Demi-Human"), canonRace("Human"));
  assert.notEqual(canonRace("Demon"), canonRace("Undead"));

  assert.deepEqual(checkAgainstDp({ ...rp(), race: "fantasma" }, { ...dp(), race: "Formless" }, noLedger), []);
  assert.deepEqual(checkAgainstDp({ ...rp(), race: "Demihuman" }, { ...dp(), race: "Human" }, noLedger), []);
  // …but a real race difference still lands.
  assert.equal(checkAgainstDp({ ...rp(), race: "Angel" }, dp(), noLedger).length, 1);
});

// ---------------------------------------------------------------------------
// The acknowledgement ledger
// ---------------------------------------------------------------------------

const ledgerWith = (entry) => ({
  path: "(test)",
  accepted: new Map([[`${entry.id}:${entry.field}`, entry]]),
  untrustedResistances: new Set(entry.resistances === "unknown" ? [entry.id] : []),
});

test("an acknowledged disagreement is suppressed and keeps RagnaPlace's value", () => {
  const record = { ...rp(), mdef: 71 };
  const ledger = ledgerWith({ id: 21360, field: "mdef", ragnaplace: 71, divinePride: 70, prefer: "ragnaplace" });
  assert.deepEqual(checkAgainstDp(record, dp(), ledger), []);
  assert.equal(record.mdef, 71);
});

test("prefer: divine-pride rewrites that one field", () => {
  const record = { ...rp(), mdef: 71 };
  const ledger = ledgerWith({ id: 21360, field: "mdef", ragnaplace: 71, divinePride: 70, prefer: "divine-pride" });
  assert.deepEqual(checkAgainstDp(record, dp(), ledger), []);
  assert.equal(record.mdef, 70);
  assert.equal(record.def, 217, "only the acknowledged field may be rewritten");
});

// An acknowledgement covers one specific known difference. If either source
// moves, the human who signed it off has to look again.
test("an acknowledgement goes stale when either source's value changes", () => {
  const ledger = ledgerWith({ id: 21360, field: "mdef", ragnaplace: 71, divinePride: 70, prefer: "ragnaplace" });

  const rpMoved = checkAgainstDp({ ...rp(), mdef: 99 }, dp(), ledger);
  assert.equal(rpMoved.length, 1);
  assert.equal(rpMoved[0].stale, true, "must be flagged as a ledger entry that no longer matches");

  const dpMoved = checkAgainstDp({ ...rp(), mdef: 71 }, { ...dp(), mdef: 69 }, ledger);
  assert.equal(dpMoved.length, 1);
  assert.equal(dpMoved[0].stale, true);
});

test("an acknowledgement is scoped to its own monster and field", () => {
  const ledger = ledgerWith({ id: 21360, field: "mdef", ragnaplace: 71, divinePride: 70, prefer: "ragnaplace" });
  // same values, different field
  assert.equal(checkAgainstDp({ ...rp(), def: 71, mdef: 70 }, { ...dp(), def: 70 }, ledger).length, 1);
  // same field, different monster
  assert.equal(checkAgainstDp({ ...rp(), id: 21361, mdef: 71 }, { ...dp(), id: 21361 }, ledger).length, 1);
});

// ---------------------------------------------------------------------------
// Merging res/mres
// ---------------------------------------------------------------------------

const dpFile = (monsters, missing = []) => ({
  doc: { block: "alternatestats_default" },
  byId: new Map(monsters.map((m) => [m.id, m])),
  missing: new Set(missing),
});

test("res/mres are taken from divine-pride, including a real 0", () => {
  const poringDp = { ...dp(), id: 1002, level: 1, hp: 55, def: 2, mdef: 5, res: 0, mres: 0 };
  const poringRp = { ...rp(), id: 1002, level: 1, hp: 55, def: 2, mdef: 5 };
  const records = [rp(), poringRp];
  const stats = mergeDp(records, dpFile([dp(), poringDp]));
  assert.equal(records[0].res, 205);
  assert.equal(records[0].mres, 368);
  assert.equal(records[1].res, 0, "a real zero must survive as 0");
  assert.equal(records[1].mres, 0);
  assert.equal(stats.merged, 2);
});

// The distinction the whole pipeline exists for.
test("a monster divine-pride has no data for publishes null, never 0", () => {
  const records = [{ ...rp(), id: 25239, res: undefined, mres: undefined }];
  const stats = mergeDp(records, dpFile([], [25239]));
  assert.equal(records[0].res, null);
  assert.equal(records[0].mres, null);
  assert.notEqual(records[0].res, 0);
  assert.equal(stats.absent, 1);
  assert.equal(stats.merged, 0);
});

// A ledger entry may declare divine-pride's record for a monster to be about
// something else (a dummy row, another episode). Its 0 is then not a measurement.
test('resistances: "unknown" in the ledger publishes null instead of the scraped value', () => {
  const doc = JSON.parse(readFileSync(resolve(HERE, "dp-divergences.json"), "utf8"));
  const flagged = doc.accepted.filter((e) => e.resistances === "unknown").map((e) => e.id);
  assert.ok(flagged.length, "the checked-in ledger should still exercise this path");

  const id = flagged[0];
  const entry = doc.accepted.find((e) => e.id === id && e.resistances === "unknown");
  const records = [{ ...rp(), id, [entry.field]: entry.ragnaplace }];
  const ledger = { ...dpFile([{ ...dp(), id, [entry.field]: entry.divinePride, res: 0, mres: 0 }]) };
  // divine-pride reports 0 for these; the point is that 0 must not be published.
  const stats = mergeDp(records, ledger);
  assert.equal(records[0].res, null, `${id} should publish an unknown resistance, not divine-pride's 0`);
  assert.equal(records[0].mres, null);
  assert.equal(stats.untrusted, 1);
  assert.equal(stats.merged, 0);
});

// ---------------------------------------------------------------------------
// The checked-in ledger
// ---------------------------------------------------------------------------

test("tools/dp-divergences.json is well formed and every entry is reviewable", () => {
  const doc = JSON.parse(readFileSync(resolve(HERE, "dp-divergences.json"), "utf8"));
  const fields = new Set(CROSS_CHECKED.map(([f]) => f));
  const seen = new Set();
  for (const e of doc.accepted) {
    assert.equal(typeof e.id, "number", JSON.stringify(e));
    assert.ok(fields.has(e.field), `${e.field} is not a cross-checked field`);
    assert.ok(["ragnaplace", "divine-pride"].includes(e.prefer), `${e.id}: bad prefer ${e.prefer}`);
    assert.match(e.reviewed || "", /^\d{4}-\d{2}-\d{2}$/, `${e.id}: needs a review date`);
    assert.ok(e.why && e.why.length > 40, `${e.id}: needs a real explanation, not a placeholder`);
    assert.notEqual(String(e.ragnaplace), String(e.divinePride), `${e.id}: the two values are equal`);
    if ("resistances" in e) {
      assert.equal(e.resistances, "unknown", `${e.id}: the only value this key takes is "unknown"`);
    }
    const key = `${e.id}:${e.field}`;
    assert.ok(!seen.has(key), `duplicate entry for ${key}`);
    seen.add(key);
  }
});

// ---------------------------------------------------------------------------
// Live checks — opt in with DP_LIVE=1
//
// Everything above runs against markup this file makes up, which cannot notice
// divine-pride changing theirs. These four requests are what actually holds the
// synthetic fixtures honest, so run them before trusting a crawl after a gap.
// They are opt-in because they need the network and hit a third party.
// ---------------------------------------------------------------------------

const live = { skip: process.env.DP_LIVE ? false : "set DP_LIVE=1 to run (fetches divine-pride.net)" };
const politely = (ms = 1200) => new Promise((r) => setTimeout(r, ms));

test("live: the LATAM block is still last, and still differs from the first", live, async () => {
  const html = await fetchPage(1002, null);
  const ids = [...html.matchAll(/id="(alternatestats[^"]*)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 1, `expected several stat blocks, got ${ids.join(", ") || "none"}`);
  assert.notEqual(ids[0], "alternatestats_default", "the trap this parser guards against has changed shape");
  assert.ok(ids.includes("alternatestats_default"));

  const latam = parseMonsterPage(html, 1002);
  const first = parseMonsterPage(
    html.replaceAll('id="alternatestats_default"', 'id="alternatestats_x"').replaceAll(`id="${ids[0]}"`, 'id="alternatestats_default"'),
    1002,
  );
  assert.notDeepEqual(
    [latam.hp, latam.attackMin], [first.hp, first.attackMin],
    "the blocks now agree — either the site changed or the fixtures need revisiting",
  );
  await politely();
});

test("live: 21360 Schulang still reports the values this file assumes", live, async () => {
  const m = parseMonsterPage(await fetchPage(21360, null), 21360);
  assert.equal(m.res, SCHULANG.res);
  assert.equal(m.mres, SCHULANG.mres);
  assert.equal(m.def, SCHULANG.def);
  assert.equal(m.mdef, SCHULANG.mdef);
  assert.equal(m.level, SCHULANG.level);
  assert.equal(m.race, SCHULANG.race);
  assert.equal(m.property, SCHULANG.property);
  assert.equal(m.propertyLevel, SCHULANG.propertyLevel);
  await politely();
});

test("live: 21361 Twisted God Freyja still matches the pre-migration record", live, async () => {
  const m = parseMonsterPage(await fetchPage(21361, null), 21361);
  assert.deepEqual([m.res, m.mres, m.def, m.mdef], [249, 499, 314, 520]);
  await politely();
});

test("live: an unknown id still answers 200 with a not-found page", live, async () => {
  const html = await fetchPage(29999, null);
  assert.ok(html != null, "a 404 now — the absent-vs-broken test needs rewriting");
  assert.equal(noStatsReason(html), "no-page");
  assert.equal(parseMonsterPage(html, 29999), null);
});
