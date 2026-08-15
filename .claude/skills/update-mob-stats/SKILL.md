---
name: update-mob-stats
description: Rebuild resources/raw/mobs.json (monster stats — level, HP, EXP, race, size, element, boss/MVP, res/mres) from the RagnaPlace Public API plus a divine-pride crawl. Use after a client update, when mobs.json is stale, when a monster is missing from it, or when res/mres are missing or wrong.
---

# Rebuild mobs.json from the RagnaPlace API

`resources/raw/mobs.json` is the one table served at `/raw` that is **not**
extracted from the client GRF. It carries per-monster stats for the LATAM server:

```json
{ "id": 1039, "aegisId": "BAPHOMET", "name": "Bafomé", "boss": true, "mvp": true,
  "level": 81, "baseExp": 218089, "jobExp": 167053, "mvpExp": 109044,
  "hp": 668000, "def": 379, "mdef": 45, "attack": 2520,
  "str": 120, "agi": 125, "vit": 30, "int": 85, "dex": 186, "luk": 85,
  "race": "Demon", "size": "Large", "property": "Dark", "propertyLevel": 3,
  "res": 0, "mres": 0 }
```

`property` and `propertyLevel` stay separate — a consumer that wants the combined
`"Dark 3"` form can join them, but the split can't be recovered from the joined
string.

`res`/`mres` are the 4th-job resistances and are **nullable**. `0` is a real,
common value (Baphomet above really is 0); `null` means divine-pride has no page
for that monster, i.e. *unknown*. Never conflate them — treating unknown as 0 is
what made a level 224 MVP simulate at ~3.3× the damage the server actually dealt.

Three sources, because none alone is enough:

- **The client GRF** gives the monster **id universe** — and nothing else useful.
- **The RagnaPlace API** gives every stat except the resistances, but has **no
  bulk mob endpoint**. It is authoritative for the record's identity (`id`,
  `aegisId`) and its **pt-BR `name`** — the LATAM client's own vocabulary.
- **divine-pride.net** is the only public source for **`res`/`mres`**. Its page
  title is the *Korean* name (21360 is `슐랑`), so nothing textual is taken from it.

## Why it is split that way

The client carries no monster HP or EXP *anywhere* — this was checked
exhaustively (every `.lub`/`.lua`, `.txt`, `.xml`, `.csv`, `.json` in the 4.3 GB
GRF plus the loose `System/` tree). The Sense skill doesn't read a client table
either; the server answers it with packet `ZC_MONSTER_INFO` (`0x18C`), which is
also why Sense can show a live instance's HP and def. What the client *does*
have is `navigation/navi_mob_br.lub` (map, id, level, packed element/size/race,
`300` normal / `301` MVP) — useful for cross-checking, but it only covers mobs
that spawn on a real map (~1270 of ~2700, missing most instance MVPs), so the
API is authoritative and `navi_mob` is not part of this pipeline.

Conversely the API's `/v1/{gateway}/search` is capped at **20 pages × 20 rows =
400 results**, so it can't enumerate ~2700 monsters. Only
`/v1/{gateway}/mob/{id}` returns a full record, so the run is one GET per id and
the id list has to come from somewhere — `datainfo/npcidentity.lub` in the GRF.

And the API carries **no `res`/`mres` field on any monster** — checked by dumping
a full raw record. Those are 4th-job resistances and matter enormously above
level ~200, so they come from divine-pride, which publishes them per server.

## Prerequisites

- **`RAGNAPLACE_API_KEY` in `.env`** (gitignored; `.env.example` documents it).
  Keys are requested at <https://ragnaplace.com/api> (requires login) and start
  *pending* — they only work once an admin approves them. Never log or commit it.
- **The client GRF**, normally `C:\Gravity\Ragnarok\data.grf`.
- **Nothing for divine-pride.** It is crawled anonymously — verified 2026-08-14.
  If it ever starts gating the LATAM block, `tools/crawl-divine-pride.mjs` reads
  a browser-exported cookie jar from `.dp-cookies.json` (gitignored) and exits
  with an actionable message when the session is expired or the site answers
  401/403, rather than silently producing an empty scrape.

## Steps

1. Extract the candidate id list from the client:

   ```bash
   node extract-grf.mjs --mobids _scratch/mobids.json --grf "C:/Gravity/Ragnarok/data.grf"
   ```

   Reads **`data/luafiles514/lua files/datainfo/npcidentity.lub`** and writes every
   `JT_<AEGIS>` → id at 1000 or above (~4585 ids in the current client). Use the
   `datainfo/` copy, **not** `lua files/npcidentity.lub` — that one is a stale
   subset that stops at id 10203 and misses every 20000+ monster.

2. **Back the current file up first** — it is no longer in git, so a bad run has
   nothing to revert to, and refetching costs the whole API quota:

   ```bash
   cp resources/raw/mobs.json _scratch/mobs.prev.json
   ```

3. Rebuild `mobs.json` from RagnaPlace:

   ```bash
   node tools/scrape-mobs.mjs --ids _scratch/mobids.json
   ```

   Defaults to gateway `laro-pt` and `resources/raw/mobs.json`; override with
   `--gateway` / `--out` (e.g. `laro-es`, `laro-en` — `/v1/gateways` lists all 36).
   Ids that aren't monsters 404 and are skipped (~1900 of them are NPC/job
   sprites). Ids already in the existing `mobs.json` are folded into the
   candidate set, so a monster the client stops shipping doesn't silently vanish.

   This step needs an existing `_scratch/dp-stats.json` (step 4) and refuses to
   run without one, because publishing `res`/`mres` as null for the whole
   catalogue would silently undo the reason the second source exists. Pass
   `--no-dp` only on a genuine first run, when there is no `mobs.json` yet for
   the crawler to walk.

4. Refresh the resistances from divine-pride:

   ```bash
   node tools/crawl-divine-pride.mjs        # ~1 h for the full catalogue
   node tools/scrape-mobs.mjs --merge-only  # folds them in; costs no API quota
   ```

   The crawler walks the ids in `mobs.json`, one serialised request per monster,
   and caches every parsed record in `_scratch/dp-cache.jsonl` for 30 days — so
   an interrupted run resumes and a re-run right after is nearly free. Use
   `--only 21360,21361` to spot-check without a full crawl.

   `--merge-only` re-merges into the existing `mobs.json` without touching the
   RagnaPlace API, which is what you want whenever only the resistances changed.

   The merge **fails without writing the file** if any field both sources publish
   disagrees. See "Cross-validation" below — do not work around it.

5. Verify before deploying:

   ```bash
   node -e "const a=require('./_scratch/mobs.prev.json'),b=require('./resources/raw/mobs.json');const f=m=>[m.length,m.filter(x=>x.mvp).length,m.filter(x=>x.boss).length,m.filter(x=>x.res!=null).length,m.filter(x=>x.res>0).length].join('/');console.log('was',f(a),'now',f(b),'(mobs/MVP/boss/res-known/res-nonzero)')"
   ```

   Expect the count to grow slightly after a client update and never to collapse.
   The tool refuses to write an empty result, but a big *drop* is still worth
   investigating before shipping. `res-known` collapsing means the crawl went
   stale or broke — that is the failure mode this whole second source exists to
   prevent, so treat it as a blocker. Deploy with the `deploy` skill, which ships
   `resources/raw` to the server that serves `/raw/mobs.json`.

## Cross-validation, and what to do when it fails

Every field both sources publish — `level`, `hp`, `def`, `mdef`, the six base
stats, `race`, `size`, `property`, `propertyLevel` — is compared, and any
disagreement **stops the run without writing `mobs.json`**, printing both values
and the monster's divine-pride URL.

**Do not "fix" this by preferring a source, widening a tolerance, or dropping the
field from the check.** A divergence means either the crawler broke or the two
databases genuinely differ, and those need opposite responses. Open the page,
decide which it is, then record the decision in `tools/dp-divergences.json`:

```json
{ "id": 2104, "aegisId": "E_DARK_SNAKE_LORD", "field": "propertyLevel",
  "ragnaplace": 1, "divinePride": 3, "prefer": "ragnaplace",
  "reviewed": "2026-08-14", "why": "…" }
```

An entry matches only while **both** recorded values still hold, so if either
source later moves, the check fires again and the difference gets re-reviewed.
`prefer` decides which value `mobs.json` publishes for that one field.

An entry may also carry `"resistances": "unknown"`, which makes that monster
publish `res`/`mres` **null** instead of divine-pride's number. Use it only when
the divine-pride record demonstrably describes something else — the four current
uses (2501, 2502, 2503, 3819) are dummy pages with level 1 and 10 HP against a
real RagnaPlace record. Never use it because a value merely looks surprising:
publishing 0 from a bogus record is the exact failure this source exists to stop.

**Current state: 82 disagreements on 39 of 2710 monsters, all recorded.** The big
one is a genuine correction — RagnaPlace reports `propertyLevel: 1` for all 20
`E_*`/`EVENT_*` event clones, and on the 13 with an identifiable base monster
divine-pride's value is exactly the base's, which both sources already agree on.
A uniform 1 across bases spanning levels 1-4 is a default, so those 20 publish
divine-pride's value. It is the only pre-existing field the second source changed.

Two comparisons are deliberately **not** made:

- **`attack`.** RagnaPlace returns the database's raw attack; divine-pride
  renders the *computed* renewal range (Baphomet: `2520` vs `2,721 - 3,981`).
  Different quantities, so comparing them fires on ~95% of the catalogue.
- **`name`.** RagnaPlace's pt-BR name is authoritative and always wins;
  divine-pride serves the Korean one (21360 is `슐랑`).

Race vocabulary is normalised before comparing, not compared raw: kRO renamed
Demi-Human to `Human`, and laro-pt leaks the untranslated pt-BR `fantasma` for
`Formless` on 449 rows (see the `race` note below). Both are naming, not data,
and letting them fire would bury the real findings.

## Notes and gotchas

- **Rate limits** are per key and advertised on every response
  (`X-RateLimit-Limit/Remaining/Reset` — currently 400 per window). The scraper
  throttles off those headers rather than a hardcoded rate, so don't add sleeps.
- **Resumable.** Progress is appended to `mobs.json.partial.jsonl`; an
  interrupted run picks up where it left off instead of re-spending the quota.
  Pass `--fresh` to ignore it and refetch everything.
- **Field mapping — `mvp` is the subtle one, and it bites.** `boss` is
  `class === "Boss"`, which covers mini-bosses (Ghostring, Angeling) *and* MVPs, so
  it can't set `mvp` by itself, and the API exposes no rAthena-style `modes` field.
  No single field reproduces it, so `isMvp()` unions three signals:
  1. AI `type` `301` (`300` otherwise) — the game's own marker, and the same value
     the client's `navi_mob_br.lub` packs per spawn, which is an independent
     confirmation. **`type` is a string in the schema (`"301"`)** — `m.type === 301`
     never matches and silently costs ~70 MVPs. Compare with `Number(m.type)`.
  2. `exp.mvp` set — unambiguous, but null on many real MVPs.
  3. `class === "Boss" && drops.some(d => d.isMvpDrop)` — catches the MVPs with
     `type: 300`/null and no MVP exp (Naght Sieger, Entweihen, the event/echo boss
     variants). **The Boss-class guard is load-bearing**: the MVP-drop test alone
     over-fires on event mobs like the `Event`-class `E_ANOPHELES`.

  `boss` is `class === "Boss" || mvp`. The fold-in is deliberate — upstream leaves
  `class` **null** (missing, not "not a boss") on ~77 instance MVPs, and an MVP is
  boss-class by definition, so this keeps the `mvp ⊆ boss` invariant the file has
  always had.

  **Always diff the MVP/boss counts against the previous file before committing.**
  Both traps above produced a perfectly plausible-looking mobs.json and were caught
  only that way. Current baseline: 2724 monsters, 601 boss, 264 MVP.
- **`race` is dirty upstream, not in transit.** 449 rows come back as
  `"fantasma"`, 20 as `"Human"`, 1 as `"Demi-Human"`, 10 as `null` — the API
  returns exactly what the old HTML scrape did, so this is RagnaPlace's own data,
  not an encoding bug on our side. Don't "fix" it silently; the client's
  `navi_mob_br.lub` packs a correct race per spawned mob if it ever matters.
  divine-pride independently confirms the mapping — every `fantasma` row is
  `Formless` there and every `Demihuman` row is `Human`, with no exceptions in
  the catalogue — so the values are right and only the labels are dirty.

### divine-pride

- **The stat block is chosen by id, and that is the whole ballgame.** A monster
  page renders one table per server/episode in
  `<div class="alternatestats" id="alternatestats_<SOURCE>">`. LATAM is
  `alternatestats_default` and it is **last, not first** — Poring's page goes
  iRO, kRO, twRO, vnRO, then default. The blocks disagree (iRO's Poring: 60 HP,
  13–16 attack; LATAM's: 55 HP, 7–8), so anything positional yields another
  server's monster, plausibly and silently. `parseMonsterPage()` selects by id
  and **throws** if the block is absent rather than falling back. Never relax that.
- **Three different ways of saying "no data", all meaning `null`.** Each has to
  be told apart from a broken page, and each cost a debugging round:
  1. **Unknown id → HTTP 200**, not 404, with a `<legend class="entry-title">
     Monster not found</legend>` page.
  2. **Listed but empty** — every cell is `?` titled *"We don't have this yet"*
     and the page ships **no** `alternatestats` blocks. 25239 `C4_SASQUATCH`
     is the one; it stopped the first full crawl 33 pages from the end.
  3. **A blank stat block** — level 0, 0 HP, every stat 0 (2394-2397, 2504-2509).
     Six of those have real RagnaPlace records, so trusting the zeros would
     publish "no resistance" off an empty page. **0 HP alone is not the test**:
     1210 and the twelve Agni/Varuna/Vayu/Chandra spirits have 0 HP with a real
     level and RagnaPlace agrees, so the test is level 0 *and* 0 HP.
- **A parsed block missing any cross-checked field is an error, not a null.** Two
  reasons, and the second is the subtle one: publishing null for a monster whose
  page fetched fine is indistinguishable downstream from one divine-pride has
  never heard of, *and* the cross-check skips any field either side leaves null —
  so a parser quietly returning nulls would also switch off the net meant to
  catch it. `propertyLevel` is the one exception, and deliberately so: 3130
  GM Cultist really does render a bare "Neutral" with no level, alongside level
  75 and 4,835 HP.
- **Never check in divine-pride's HTML.** Copies of their page source would
  redistribute their markup under this repo's MIT licence. The fixtures in
  `tools/crawl-divine-pride.test.mjs` are *written* — `page()` and `statBlock()`
  emit the minimum structure the parser keys on. The numbers in them are game
  facts, which is a different thing from their expression of those facts.
- **Synthetic fixtures can't notice the site changing**, so the same file carries
  four opt-in live checks. Run them before trusting a crawl after any long gap,
  and whenever the parser is touched:

  ```bash
  DP_LIVE=1 node --test tools/crawl-divine-pride.test.mjs
  ```

  They fetch four real pages and assert the written fixtures still describe
  reality — including that `alternatestats_default` is still not first *and*
  still differs from the first block, which is the assumption everything else
  rests on. Offline runs skip them; `node --test` alone stays hermetic.
- **The regression values** are 21360 Schulang (res 205, mres 368, def 217,
  mdef 70) and 21361 Twisted God Freyja (res 249, mres 499, def 314, mdef 520),
  both hand-verified. 21361 is the control: its four values match, to the number,
  the record an older divine-pride scraper produced before the RagnaPlace
  migration dropped it.
- **Be polite.** ~2700 pages of ~250 KB each off a third party. Requests are
  serialised with a delay and parsed records cached for 30 days in
  `_scratch/dp-cache.jsonl`; use `--only` for spot checks and `--merge-only`
  when nothing needs re-fetching. Don't raise the rate or add concurrency.
- The API still exposes more than `mobs.json` keeps — `drops`, `spawns`, `skills`,
  `image`, `walkSpeed`, `url`. Widen `toRecord()` if a consumer needs them. The
  file is consumed outside this repo (the LATAM calculator and the replay viewer
  both fetch `https://assets.latam-tools.com.br/raw/mobs.json`), so treat removing
  or renaming a field as a breaking change. It is served, not committed, so the
  change goes live the moment `resources/raw` is deployed — there is no PR
  reviewing it.
- **Do not scrape the website.** The old `_payload.json` + devalue-hydration
  technique against `ragnaplace.com` is obsolete and the plain HTML routes sit
  behind a Cloudflare challenge. Everything goes through `api.ragnaplace.com`.
- Spec: <https://ro.ragnaplace.com/v1/openapi.json> (servers → `https://api.ragnaplace.com`,
  auth → `x-api-key` header). Human reference: <https://ragnaplace.com/pt/api/reference>.
- Credit RagnaPlace in `README.md` — that section is why the file is allowed here.
