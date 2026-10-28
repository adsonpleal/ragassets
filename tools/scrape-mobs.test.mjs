// Tests for the locale half of scrape-mobs.mjs — the mobs_en.json / mobs_es.json
// published beside the pt-BR mobs.json. Run with: node --test
//
// The divine-pride cross-check that lives in the same module is tested from
// tools/crawl-divine-pride.test.mjs, next to the crawler it checks against.
//
// Nothing here touches the network. The gateway pass is a Map of id -> name by
// the time any of this runs, which is the point of splitting localizeRecords()
// and checkLocale() out of the fetch: the contract a consumer depends on — every
// locale indexable by the pt-BR ids, same numbers, text only — is decided here,
// not in the HTTP loop.
import { test } from "node:test";
import assert from "node:assert/strict";

import { MOB_LANGS, langGateway, langOutPath, localizeRecords, checkLocale } from "./scrape-mobs.mjs";

// Three monsters shaped like the real projection, enough to tell a copied field
// from a re-derived one: a common mob, an MVP and one with unknown resistances.
const PTBR = [
  { id: 1001, aegisId: "SCORPION", name: "Escorpião", boss: false, mvp: false, hp: 136, res: 0, mres: 0 },
  { id: 1039, aegisId: "BAPHOMET", name: "Bafomé", boss: true, mvp: true, hp: 668000, res: 0, mres: 0 },
  { id: 2501, aegisId: "E_DUMMY", name: "Boneco", boss: false, mvp: false, hp: 10, res: null, mres: null },
];

test("langOutPath puts the locale's file beside the pt-BR one", () => {
  assert.equal(langOutPath("resources/raw/mobs.json", "es"), "resources/raw/mobs_es.json");
  assert.equal(langOutPath("resources/raw/mobs.json", "en"), "resources/raw/mobs_en.json");
  // --out need not end in .json; the suffix still lands before any extension.
  assert.equal(langOutPath("/tmp/mobs", "es"), "/tmp/mobs_es");
});

test("langGateway swaps the gateway's trailing language, or refuses to guess", () => {
  assert.equal(langGateway("laro-pt", "es"), "laro-es");
  assert.equal(langGateway("laro-pt", "en"), "laro-en");
  assert.equal(langGateway("rola-pt", "es"), "rola-es");
  // No trailing language means no sibling to derive. Returning "kro-es" here
  // would scrape a server that has nothing to do with the one asked for.
  assert.equal(langGateway("kro", "es"), null);
  assert.equal(langGateway("iro", "en"), null);
});

test("every locale's table is indexable by the pt-BR table's ids", () => {
  const { records } = localizeRecords(PTBR, new Map([[1001, "Escorpión"]]));
  assert.deepEqual(
    records.map((r) => r.id),
    PTBR.map((r) => r.id),
    "same ids, same order — a consumer indexes any locale by the pt-BR ids",
  );
  // Even the two the locale had no name for are still rows.
  assert.equal(records.length, PTBR.length);
});

test("a locale differs from pt-BR in its text and in nothing else", () => {
  const names = new Map([
    [1001, "Escorpión"],
    [1039, "Baphomet"],
    [2501, "Boneco"],
  ]);
  const { records } = localizeRecords(PTBR, names);
  for (const [i, r] of records.entries()) {
    const { name: _localized, ...rest } = r;
    const { name: _ptbr, ...base } = PTBR[i];
    assert.deepEqual(rest, base, `${r.id}: every field but the name is the pt-BR one`);
  }
  assert.deepEqual(
    records.map((r) => r.name),
    ["Escorpión", "Baphomet", "Boneco"],
  );
  // res/mres in particular: null is "divine-pride has no page", and a locale
  // pass must not be able to turn that into a 0.
  assert.equal(records[2].res, null);
  assert.equal(records[2].mres, null);
});

test("localizeRecords leaves the pt-BR records untouched", () => {
  const before = structuredClone(PTBR);
  localizeRecords(PTBR, new Map([[1001, "Scorpion"]]));
  assert.deepEqual(PTBR, before, "the pt-BR file is written from these same objects");
});

test("a name the locale does not have falls back to the pt-BR wording", () => {
  const { records, stats } = localizeRecords(
    PTBR,
    new Map([
      [1001, "Escorpión"], // translated
      [1039, "Bafomé"], // the locale's own word happens to match pt-BR
      [2501, null], // the gateway 404s this id
    ]),
  );
  assert.deepEqual(
    records.map((r) => r.name),
    ["Escorpión", "Bafomé", "Boneco"],
  );
  assert.deepEqual(stats, { translated: 1, same: 1, missing: 1 });
});

test("a blank name is a fallback, not a name", () => {
  // An empty cell published verbatim would leave a consumer with no label at
  // all, which is strictly worse than showing the Portuguese one.
  const { records, stats } = localizeRecords(PTBR, new Map([[1001, ""], [1039, "   "], [2501, "Dummy"]]));
  assert.deepEqual(
    records.map((r) => r.name),
    ["Escorpião", "Bafomé", "Dummy"],
  );
  assert.equal(stats.missing, 2);
});

test("checkLocale passes the locales as they actually measured", () => {
  // The real 2026-10-27 full-catalogue run, both locales.
  assert.equal(checkLocale("en", { translated: 2159, same: 571, missing: 2 }), null);
  assert.equal(checkLocale("es", { translated: 2051, same: 677, missing: 4 }), null);
});

test("checkLocale refuses a locale that is mostly fallback", () => {
  const why = checkLocale("es", { translated: 1000, same: 100, missing: 1632 });
  assert.match(why, /have no name in that locale/);
});

test("checkLocale refuses a locale that is just pt-BR again", () => {
  // Every name identical to pt-BR means the slug landed back on laro-pt, and the
  // file would ship Portuguese under an _es name — which is the one outcome a
  // consumer cannot detect.
  const why = checkLocale("es", { translated: 0, same: 2732, missing: 0 });
  assert.match(why, /differ from pt-BR/);
});

// The /raw publishing contract is one rule — "every table that carries text has
// an English and a Spanish copy beside it" — but mobs.json's locales come from
// RagnaPlace's gateways and every other table's come from the client's trees, so
// the two modules keep their own source-specific tables. Nothing downstream
// would catch them drifting: the gateway's /raw route matches any lowercase
// name, so a misspelled locale is served happily and fetched by nobody. This is
// the tie.
test("MOB_LANGS agrees with extract-grf.mjs's RAW_LANGS", async () => {
  const { RAW_LANGS } = await import("../extract-grf.mjs");
  assert.deepEqual(
    MOB_LANGS,
    Object.keys(RAW_LANGS).filter((l) => RAW_LANGS[l].tree),
    "the same locales are published beside pt-BR in both modules",
  );
  for (const lang of MOB_LANGS) {
    assert.equal(`_${lang}`, RAW_LANGS[lang].suffix, `${lang}: same file suffix in both modules`);
  }
});
