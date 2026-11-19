# tools/multiserver — extracting visuals from every live official server

Six stages over one CLI. The plan and the reasoning behind each decision are in
[docs/multi-server-extraction-plan.md](../../docs/multi-server-extraction-plan.md);
this is how to run it.

```bash
node tools/multiserver/cli.mjs status
```

## Requirements

- Node 18+ (the EUC-KR/Shift-JIS/Big5 decoders and `fetch`).
- `curl` on PATH — iRO serves its archives over FTP only, and curl does FTP
  `REST` ranges correctly.
- Nothing else. This lives in ragassets now, so the GRF format, the Lua 5.1
  undumper and the BMP conversion are plain imports from `../../extract-grf.mjs`
  rather than a path in an environment variable. There is no `EXTRACT_GRF` and
  no second copy of any of it; see [What is shared with
  extract-grf.mjs](#what-is-shared-with-extract-grfmjs).

State lives outside the repo, in `MULTISERVER_DIR` (default `~/ro-multiserver`):

```
index/<origin>/archives.tsv   the resume ledger — one row per archive
index/<origin>/paths.tsv      one row per file inside every archive
index/<origin>/rgz.tsv        tableless gzip patches (no range read possible)
index/<origin>/rgz.tsv.probe  what was found inside the ones we opened
cache/<origin>/               downloaded archives
catalog/<origin>/             views.tsv (headgear), robes.tsv (garment),
                              items.tsv, names.tsv, costumes.tsv
mirror/<origin>/data/...      extracted assets, newest patch wins
shortlist.tsv                 what is missing, and which origins have it
slots.tsv                     which slot each (kind, view) equips in
plan.tsv                      which archive each wanted file is read from
icons-plan.tsv                the same, for the costumes' inventory icons
foreign-costumes.json         the published catalogue
icons/{item,collection}/      the published icon PNGs, keyed by sprite name
```

## The stages

### 1. `index` — list every archive without downloading one

```bash
node tools/multiserver/cli.mjs index --origin all          # the full run, ~85 MB
node tools/multiserver/cli.mjs index --origin twro --limit 60   # a slice
```

A GRF keeps its file table at the end and the offset is in the first 46 bytes,
so two range reads describe a whole patch. Resumable: the ledger is keyed by
filename and an archive already in it is skipped, so interrupting and re-running
costs nothing, and a later run only pays for new patches.

Archives that cannot be read are **recorded, never skipped silently** —
`blocked` for kRO/jRO v0x300, `rgz` for the tableless ones, `error` with the
message otherwise. Their paths are still indexed: the index then says which
archive *would* have a file once the format is understood.

One request per second per host (`MULTISERVER_INTERVAL_MS`).

`--origin all` walks the origins one after another, so the full run is the *sum*
of them (~85 MB, ~5 h) even though the politeness limit is per **host**. To get
the wall clock back, run one process per host group — the limiter is in-process,
so origins that share a host must share a process:

```bash
node tools/multiserver/cli.mjs index --origin jro        &   # patch2.gungho.jp
node tools/multiserver/cli.mjs index --origin kro,krozero &   # ropatch.gnjoy.com
node tools/multiserver/cli.mjs index --origin twro,twrozero & # *.gnjoy.com.tw
node tools/multiserver/cli.mjs index --origin iro        &   # gravityus.com (FTP)
node tools/multiserver/cli.mjs index --origin latam      &   # gnjoylatam.com
```

Each process writes only its own origin's ledger, so there is nothing to
contend over. jRO is the long pole at ~2,760 archives (~1.5 h).

### 2. `catalogue` — each client's own tables

```bash
node tools/multiserver/cli.mjs catalogue --origin all
```

Finds the newest **extractable** archive carrying each of
`datainfo/AccessoryId.lub`, `datainfo/AccName.lub`, `SpriteRobeName*.lub`,
`System/iteminfo_new.lub` and the old `idnum2itemresnametable.txt` /
`idnum2itemdisplaynametable.txt` pair, downloads only those, and writes the four
TSVs. It reports when it had to pass over a newer copy because that archive is
blocked, so a stale table never looks current.

The `.lub` are read without a Lua — the precompiled bytecode goes through
ragassets' own undumper and VM; see [lubtables.mjs](lubtables.mjs) and
[iteminfo.mjs](iteminfo.mjs).

**Two item sources, and the modern one is much better.**
`System/iteminfo_new.lub` gives each item a `ClassNum`, which *is* the view id,
so the view↔item join is exact. The old `.txt` pair has only resource names, so
the join falls back to the client's convention — an accessory sprite is the
item's resource name with a leading underscore (`고글` → `_고글`) — and the run
prints how many matches came from each route (twRO: 2,339 by ClassNum, 93 by
convention).

**twRO ships no `.txt` tables at all.** A grep of its whole 2,833-archive index
finds neither file; its item data arrives as `System/iteminfo_new.lub` inside a
`.rgz`, which has no file table to range-read. So when an origin has no `.txt`
pair, the stage probes the newest `.rgz` for it — client patches first, hash
files and the 18 MB `Ragexe` last (see `rgzProbeOrder`), writing what it finds
into `rgz.tsv.probe` so a second run opens nothing twice. twRO's 8.6 MB
iteminfo was in the first patch opened, for 2.6 MB.

The probe runs only when **what we already have fails to name half this
client's views** — see [coverage.mjs](coverage.mjs). Presence of the `.txt` files
is the wrong test: twRO ships 277 copies of the resource table and no display
table (so it names nothing), kRO ships an ancient pair that names 553 of 2,734
views, while jRO's pair is current enough that probing it cost 41 MB for nothing.
`--no-rgz-probe` turns it off, `--rgz-limit N` caps it.

**This is the stage that solves the naming problem.** A costume with no LATAM
item still has a name on another server: **3,021 of the 3,272 union (kind, view)
pairs are named**, and all 496 of the costume-flagged ones LATAM lacks.

**There is no human English name to be had.** iRO stopped shipping the `.txt`
tables in 2016, ships no path outside `data\` at all (so never
`System/iteminfo_new.lub`, not even in a `.rgz`), and its "display name" table
holds identifiers rather than prose — 7,379 of 8,367 values contain an
underscore (`Orange_Potion`). So the human names are pt-BR, Chinese, Japanese and
(stale) Korean; English exists only as the AegisName in
`Lua Files/ItemDBNameTbl.lub`, which every client ships and which the shortlist
carries in its `aegis` column as a translation base.

**Two namespaces, never merged.** A headgear view id comes from
`AccessoryId`/`AccName`; a garment's comes from `SpriteRobeId`/`SpriteRobeName`,
and the same small number is a different costume in each (LATAM's 8 is a surgical
mask as a headgear, Rudra's wings as a garment). Every key downstream is
`<kind>:<view>`. An item's `ClassNum` is its view id *within its namespace*, and
a weapon's is a third space again, so the namespace is decided by the item's
resource name — `_<res>` is an accessory sprite, `<res>` is a robe folder, and an
item that is neither is not a costume. On LATAM that dropped 1,971 items that
carried a `ClassNum` and belonged to neither, and the result reproduces 1,148 of
the app's own 1,239 named pairs. Names the client itself has not filled in
are dropped rather than shipped: twRO carries a literal `(null)` for 94 items.

Watch the encodings: display names are in the server's language (Shift-JIS,
Big5, EUC-KR), but **resource names are Korean in every client** because they are
GRF paths. Decoding the resource table as Shift-JIS looks like it works and
silently matches nothing. The `.txt` tables need this handled by hand (see
`readResourceTable` vs `readDisplayNameTable`); inside `iteminfo_new.lub` both
live in one file and ragassets' `decodeClientString` picks the charset per
value.

If you already have the exploration's `docs/data/*-accessories.tsv`, you can skip
re-finding them:

```bash
node tools/multiserver/cli.mjs seed          # views.tsv only, no item names
```

### 3. `shortlist` — what is actually missing

```bash
node tools/multiserver/cli.mjs shortlist
```

Joins every catalogued client against the app's own list
(`public/db/costumes.json`) and the LATAM render probe
(`docs/data/renderable.tsv`), and writes one row per view id in the union with a
`need` column. Nothing is filtered out of the file — a stage that drops rows is
one you cannot audit.

Current numbers (5 clients catalogued): 2,934 view ids, of which 1,192 are
listed in the app, 1,054 render on our mirror already, 613 are named by our
client but draw nothing, and 75 are not in our client at all.

The render probe matters because `/image` answers **200 with the bare body** for
a view id the resolver does not know, so "does this exist?" cannot be read off
the status code.

### 3b. `slots` — which slot each costume equips in

```bash
node tools/multiserver/cli.mjs slots --origin all
```

The client's item table has **no equip-position field**. The position is written
in the item's *description text*, as a labelled line in that server's language,
and ragassets reads only the Portuguese form — so every foreign costume came
back with no slot at all. The labels and values below were collected from the
tables on disk, not guessed:

| | label | values |
|---|---|---|
| pt | `Posição :` / `Equipa em :` | `Topo` `Meio` `Baixo` `Capa`, joined by "e" or "," |
| zh | `位置 :` | `頭上` `頭中` `頭下` (head upper/middle/lower), `披肩` (shoulder cape) |

Chinese joins with `/`, `、`, or nothing at all (`頭上中下`), and sometimes runs
into the next field with no separator (`頭上重量: 0`) — so the parser checks for
上/中/下 inside a 頭-prefixed value rather than matching whole words.

Only three origins ship a readable `iteminfo_new.lub` (LATAM, twRO, twRO Zero);
jRO's legacy `.txt` pair carries no description, and kRO/kRO Zero/iRO ship no
reachable modern table. But item ids are global, so those three name **2,753
(kind, view) pairs** — 1,399 top, 459 mid, 635 low, 260 garment — well beyond
the costumes they themselves offer.

Where two clients disagree (236 pairs do), the earlier source wins and the
sources come in origin order, LATAM first: LATAM is the server the app
simulates, so where it defines a view it is the authority on that view. That
ordering takes agreement with the app's own database from 1,227/1,239 to
**1,231/1,239**; the 5 that still differ are views where the app and this index
pick a different *item*, and the two items genuinely carry different slot sets.

This is product data, not just fetch order: the app needs a costume's slot to
show it at all.

### 4a. `plan` — decide what to fetch, and from where

```bash
node tools/multiserver/cli.mjs plan --origin all
node tools/multiserver/cli.mjs plan --origin all --tiers core
```

Two measurements make a planning pass worth its own stage.

**A sprite usually lives in several origins' patch histories.** Fetching per
origin downloads the same costume up to six times: the per-origin archive counts
add up to 789, while one set covering every reachable view is **215**. The plan
is a greedy set cover over `(origin, archive)` pairs — the optimum is NP-hard,
greedy is within ln(n) of it, and the input is small.

**The cover is over paths, not views.** This is the one thing the planner got
wrong, and stage 5 is what caught it. Counting a view as covered the moment one
chosen archive supplied *any* of its files looks harmless until you notice that
Gravity ships a garment's `.act` files in one patch and its `.spr` in another:
29 of 665 costumes arrived as animation data with no artwork, and two kRO Zero
hats arrived with one sex. The plan read as complete while the mirror could not
draw them. Covering paths costs 25 more archives and 30,048 more files — the
old plan was missing **31% of the garment files it needed**.

Each costume still comes from exactly **one** origin. That is not tidiness: 282
`.act` files differ in content between origins, so a garment assembled half from
twRO and half from iRO would animate against the wrong offsets. `coverPlan`
pins a view to the first origin that supplies part of it and stops counting
other origins toward it; which origin wins is the greedy's only real choice,
since `resolveOrigin` already fixes one archive per path.

**And an origin that cannot render a view does not compete for it.** The greedy
ranks an archive by how many files it supplies, which is not the same as
supplying the right ones. On the first path-covered plan `robe:132
C_2022RTC_V_Coat4` went to iRO, which has no `.spr` for it at all, while twRO
has 343; `acc:1931 _C_Dullahan_Mask` went to kRO Zero, which has one sex, while
twRO has both. Both would have been fetched, stored, and found undrawable one
stage later. `originCanDraw` applies exactly the test stage 5 applies to the
tree — both sex `.spr` files for a headgear, one `.spr` anywhere in the folder
for a garment — so a view that no origin can render is reported as unreachable
*before* the bytes are spent, instead of becoming a costume the catalogue
throws away.

**A patch is not a sprite.** twRO's client patches run 2–292 MB (median 2.8,
mean 60 in the sample on disk), and the sprites inside are a few hundred KB.

The plan skips archives stage 1 could list but not read — `archives.tsv` marks
them `blocked` (141 on kRO, 68 on jRO, all v0x300). This is not an optimisation:
the first full fetch lost 209 of 732 views, every one of them to a blocked
archive, because the planner took the newest copy of each path without checking
that it opens. Skipping them falls back to the newest *readable* copy, and where
an origin has none, the set cover hands the view to an origin that does.

`plan.tsv` is written for review before anything is fetched: every archive,
every path, every view no origin can supply. Steps are ordered by **slot**
(top, then mid, low, garment, then views whose slot no client names) rather than
by patch sequence, because a full run takes hours and can be interrupted, so the
most wanted costumes should land first. The order is free to spend this way:
`resolveOrigin` keeps one archive per path, `coverPlan` puts each path in one
step, and each origin mirrors into its own tree, so no two steps ever write the
same file. Pass `--no-slot-order` to keep patch order. What it says today, for the 825
missing costume views:

| | views | files | bytes (uncompressed) |
|---|---|---|---|
| `acc` — headgear | 511 | 2,044 | 172 MB |
| `robe` — garment | 152 | 95,493 | 4,089 MB |
| unreachable | 162 | — | — |

Garments are 96% of the cost because a garment is a *folder* — one sprite pair
per class and sex, ~624 files per view, and one view alone is 710 files and
468 MB. Headgear is two files. By slot, the same 4,261 MB splits as: top 94 MB,
mid 16 MB, low 30 MB, garment 3,216 MB, and 904 MB for views no client names a
slot for (the ones only iRO, kRO or jRO define). `--tiers` splits the costume's own files
(`core`) from the aura folder some hats carry (`effect`, only 1.2 MB in
practice), so a fetch can start with the cheap half.

The 162 unreachable views include the oldest hats in the game — `_두건` (hood),
`_머리띠` (headband), `_햇` (hat). They have sat in the installer's `data.grf`
since 2002 and were never re-patched, so **a patch history is not a client**: it
reproduces only what was shipped as a patch. The rest are views whose only copy
sits in a blocked v0x300 archive.

### 4b. `fetch` — read the planned entries without downloading the patches

```bash
node tools/multiserver/cli.mjs fetch --limit 5
node tools/multiserver/cli.mjs fetch --origin iro
```

A GRF entry carries its own offset and compressed length, so one sprite's bytes
can be read on their own. Per archive:

1. two range reads for the header and the file table (`listRemote`)
2. match the planned paths against the table's entries
3. coalesce entry spans that sit within 256 KB of each other
4. one range read per span, then `decodeGrfEntry` per entry

Step 3 pays for itself in wall clock, not bytes: every request waits its turn
behind the one-per-second-per-host limiter, so 1,500 entry reads is 25 minutes
of pure waiting. Patches group a costume's files together, so a costume usually
collapses into a single request — the smoke test pulled four iRO files in three
requests (two for the table, one for the merged span) and under 0.1 MB.

`grfEntrySpan()` and `decodeGrfEntry()` are **ragassets** exports (added
2026-11-18); the format logic stays in the repo that owns it. Files already in
the mirror are skipped, so a fetch resumes.

Measured over the two full runs: **499 requests, 577 MB transferred, 70,989
files** in the mirror (3.3 GB), and **665 of 665 planned views complete with
zero partials**. A sample of 840 files across all seven origins decodes with
ragassets' own `decodeSprFrames`/`parseActFrames`, with no failures and no
zero-byte files.

One trap, found the hard way: a GRF table lists **directories** beside its
files, distinguished only by the 0x01 flag, and the stage-1 index carried both.
A directory entry decodes to zero bytes, so writing it puts an empty file where
a directory has to go, and the next real entry under it dies with `EEXIST`.
`fileEntries()` drops them before any span is built, nothing with an empty
payload is ever written, and a single failed write is counted and stepped over
rather than ending a run that takes hours.

### 4c. `assets` — fetch and extract whole archives

```bash
node tools/multiserver/cli.mjs assets --origin twro --dry-run
node tools/multiserver/cli.mjs assets --origin twro --limit 20
```

The original whole-archive path, kept because a range read is not always
possible: a `.rgz` has no file table, and some hosts refuse `Range`. It resolves
each wanted sprite to the newest archive carrying it, then downloads and
extracts in ascending sequence order so a later patch overwrites an earlier one.
Prefer `plan` + `fetch`, which transfer a fraction of the bytes. Path shapes come
from real tables, not guesses:

```
data\sprite\악세사리\남\남_C_Chained_Bear.{act,spr}    headgear, per sex
data\sprite\로브\C_S_Thanatos_Wing\...                  garment
data\sprite\이팩트\C_S_Thanatos_Wing\...                wing / effect
```

Each origin extracts into **its own tree**. Two reasons, both load-bearing: the
same view id resolves to a different filename on jRO (2007, 2696), and ragassets
bakes the skin-tone table and the robe pruning per sprite, so those passes run
per tree.

### 5. `publishable` — the catalogue a consumer can use

```bash
node tools/multiserver/cli.mjs publishable
node tools/multiserver/cli.mjs publishable --out "$RAW_DIR"   # and serve it
```

`--out` writes a second copy into ragassets' published-JSON store, which is what
makes the catalogue reachable: `/raw/{name}.json` already accepts any
`^[a-z][a-z0-9_-]*\.json$`, so `foreign-costumes.json` is served at
`/raw/foreign-costumes.json` with no gateway change at all, under the same
revalidating cache policy as `mobs.json` — these tables are rewritten in place
after a client update, so they must not be immutable.

Everything before this stage is addressed by the pipeline's own keys: a
shortlist row, a plan step, a path inside somebody's patch. This writes
`foreign-costumes.json`, one list of costumes that are **present on disk and
renderable**, each carrying both origins the feature needs: the tree it is
rendered from, and the servers that have it.

Three things decide what the file says, all measured rather than assumed.

**A costume is listed only if the tree can draw it.** Not "every planned path
exists": a plan is a delivery order, not an inventory. `--prune-robes`
deliberately deletes the adventurer-backpack sprites Gravity leaves in every
robe folder it copies (1,119 files across 9 LATAM folders here), so a perfectly
good garment is missing files the plan listed; and a re-plan can assign a
costume's `.act` files while its `.spr` already sits in the tree from an earlier
run. So the question goes to the filesystem, per namespace: a headgear needs
both sex `.spr` files, a garment needs at least one `.spr` anywhere in its
folder. Getting this wrong cost 20 real costumes across two attempts before the
tree probe replaced it.

**The view id is not a global key.** The gateway resolves a headgear id to a
sprite name through a table baked from the LATAM client, and a foreign view id
may be absent from that table or map to a different name there (views 2007 and
2696 do). Every costume therefore carries its sprite name explicitly, and a
consumer resolves by name — never by replaying a foreign view id through the
LATAM table.

What it says today: **663 costumes, none skipped** — the plan and the catalogue
agree exactly, which is the invariant `originCanDraw` buys. 600 are named, 188
carry an English identifier. By origin: iRO 231, jRO 119, kRO Zero 113, LATAM
71, twRO 64, twRO Zero 38, kRO 27. By slot: top 163, low 132, garment 111, mid
87, and 200 whose slot no client states.

**Where it comes from and who has it are different questions.** `origin` is the
one tree whose files render it — whichever client the extraction found it
cheapest to fetch from. `origins` is every official server whose own archives
ship that sprite, which is what a filter means by "the costumes iRO has", and it
is read from the per-origin path index with the same rule the tree probe uses:
both sexes for a headgear, any `.spr` in the folder for a garment. The two
differ for 1 costume in 8 — filtering on `origin` showed a costume under one
server and hid it from every other server that has it. Measured against the
alternatives: the client's **view table** credits iRO with 591 of 592, because
Gravity ships one global accessory table and the id being in it says nothing
about the art; the client's **item table** is closer to "obtainable" but kRO
Zero publishes none, so its chip would read zero for want of data. The path
index is the only one all six answer the same way, and it undercounts rather
than inventing: an archive with no readable file table is invisible to it.

Each entry is `{kind, view, sprite, origin, origins, name, nameOrigin, aegis,
slots, files}`, plus `blank: true` on the 17 that render nothing (stage 5b). `name`
is whichever client names the item, which is not always the client the art came
from: an item id is global, so twRO can name a costume iRO supplies. `aegis` is
the English identifier, a translation base rather than a display name.

### 5b. `find-blank-visuals` — the ones that draw nothing

```bash
node tools/multiserver/find-blank-visuals.mjs [--base <gateway>]
```

A costume can be present, complete and still draw **nothing**: the sprite is a
placeholder for a `.str` effect the client hangs off it, or the client shipped
it broken. The gateway answers those with a 200 and a valid PNG of a character
wearing nothing, which no status code or content type distinguishes from a
request that asked for nothing — so the only way to find them is to render the
bare character too and compare the bytes.

17 of the 592 are blank. `blank-visuals.json` is the committed result, and
`publishable` reads it and marks those rows `blank: true`, so a consumer can
leave them out rather than ship dead tiles — it is marked rather than dropped
because "renders nothing" is a fact about the costume that the catalogue is the
right place to state. Nearly all 17 are effect costumes (`_흩날리는낙엽` falling
leaves, `_c골드샤워` gold shower, `_흩날리는벚꽃` Amatsu aura): drawing them
needs the `.str` extracted per origin, which this pipeline does not do yet.

The sweep tries ten poses before calling a costume blank. Asking for the
standing pose alone accused 47, and five of those draw perfectly well once the
character moves — iRO's `_low_pony_bu` is empty standing, walking and sitting,
and draws from action type 3 on. Only a costume that fails the first pose pays
for the other nine: 822 renders for 592 costumes.

### 6. `icons` — the inventory picture of each costume

```bash
node tools/multiserver/cli.mjs icons --plan-only       # what it would cost
node tools/multiserver/cli.mjs icons --out "$ICONS_FOREIGN_DIR"
```

`extract-grf.mjs --icons` goes item id → the item's `identifiedResourceName` out
of `System/iteminfo_new.lub` → `data/texture/유저인터페이스/item/<res>.bmp` →
`<out>/item/<id>.png`. None of that chain survives the crossing: this catalogue
has no item ids, and kRO Zero publishes no item table at all.

It does not need one. **`identifiedResourceName` *is* the accessory sprite
name** — the premise `resolveView` already rests on — so the catalogue's sprite
name goes straight to the BMP with the client's leading underscore stripped:

```
sprite _C_Chained_Bear -> data\texture\유저인터페이스\item\C_Chained_Bear.bmp
                       -> data\texture\유저인터페이스\collection\C_Chained_Bear.bmp
```

Both sizes, because a consumer uses both: `item/` is the ~24x24 inventory icon,
`collection/` the ~75x100 collection-book picture. They come through
extract-grf.mjs's own `bmpToPng`, the same magenta keying the LATAM icons get, so
the two trees cannot come out looking different.

**The icons are keyed by sprite name alone, with no origin dimension.** That is
a departure from how the sprites are stored — one tree per origin, each costume
pinned to one — and the two reasons that rule exists there are both absent here:

- A costume's `.spr` and `.act` must come from one client, because 282 `.act`
  files differ between clients and a garment assembled from two animates against
  the wrong offsets. An icon is one standalone BMP with no companion file to
  disagree with.
- Asking each costume's **own** tree for its icon finds 556 of 663 (83.9%);
  asking **every** client finds 637 (96.1%). The missing 12% are costumes whose
  art was cheapest to fetch from a client that ships no icon for it, which says
  nothing about the icon.

So an icon may come from any client that has it. `icons-plan.tsv` and the tree's
`manifest.json` both record which one each came from, because "where did this
picture come from" is a question somebody will ask.

Measured over the 663-costume catalogue: **1,275 of 1,326 icons across 210
archives, 14.8 MB uncompressed**, and 25 costumes have neither size in any
client. Those 25 are a 404 on purpose — the consumer already falls back to a
rendered thumbnail, and a placeholder would be a picture claiming to be the
costume.

The gateway serves the tree at `/icons/costume?sprite=<name>[&kind=item|collection]`,
from `FOREIGN_ICONS_DIR`. Query-shaped because the key is a client resource name
and those are Korean or Chinese far more often than not (`_두건`,
`_c7학년풍선`), which the path form's `^[a-z0-9_]+\.png$` cannot spell. The name
is validated by the same `cleanSpriteName` that guards the render parameters, and
`/icons/item/<id>.png` is untouched.

## What is shared with extract-grf.mjs

The dedupe is the point of this directory living here. What used to be a second
copy and is now an import:

| Was | Now |
|---|---|
| `grf.mjs`'s own v2 file-table parser | `parseFileTableV2` from extract-grf.mjs, which was split out of its fd reader for exactly this |
| `grf.mjs`'s `decodeName` | `decodeClientString` / `fileTableLayout` / `parseFileTableV1` |
| `lua51.mjs` (123 lines of undumper) | `runChunk` / `runChunkInto` / `LuaTable` — deleted outright |
| `extractor.mjs` (a dynamic import of a machine path) | plain `import … from "../../extract-grf.mjs"` |
| `origins.mjs`'s own patch-list parser | `parsePatchList` from `../patchlist.mjs`, now the superset both need |
| a hand-rolled BMP reader | `bmpToPng`, the same magenta keying the LATAM icons get |

`grf.mjs` keeps only its network half (`listRemote`), which has no counterpart:
extract-grf.mjs reads archives from disk and this reads them over HTTP without
downloading them.

`net.mjs` and `ranges.mjs` stay the pipeline's own, deliberately. ragassets'
only downloader is a bare `fetch` in `apply-patches.mjs` — no rate limiter, no
range reads, no FTP, no retry — so merging the two would mean growing that file
into this one rather than reusing anything.

## Not done here

`export-app-catalogue.mjs` is **not** here and belongs to the consuming app: it
mints synthetic ids off a `FOREIGN_ID_BASE`, lowercases sprite names for its own
URLs and maps slots to its own vocabulary. Those are the app's conventions, not
extraction. Everything upstream of it is extraction and lives here.

The ragassets passes — `--robe-index`, `gen-skin-table`, `--illust`,
`--effects` — are its existing pipeline run against `mirror/<origin>`, and
publishing those with an `origin` dimension waits on approval. Note that
extraction folds paths under `data/` to lowercase, so anything resolving these
trees has to be case-insensitive.
