#!/usr/bin/env node
// Crawl divine-pride.net for the monster stats the RagnaPlace API does not expose.
//
//   node tools/crawl-divine-pride.mjs                       # every mob in mobs.json
//   node tools/crawl-divine-pride.mjs --only 21360,21361    # spot check
//
// Writes _scratch/dp-stats.json, which tools/scrape-mobs.mjs then merges into
// resources/raw/mobs.json. This is the *only* source for `res`/`mres`: RagnaPlace
// has no such field, and a monster whose resistances are unknown must publish
// null rather than 0, because 0 is a real and common value.
//
// ## The block that matters
//
// A divine-pride monster page renders one stat table per server/episode, wrapped
// in `<div class="alternatestats" id="alternatestats_<SOURCE>">`. LATAM is
// `alternatestats_default`. It is *not* the first such block in the DOM — on a
// classic mob the order is iRO_17_1, kRO_EP_20, twRO_16_1, vnRO_16_1, default —
// so this crawler selects it by id and treats its absence as a hard parse error.
// Taking the first block instead silently yields another server's numbers, which
// are frequently different and always plausible.
//
// ## Politeness
//
// A full catalogue is ~2700 pages of ~250 KB each off someone else's server, so
// requests are serialised with a delay between them and every parsed record is
// cached to _scratch/dp-cache.jsonl. Re-runs inside the TTL cost zero requests;
// an interrupted run resumes from the cache.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://www.divine-pride.net/database/monster";
// The LATAM stat block. Every other id under `alternatestats_*` is another server.
const BLOCK_ID = "alternatestats_default";
const DEFAULT_DELAY_MS = 1200;
const DEFAULT_TTL_DAYS = 30;
const MAX_ATTEMPTS = 4;
const UA =
  "ragassets-crawler/1.0 (+https://github.com/adsonpleal/ragassets; monster res/mres for a LATAM damage calculator)";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mobs") out.mobs = argv[++i];
    else if (a === "--ids") out.ids = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--cache") out.cache = argv[++i];
    else if (a === "--cookies") out.cookies = argv[++i];
    else if (a === "--only") out.only = argv[++i];
    else if (a === "--delay") out.delay = Number(argv[++i]);
    else if (a === "--ttl") out.ttl = Number(argv[++i]);
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--fresh") out.fresh = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else {
      console.error(`unknown argument: ${a}`);
      out.bad = true;
    }
  }
  return out;
}

function usage() {
  console.error(
    [
      "Crawl divine-pride.net for the monster stats RagnaPlace omits (res/mres).",
      "",
      "  node tools/crawl-divine-pride.mjs [--mobs resources/raw/mobs.json]",
      "                                    [--out _scratch/dp-stats.json]",
      "                                    [--only 21360,21361] [--limit N]",
      "                                    [--delay 1200] [--ttl 30] [--fresh]",
      "",
      "  --mobs    id universe: the mobs.json RagnaPlace produced (default)",
      "  --ids     id universe: a mobids.json from `extract-grf.mjs --mobids` instead",
      "  --only    crawl just these ids (comma separated) — for spot checks",
      "  --limit   stop after N fetches — for sampling before a full crawl",
      "  --delay   ms between requests (default 1200)",
      "  --ttl     reuse cached records younger than this many days (default 30)",
      "  --fresh   ignore the cache entirely and refetch",
      "  --cookies path to a divine-pride session cookie jar (default .dp-cookies.json",
      "            if present; only needed if the site starts gating the LATAM block)",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// HTML helpers. The repo has no dependencies and this needs one table out of one
// known div, so a real parser would be a lot of weight for very little.
// ---------------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (Object.hasOwn(ENTITIES, e)) return ENTITIES[e];
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

function text(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// Slice out the whole element carrying id="<id>", by balancing <div> tags from
// its opening tag. Bounding the search by the element matters: the stat blocks
// are siblings, so "the next </table>" would happily run past the end of an
// empty block and into the following server's numbers.
function sliceElementById(html, id) {
  const attr = html.indexOf(`id="${id}"`);
  if (attr < 0) return null;
  const start = html.lastIndexOf("<div", attr);
  if (start < 0) return null;
  const tag = /<(\/?)div\b[^>]*?(\/?)>/gi;
  tag.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = tag.exec(html))) {
    if (m[1] === "/") {
      if (--depth === 0) return html.slice(start, m.index + m[0].length);
    } else if (m[2] !== "/") {
      depth++;
    }
  }
  return null;
}

function num(s) {
  if (s == null) return null;
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// A stat cell reads "<value> <label>", optionally with a percentage in
// parentheses ("205 Res (-27.11%)") and optionally as a range ("7,076 - 10,373
// Attack"). Returns [label, min, max].
function readStatCell(td) {
  const t = text(td);
  if (!t) return null;
  const m = /^([\d,]+(?:\.\d+)?)(?:\s*-\s*([\d,]+(?:\.\d+)?))?\s+(.+?)\s*(?:\(\s*[-+]?[\d.,]+%\s*\))?$/.exec(t);
  if (!m) return null;
  return [m[3].trim(), num(m[1]), m[2] == null ? num(m[1]) : num(m[2])];
}

function cells(rowHtml) {
  return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

export class ParseError extends Error {}

// divine-pride's own marker for "this row exists but we have no value for it".
// A monster it knows of but has no data for renders its whole stat table out of
// these and ships no per-server blocks at all, since there are no variants to
// offer. That is a genuine *unknown* — res/mres null — not a broken page.
const NO_DATA = /We don(?:&#0*39;|&apos;|')t have this yet/i;

// The "no such id" page. divine-pride answers those with HTTP 200, so the marker
// is the only way to tell absent from broken. Anchored on the page's own heading
// rather than a bare substring match, which would also hit the <title>/<meta> of
// a real monster whose name happened to contain the phrase.
const NOT_FOUND = /<legend[^>]*class="entry-title"[^>]*>\s*Monster not found\s*<\/legend>/i;

// Why a page yielded no stats, for the crawler's own reporting. Both outcomes
// publish res/mres null; the difference is only whether divine-pride has heard
// of the monster at all.
export function noStatsReason(html) {
  if (NOT_FOUND.test(html)) return "no-page";
  if (NO_DATA.test(html)) return "no-data";
  return null;
}

// Fields a parsed block must carry: the two this crawler exists for, plus every
// field scrape-mobs.mjs cross-checks against RagnaPlace. See the check at the
// bottom of parseMonsterPage() for why a null in any of them is a hard stop.
//
// `propertyLevel` is deliberately absent even though it *is* cross-checked: some
// real records carry an element with no level at all (3130 GM Cultist renders a
// bare "Neutral" under `property_nothing`, with level 75 and 4,835 HP around it),
// so demanding one would reject good data. A null there simply skips that one
// comparison, which is honest — divine-pride states no value.
// attack/matk/range/hit/flee are informational and stay optional.
const REQUIRED = [
  "res", "mres",
  "level", "hp", "def", "mdef",
  "str", "agi", "vit", "int", "dex", "luk",
  "race", "size", "property",
];

// Some ids get a stat block that is entirely blank rather than the "?" page
// above: level 0, 0 HP, every stat 0, and an element with no level. Ten monsters
// render this way, and six of them (2504-2509, the Byalan mobs) have perfectly
// good RagnaPlace records — so taking the zeros at face value would publish
// `res: 0` for them, asserting "no resistance" on the strength of a blank page.
// That is precisely the 0-versus-unknown confusion this second source exists to
// end, so a blank block counts as no data.
//
// 0 HP alone is not the test: 1210 and the twelve Agni/Varuna/Vayu/Chandra
// spirits carry 0 HP with a real level, and RagnaPlace independently agrees.
// Level 0 with 0 HP is what no real monster has.
export function isEmptyBlock(s) {
  return s != null && s.level === 0 && s.hp === 0;
}

// Returns the parsed LATAM stat block, or null when divine-pride has no stats
// for the monster. Throws ParseError when the page exists but doesn't look like
// a monster page any more — a layout change must stop the run, not quietly
// produce a catalogue full of nulls that would then be published as "unknown".
export function parseMonsterPage(html, id) {
  const block = sliceElementById(html, BLOCK_ID);
  if (!block) {
    if (noStatsReason(html)) return null;
    const others = [...html.matchAll(/id="(alternatestats[^"]*)"/g)].map((m) => m[1]);
    throw new ParseError(
      others.length
        ? `monster ${id}: no #${BLOCK_ID} block; the page only offers ${others.join(", ")}. ` +
          `Refusing to fall back to another server's stats.`
        : `monster ${id}: no stat block at all and no "Monster not found" marker — ` +
          `the page layout changed, or the response was a login/challenge page.`,
    );
  }

  const out = { id, name: null };
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (title) {
    const t = text(title[1]);
    const m = /Monster\s*-\s*(.+)$/.exec(t);
    // Korean on most pages — kept for debugging only. The pt-BR name published
    // in mobs.json always comes from RagnaPlace.
    if (m) out.name = m[1].trim();
  }

  let section = null;
  for (const row of block.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const inner = row[1];
    const th = /<th\b[^>]*>([\s\S]*?)<\/th>/i.exec(inner);
    if (th) {
      section = text(th[1]).toLowerCase();
      continue;
    }
    const tds = cells(inner);
    if (section === "basic info") {
      const strong = [...inner.matchAll(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi)].map((m) => text(m[1]));
      if (/\bLv\.?\s*$/i.test(text(tds[1] ?? "").replace(/[\d,]+\s*$/, "")) && strong.length >= 2) {
        out.pageId = num(strong[0]);
        out.level = num(strong[1]);
        continue;
      }
      // race / size / element — the element cell carries its level ("Ghost 2").
      if (tds.length === 3 && tds.every((c) => /<span/i.test(c))) {
        out.race = text(tds[0]) || null;
        out.size = text(tds[1]) || null;
        const prop = text(tds[2]);
        const pm = /^(.*?)\s*(\d+)$/.exec(prop);
        out.property = (pm ? pm[1] : prop) || null;
        out.propertyLevel = pm ? num(pm[2]) : null;
      }
      continue;
    }
    for (const td of tds) {
      const stat = readStatCell(td);
      if (!stat) continue;
      const [label, lo, hi] = stat;
      switch (label.toLowerCase()) {
        case "str": out.str = lo; break;
        case "agi": out.agi = lo; break;
        case "vit": out.vit = lo; break;
        case "int": out.int = lo; break;
        case "dex": out.dex = lo; break;
        case "luk": out.luk = lo; break;
        case "health": out.hp = lo; break;
        case "def": out.def = lo; break;
        case "mdef": out.mdef = lo; break;
        case "res": out.res = lo; break;
        case "mres": out.mres = lo; break;
        case "range": out.range = lo; break;
        case "attack": out.attackMin = lo; out.attackMax = hi; break;
        case "matk": out.matkMin = lo; out.matkMax = hi; break;
        case "req. hit": out.hit = lo; break;
        case "req. flee": out.flee = lo; break;
        default: break; // Speed / Aspd and anything divine-pride adds later
      }
    }
  }

  // A half-parsed block is worse than a failed one, in two distinct ways:
  //
  //   res/mres  are the whole point of this crawler and render in a row of their
  //             own that older layouts didn't have. Missing them would publish
  //             null — "unknown" — for a monster whose page we fetched perfectly
  //             well, the exact ambiguity this pipeline exists to remove.
  //   the rest  are what the merge cross-checks against RagnaPlace, and the
  //             cross-check skips any field either side leaves null. So a parser
  //             quietly returning nulls wouldn't just lose data, it would switch
  //             off the safety net that was supposed to catch it.
  //
  // All of them are present on every page crawled so far, res 0 included (a real
  // zero renders as "0 Res", not as an absent row), so demanding them costs
  // nothing and turns a silent degradation into a stop.
  const holes = REQUIRED.filter((k) => out[k] == null);
  if (holes.length) {
    throw new ParseError(
      `monster ${id}: #${BLOCK_ID} parsed but carries no ${holes.join(", ")} ` +
        `(level ${out.level}, hp ${out.hp}). Check the page by hand before trusting this run.`,
    );
  }
  if (out.pageId != null && out.pageId !== id) {
    throw new ParseError(`monster ${id}: the page's own id is ${out.pageId} — a redirect or an id reuse.`);
  }
  // A blank block is no more data than the "?" page is, so it produces the same
  // answer: unknown. Checked after REQUIRED so a genuinely broken parse still
  // raises instead of being waved through as an empty record.
  return isEmptyBlock(out) ? null : out;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

// The old scraper kept a logged-in session in a gitignored .dp-cookies.json for
// LATAM-gated pages. The block is served anonymously as of 2026-08-14, so the
// jar is optional — but if one is present we send it and check it still works,
// because a silently expired session used to produce an empty scrape.
function loadCookies(explicitPath) {
  const path = resolve(explicitPath ? explicitPath : resolve(REPO_ROOT, ".dp-cookies.json"));
  if (!existsSync(path)) {
    if (explicitPath) {
      console.error(`! cookie jar ${path} does not exist`);
      process.exit(1);
    }
    return null;
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`! ${path} is not valid JSON (${err.message}). Re-export it or delete it.`);
    process.exit(1);
  }
  // Accept either { name: value } or the browser-export [{name, value}, ...].
  const pairs = Array.isArray(raw)
    ? raw.filter((c) => c && c.name).map((c) => [c.name, c.value])
    : Object.entries(raw);
  if (!pairs.length) {
    console.error(`! ${path} holds no cookies. Re-export it or delete it.`);
    process.exit(1);
  }
  const expired = Array.isArray(raw)
    ? raw.filter((c) => c.expirationDate && c.expirationDate * 1000 < Date.now()).map((c) => c.name)
    : [];
  if (expired.length) {
    console.error(
      `! the divine-pride session in ${path} expired (${expired.join(", ")}).\n` +
        `  Log in at https://www.divine-pride.net and re-export the cookies, or delete the file\n` +
        `  to crawl anonymously — the LATAM stat block does not currently require a session.`,
    );
    process.exit(1);
  }
  console.error(`using the divine-pride session in ${path} (${pairs.length} cookies)`);
  return pairs.map(([k, v]) => `${k}=${v}`).join("; ");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchPage(id, cookie) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}/${id}`, {
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9",
          ...(cookie ? { cookie } : {}),
        },
      });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS - 1) throw err;
      await sleep(2 ** attempt * 2000);
      continue;
    }
    if (res.status === 200) return res.text();
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = (Number.isFinite(retryAfter) ? retryAfter : 2 ** attempt * 5) * 1000;
      console.error(`  ${id}: HTTP ${res.status}, backing off ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `GET ${BASE}/${id} → ${res.status}. divine-pride is refusing anonymous access; ` +
          `log in at https://www.divine-pride.net, export the cookies to .dp-cookies.json and re-run.`,
      );
    }
    throw new Error(`GET ${BASE}/${id} → ${res.status}`);
  }
  throw new Error(`GET ${BASE}/${id} failed after ${MAX_ATTEMPTS} attempts`);
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.bad) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const outPath = resolve(args.out ? args.out : resolve(REPO_ROOT, "_scratch/dp-stats.json"));
  const cachePath = resolve(args.cache ? args.cache : resolve(REPO_ROOT, "_scratch/dp-cache.jsonl"));
  mkdirSync(dirname(outPath), { recursive: true });
  mkdirSync(dirname(cachePath), { recursive: true });
  const delay = Number.isFinite(args.delay) && args.delay >= 0 ? args.delay : DEFAULT_DELAY_MS;
  const ttlMs = (Number.isFinite(args.ttl) ? args.ttl : DEFAULT_TTL_DAYS) * 86400_000;

  // Id universe. mobs.json is the right default: RagnaPlace has already told us
  // which of the client's ~4600 sprite ids are actually monsters, so crawling it
  // spares divine-pride ~1900 pointless requests.
  let ids;
  if (args.only) {
    ids = args.only.split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
  } else if (args.ids) {
    ids = (JSON.parse(readFileSync(resolve(args.ids), "utf8")).mobs || []).map((m) => m.id);
  } else {
    const mobsPath = resolve(args.mobs ? args.mobs : resolve(REPO_ROOT, "resources/raw/mobs.json"));
    if (!existsSync(mobsPath)) {
      console.error(`! ${mobsPath} does not exist — run tools/scrape-mobs.mjs --no-dp first, or pass --ids/--only.`);
      process.exit(1);
    }
    ids = JSON.parse(readFileSync(mobsPath, "utf8")).map((m) => m.id);
  }
  ids = [...new Set(ids)].sort((a, b) => a - b);

  // Cache: append-only, last line per id wins. Holds the parsed record rather
  // than the HTML — the pages are ~250 KB each and we want one narrow table.
  const cache = new Map(); // id -> { at, stats }
  if (args.fresh) rmSync(cachePath, { force: true });
  else if (existsSync(cachePath)) {
    for (const line of readFileSync(cachePath, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        cache.set(e.id, e);
      } catch { /* truncated final line from an interrupted write */ }
    }
  }

  const cutoff = Date.now() - ttlMs;
  let todo = ids.filter((id) => !(cache.get(id)?.at > cutoff));
  const cached = ids.length - todo.length;
  if (Number.isFinite(args.limit) && args.limit > 0) todo = todo.slice(0, args.limit);

  const cookie = loadCookies(args.cookies);
  console.error(
    `divine-pride → ${outPath}\n` +
      `  ${ids.length} monsters, ${cached} already cached, ${todo.length} to fetch` +
      `${delay ? ` at ${delay}ms apart` : ""}`,
  );

  let ok = 0;
  let absent = 0;
  const started = Date.now();
  for (const [i, id] of todo.entries()) {
    if (i > 0 && delay) await sleep(delay);
    const html = await fetchPage(id, cookie);
    let stats;
    try {
      stats = html == null ? null : parseMonsterPage(html, id);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      // A parse failure needs a person to open the page, so hand them the link.
      // Everything fetched so far is already in the cache, so re-running after
      // the fix resumes rather than starting over.
      err.message += `\n  ${BASE}/${id}`;
      throw err;
    }
    // All of these publish null; recorded so the run can say which kind of hole
    // it is. "empty-block" is the one parseMonsterPage decided, not the page.
    const reason = stats ? null : html == null ? "no-page" : (noStatsReason(html) ?? "empty-block");
    const entry = { id, at: Date.now(), stats, ...(reason ? { reason } : {}) };
    cache.set(id, entry);
    appendFileSync(cachePath, `${JSON.stringify(entry)}\n`);
    if (stats) ok++; else absent++;
    if ((i + 1) % 50 === 0 || i + 1 === todo.length) {
      const secs = Math.round((Date.now() - started) / 1000);
      console.error(`  ${i + 1}/${todo.length} — ${ok} found, ${absent} absent (${secs}s)`);
    }
  }

  const monsters = [];
  const missing = [];
  const noData = [];
  for (const id of ids) {
    const e = cache.get(id);
    if (!e) continue; // not crawled yet (a --limit sample, or an interrupted run)
    // isEmptyBlock() is re-applied here, not just at parse time, so a cache
    // written before that rule existed is reclassified instead of quietly
    // shipping its zeros. Re-crawling ~2700 pages to reprint a JSON file the
    // cache can already answer would be rude for no benefit.
    if (e.stats && !isEmptyBlock(e.stats)) {
      monsters.push(e.stats);
      continue;
    }
    // Everything here publishes res/mres null. `noData` is the subset divine-pride
    // *does* have a page for but no numbers on — worth telling apart from an id
    // it has never heard of when judging whether a hole may ever fill in.
    missing.push(id);
    if (e.reason !== "no-page") noData.push(id);
  }
  monsters.sort((a, b) => a.id - b.id);

  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        source: "divine-pride.net",
        block: BLOCK_ID,
        crawledAt: new Date().toISOString(),
        // Ids in the universe that were never crawled — distinguishes a partial
        // run from a monster divine-pride genuinely doesn't have.
        uncrawled: ids.filter((id) => !cache.has(id)),
        missing,
        noData,
        monsters,
      },
      null,
      2,
    )}\n`,
  );

  const zeroRes = monsters.filter((m) => m.res === 0 && m.mres === 0).length;
  console.error(
    `\nwrote ${monsters.length} stat blocks to ${outPath}\n` +
      `  ${missing.length} will publish res/mres null — ${noData.length} listed by divine-pride ` +
      `but with no numbers, ${missing.length - noData.length} with no page at all\n` +
      `  ${zeroRes} have res 0 and mres 0 (a real value, not a gap)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
