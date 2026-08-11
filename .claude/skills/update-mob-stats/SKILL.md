---
name: update-mob-stats
description: Rebuild resources/raw/mobs.json (monster stats — level, HP, EXP, race, size, element, boss/MVP) from the RagnaPlace Public API, using the client GRF for the monster id list. Use after a client update, when mobs.json is stale, or when a monster is missing from it.
---

# Rebuild mobs.json from the RagnaPlace API

`resources/raw/mobs.json` is the one table served at `/raw` that is **not**
extracted from the client GRF. It carries per-monster stats for the LATAM server:

```json
{ "id": 1039, "aegisId": "BAPHOMET", "name": "Bafomé", "boss": true, "mvp": true,
  "level": 81, "baseExp": 218089, "jobExp": 167053, "mvpExp": 109044,
  "hp": 668000, "def": 379, "mdef": 45, "attack": 2520,
  "str": 120, "agi": 125, "vit": 30, "int": 85, "dex": 186, "luk": 85,
  "race": "Demon", "size": "Large", "property": "Dark", "propertyLevel": 3 }
```

`property` and `propertyLevel` stay separate — a consumer that wants the combined
`"Dark 3"` form can join them, but the split can't be recovered from the joined
string. `res`/`mres` are not exposed by the API at all.

Two sources, because neither alone is enough:

- **The client GRF** gives the monster **id universe** — and nothing else useful.
- **The RagnaPlace API** gives every stat, but has **no bulk mob endpoint**.

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

## Prerequisites

- **`RAGNAPLACE_API_KEY` in `.env`** (gitignored; `.env.example` documents it).
  Keys are requested at <https://ragnaplace.com/api> (requires login) and start
  *pending* — they only work once an admin approves them. Never log or commit it.
- **The client GRF**, normally `C:\Gravity\Ragnarok\data.grf`.

## Steps

1. Extract the candidate id list from the client:

   ```bash
   node extract-grf.mjs --mobids _scratch/mobids.json --grf "C:/Gravity/Ragnarok/data.grf"
   ```

   Reads **`data/luafiles514/lua files/datainfo/npcidentity.lub`** and writes every
   `JT_<AEGIS>` → id at 1000 or above (~4585 ids in the current client). Use the
   `datainfo/` copy, **not** `lua files/npcidentity.lub` — that one is a stale
   subset that stops at id 10203 and misses every 20000+ monster.

2. Rebuild `mobs.json`:

   ```bash
   node tools/scrape-mobs.mjs --ids _scratch/mobids.json
   ```

   Defaults to gateway `laro-pt` and `resources/raw/mobs.json`; override with
   `--gateway` / `--out` (e.g. `laro-es`, `laro-en` — `/v1/gateways` lists all 36).
   Ids that aren't monsters 404 and are skipped (~1900 of them are NPC/job
   sprites). Ids already in the existing `mobs.json` are folded into the
   candidate set, so a monster the client stops shipping doesn't silently vanish.

   **Back the current file up first** — it is no longer in git, so a bad run has
   nothing to revert to, and refetching costs the whole API quota:

   ```bash
   cp resources/raw/mobs.json _scratch/mobs.prev.json
   ```

3. Verify before deploying:

   ```bash
   node -e "const a=require('./_scratch/mobs.prev.json'),b=require('./resources/raw/mobs.json');const f=m=>[m.length,m.filter(x=>x.mvp).length,m.filter(x=>x.boss).length].join('/');console.log('was',f(a),'now',f(b),'(mobs/MVP/boss)')"
   ```

   Expect the count to grow slightly after a client update and never to collapse.
   The tool refuses to write an empty result, but a big *drop* is still worth
   investigating before shipping. Deploy with the `deploy` skill, which ships
   `resources/raw` to the server that serves `/raw/mobs.json`.

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
