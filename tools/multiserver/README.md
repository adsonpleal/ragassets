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
app/renderable.tsv            which view ids our own resolver draws (`renderable`)
app/costumes.json             what the consumer already lists — copied in, not ours
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
node tools/multiserver/cli.mjs index --origin thro       &   # gnjoy.in.th
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

**And sometimes only the item table knows the view exists.** jRO's `AccessoryId`
declares `acc:881`, `acc:883` and `acc:1074`, and **no client's `AccName` names
them** — not jRO's own. A view with no sprite name is a view the planner cannot
build a target for, so those three sat in the shortlist as needed, nameless and
unfetchable, while five item tables carried the whole answer: item 18742,
`ClassNum` 881, resource `달과별의장식`, equip position mid, "Luar de Cristal" in
our own client, and the costume flag set on twRO and thRO. The art is in iRO's
and jRO's patches under `악세사리/남/남_달과별의장식.spr`.

So `viewsFromItems` closes the loop the other way: an item with a `ClassNum`
whose resource name is in neither sprite table still identifies its view, and
the **equip position** decides the namespace — garment is a robe, top/mid/low is
a headgear, and a weapon has neither (its `ClassNum` is that third space) and
stays out. The view id has to be one the sprite table does not already carry:
where both speak, the sprite table is the authority on its own namespace. Those
rows are written into `views.tsv`/`robes.tsv` with `source=item`.

It is a narrow rule, and the measurement is the reason to trust it: across the
five clients that ship an item table it places 78 headgear and 7 garment views,
of which **4 are views no sprite table named** — `acc:881`, `acc:883`,
`acc:1074` and thRO's `acc:2830 _Primordial_Weapons` — and the other ~2,000
items with a `ClassNum` and an unplaceable resource have no equip position
either.

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

### 2b. `renderable` — which view ids our own resolver can draw

```bash
node tools/multiserver/cli.mjs renderable                    # both tables, all of LATAM's views
node tools/multiserver/cli.mjs renderable --kind robe        # garments only
node tools/multiserver/cli.mjs renderable --limit 400 --job 4054
```

Writes `app/renderable.tsv`, which stage 3 reads. **This is the file that says
what we already have**, and it cannot be derived from any client's tables: it is
a fact about our own resolver and mirror, so the only way to get it is to ask
the gateway to render each view id and look at what came back.

`/image` answers **200 with the bare character** for a view id the resolver does
not know, byte for byte the same PNG as a request that asked for no headgear at
all, so neither the status code nor the content type can be read for an answer.
The probe therefore renders the bare character once per pose up front and
compares bytes.

It asks with a bare `headgear=<view>` / `garment=<view>` and **no sprite name**,
which is the whole point: the resolver's own table has to supply the art.
(`find-blank-visuals` asks the opposite question with the same machinery — see
5c — and passes the sprite explicitly.) A view that looks blank is retried
through ten poses before being called blank, because "the resolver has never
heard of this id" and "this sprite defines no frames that early" are different
facts and only the first means the art is missing. Only the blanks pay for the
extra nine: 400 views cost 427 renders.

**Both namespaces, and until 2026-11-20 only one of them was asked.** The probe
drove `headgear=` alone and the file carried no `kind` column, so stage 3 read
every row as an accessory view. No garment view was ever probed, which is not
the same as "no garment draws" but reads identically off the shortlist: all 338
of its `robe` rows said `listed`, `unprobed` or `absent`, never `draws` or
`blank`. Anyone counting "views our mirror draws that no catalogue lists" off
that column got **zero garments by construction** — and an audit did, before the
numbers below were measured by driving `garment=` by hand.

What the two tables actually say, over LATAM's 2,859 accessory and 330 garment
views: the garment half is **223 drawing, 107 blank**, and 76 of the drawing
ones are views `costumes.json` does not list. The row now leads with `kind`, and
a file written by the old tool is still read — as accessories, which is what
those rows meant.

The ladder is the same for both. Walking extra classes before calling a garment
blank looks obviously right — a garment is a folder with one sprite pair per
class and sex, so partial art is invisible on the wrong body — and was measured
away: every one of the 223 is settled on the asked-for class, and two more
classes changed no verdict while tripling what each blank costs. That case
belongs to `find-blank-visuals.mjs`, which renders a foreign mirror; this probe
asks our own resolver, whose tree is complete. The *pose* half does earn its
keep: 11 of the 223 draw nothing standing and appear only from action type 1 or
3 on, the school bags and the Poring bag among them.

This lived in the app's repository until 2026-11-20, which meant that re-running
it after a resolver rebake — a ragassets maintenance operation — needed a
checkout of the consumer. Shared machinery is in `renderprobe.mjs`.

### 3. `shortlist` — what is actually missing

```bash
node tools/multiserver/cli.mjs shortlist
```

Joins every catalogued client against two things that are not any client's
tables: the consumer's own list (`app/costumes.json`, copied into the state root
because ragassets does not own the consumer) and the render probe above
(`app/renderable.tsv`, which we do own). Writes one row per view id in the union
with a `need` column. Nothing is filtered out of the file — a stage that drops
rows is one you cannot audit.

The probe's verdicts are keyed `<kind>:<view>` like everything else here. They
were keyed `acc:<view>` unconditionally until 2026-11-20, which was correct for
what the probe then produced and wrong the moment it learnt to ask about
garments — see 2b for what that cost.

**The consumer's rows need the same care.** A slot normally says which namespace
a view id lives in, and reading it is right for 1,236 of the app's 1,239 items.
For the other three it is backwards, and the app says so with a `viewKind`
field — which it publishes *only* where it disagrees with the slot, so every row
that carries one was read wrong: "Buquê Gigantesco" equips in Baixo and its 128
is a robe, two shields equip in Capa and their 2827/2828 are accessory ids. Each
one marked a view listed that is a different costume in the other table, and
left the real one reading unlisted. `acc:128` is a worked example: it is the
Opera Phantom Mask, which we draw and do not list, and it read `listed` because
a bouquet cape borrowed its key.

Current numbers (8 clients catalogued, both namespaces probed): **3,272 view
ids** — 2,934 headgear and 338 garment — of which 1,239 are listed in the app,
**1,249 render on our mirror already**, 701 are named by our client but draw
nothing, and 83 are not in our client at all. `need` is **784**: 669 headgear
and 115 garment. The `viewKind` fix moved no row into or out of `need` — all
four misread views draw either way — so it corrects what the file says about our
own instance, not what the plan would fetch.

Probing the garment table moved that `need` by itself. It was 981, and **197 of
those views the plan wanted to fetch and did not need to** — 77 garments it
turns out we already draw, plus 120 headgears the probe had never reached
because the file on disk was a 400-view slice. Nothing moved the other way. On
this README's own per-garment average (~629 files, ~27 MB) those 77 are roughly
2 GB of planned download that was never needed.

Both inputs are optional and both change the answer, so a run without one says
so rather than reporting that every view in every client is missing.

### 3b. `slots` — which slot each costume equips in

```bash
node tools/multiserver/cli.mjs slots --origin all
```

The client's item table has **no equip-position field**. The position is written
in the item's *description text*, as a labelled line in that server's language.
The labels and values below were collected from the tables on disk, not guessed:

| | label | values |
|---|---|---|
| pt | `Posição :` / `Equipa em :` | `Topo` `Meio` `Baixo` `Capa`, joined by "e" or "," |
| zh | `位置 :` | `頭上` `頭中` `頭下` (head upper/middle/lower), `披肩` (shoulder cape) |
| en | `Position :` / `Location :` | `Upper` `Middle` `Lower` `Garment`, joined by ",", "&" or "." |
| th | `ตำแหน่ง :` | **English values**, with a Thai weight field after them |

Chinese joins with `/`, `、`, or nothing at all (`頭上中下`), and sometimes runs
into the next field with no separator (`頭上重量: 0`) — so the parser checks for
上/中/下 inside a 頭-prefixed value rather than matching whole words. English is
the opposite: `lower` contains `low` and `middle` contains `mid`, so those two
match on word boundaries, and `Locations :` — iRO's list of *towns* — is kept
out by the colon the label has to be followed by.

The last two rows of that table were missing until 2026-11-22, and reading pt
and zh only did not cost a handful of odd items. It cost **two whole clients**,
one of them the English one: iRO writes 1,906 + 2,457 position lines under its
two labels and thRO writes 3,169, and none of them was read. thRO is the sharper
lesson — a Thai label with an English value, so matching the label alone would
still have come back with nothing.

Five of the eight origins ship a readable item table: LATAM, twRO, twRO Zero and
thRO as `iteminfo_new.lub`, and **iRO under a name of its own**,
`System/itemInfo.lub`. jRO's legacy `.txt` pair carries no description and
kRO/kRO Zero ship no reachable modern table. This stage spent its first life
reading four of the five, because it asked for one filename instead of asking
`ITEM_INFO_FILES` in `iteminfo.mjs` which names exist — the same mistake that
module was written to record, made one directory away.

Item ids are global, so those five name **2,928 (kind, view) pairs** — 1,479
top, 458 mid, 698 low, 293 garment — well beyond the costumes they themselves
offer. Against the four-source index that preceded them: **+178 keys** (145 from
iRO, 31 from thRO, 2 from LATAM's two older labels), 55 keys whose slot changed,
and 3 keys retired by the rule below.

Each new one improves the *other* clients, because the `costume` flag is pooled
across every readable table and the name/id tie-break prefers a flagged id.
Adding thRO moved four published rows off the *base* item and onto the costume
(iRO's "Corsair" 5019 → 19619, three jRO rows gaining 「衣装」); adding iRO's moved
four more jRO rows, one of them off a 「レンタル衣装」 *rental* costume and onto the
permanent one. That is the strongest argument for adding an origin that brings
no artwork at all.

Where two clients disagree (459 pairs do), the earlier source wins and the
sources come in origin order, LATAM first: LATAM is the server the app
simulates, so where it defines a view it is the authority on that view. That
ordering takes agreement with the app's own database from 1,227/1,239 to
**1,231/1,239**; the ones that still differ are views where the app and this
index pick a different *item*, and the two items genuinely carry different slot
sets.

Adding iRO at rank 1 puts it above twRO on every view LATAM does not define,
which is what moved those 55 slots, so it was checked against a source outside
this pipeline: Divine-Pride's `equipLocation` bit field. Of the 1,805 index views
Divine-Pride is unanimous about, the two agree on 1,690, the **new value is right
on 82 and the old one on 4**, and 29 are wrong either way. On the 55 that moved
it is 29 to 4. The four where twRO was right and iRO is not — `acc:1082`
Deviruchi Balloon, `acc:1816` Dancing Butterfly, `acc:1694` Darkness Veil and
`acc:1725` Straight Long (Black) — are left as they are rather than special-cased:
the ordering is a rule about which client to believe, and it is 20:1 ahead.

**A slot names a position, not a sprite table.** `kindFromSlots` answers "which
table" from the slot alone, and for a few costumes the two disagree: the Costume
Whisper Candy Pouch equips in the garment position, so the slot said the robe
table, but its `_C_Halloween_Candypouch` is in the **accessory** table of all
eight clients and in no robe table at all. Keyed `robe:2579` it was a key no
client defines and the consumer can never join against, so a costume whose
position *had* been read still reached the app with none. `tableFor` gives way
only when the slot's table defines the view **nowhere** and the other one does —
14 items, 3 keys, all three the same ones the app marks with `viewKind`
(2579, 2827, 2828). A view both tables define is two different costumes and the
slot is the only thing that can tell them apart, so it is left alone.

This is product data, not just fetch order: the app needs a costume's slot to
show it at all. Measured on the 517 foreign rows the app publishes today, the
index knew the position of 337 and now knows 422; 375 confirm what the app shows,
**47 move it** (17 top→low, 16 mid→low, 13 top→mid, 1 top→garment), and 95 are
still named by no readable table — jRO exclusives, mostly, since jRO ships no
descriptions at all. Of the 47, Divine-Pride is unanimous about 16 and agrees
with the new value **16 times out of 16**.

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
for a garment, **or an effect folder with a `.str` in it, in either namespace** —
so a view that no origin can render is reported as unreachable *before* the
bytes are spent, instead of becoming a costume the catalogue throws away.

That last clause is the whole reason `.str` support took three passes to land.
An effect costume IS its animation: a `.str` and the textures it plays, with at
most a placeholder sprite. Demanding a `.spr` dropped the **candidate group**,
so the effect files the new targets had just found went with it and the plan
reported the view as carried by no archive at all — which is why the first
measurement said the effect tier reached only 2 of the 9. The test lives in two
places by necessity (here and `costumeDraws` in stage 5) and the two have to say
the same thing, or the plan promises what the catalogue rejects.

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
(`core`) from the effect files some hats carry (`effect`), so a fetch can start
with the cheap half.

**The effect tier could not see a `.str` at all**, and that took three fixes,
each of which looked like the whole answer on its own. A costume whose whole
visual is a `.str` animation — nine of the ones Divine-Pride lists and we do not
show — keeps it under `/texture/effect/efst_<sprite>/`, while `spriteTargets`
only ever reached `/sprite/이팩트/`, where a *sprite-shaped* effect lives.

1. `effectTargets` asks for the `.str` folder. On its own it changed **nothing**:
   `resolveOrigin`'s cheap gate was `/sprite/`, which dropped the new target
   before it was ever matched.
2. The gate takes `/texture/effect/` as well. Now the files are found — and the
   plan still came out with the same 513 covered views, because
   `originCanDraw` threw away every candidate group with no `.spr` in it, which
   is exactly what an effect costume is. See 4a above.
3. The folder name is not always prefixed. `robe:94 C_Rotating_Gears` ("Capa de
   Engrenagens") keeps its animation in `/texture/effect/C_Rotating_Gears/`,
   with no `efst_` at all, in four clients — and a second copy in
   `/sprite/로브/C_Rotating_Gears/`, which the ordinary garment target was
   already matching and `originCanDraw` was already rejecting.

The gate was `/texture/effect/efst_` — 1,798 rows in iRO's index and 2,014 in
twRO's, against 26,501 and 30,817 for the whole effect tree — and widening it to
the whole tree is what step 3 costs: one `includes` per row on ~57k extra rows
across eight clients, where the gate is the cheap test and the targets decide.

Two name forms are tried, because a costume and the ordinary hat it copies share
one effect folder, named after whichever came first: `_C_FlutterButterfly_BL`'s
is `efst_flutterbutterfly_bl`, with no `c_`. Over the shortlist's 3,242 sprite
names the exact form finds 40 folders and the variant takes it to 46, 120 MB.
The variant steals nothing: of the 39 folders claimed by more than one sprite
name, the 5 claimed by an exact and a stripped name are all the base/costume
pair of the same hat.

The stripped form is only ever asked for **with** the prefix. `efst_` keeps a
guess inside the costume-effect tree; `/texture/effect/` is the game's whole
effect library, where `rotating_gears` or `fire` is somebody else's folder with
hundreds of textures in it. So three names per sprite: `efst_<sprite>`,
`efst_<sprite minus c_>`, and `<sprite>`.

The first measurement of this said the folder name was usually wrong and the
nine costumes needed a hand mapping. That was wrong: `efst_C_Astra_Blessing`
(with `astra.str`) and `efst_C_Fluttering_Haze` are exactly `efst_` + the sprite
name, in six clients each, and both matched from the day the target was added.
What a path shape genuinely cannot reach is a costume whose effect our own
client maps by hand — `resources/effects/index.json` holds a `gold_shower` and a
`time_accessory` that look like two of the nine, under names no sprite gives.

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

**Two sources, and the second one is bigger than the first.** Everything above
describes a costume whose art this pipeline downloaded into a mirror. There is a
second kind, and until 2026-11-22 this stage could not see it at all: a view id
**our own instance already draws**, which the consumer simply does not list.
Stage 3 finds them — its `latam=draws` rows — and stage 4 then deliberately
leaves them out of the plan, because there is nothing to fetch. Having nothing
to fetch meant having no plan row, and this stage read the plan, so the one
costume it could never publish was the one that costs no download.

Those rows carry `local: true` and `origin: "latam"`. A consumer renders them
by view id through the ordinary route, with **no `origin`/`sprite` override**,
because the view id means the right thing in our own table — that is exactly
what the render probe measured. `--no-local` leaves them out, for comparing a
run against an older catalogue.

They also need the `costume` flag, now published on every row, because the two
sources sweep up different things: the mirror only ever held what stage 4 chose
to fetch, while a `latam=draws` row can be ordinary equipment our own client
happens to define. `acc:11` is the Biretta — it draws, it is named, and calling
it a costume would be wrong. The flag is absent, rather than false, when no
client that has the view ships one at all.

What it says today: **1,762 costumes, none skipped** — 663 from the mirror (the
plan and the catalogue agree exactly, which is the invariant `originCanDraw`
buys) and **1,099 from our own tree**, of which 788 have the costume flag, a name
and a slot. 1,696 are named, 1,135 carry an English identifier. By origin: LATAM
1,170, iRO 231, jRO 119, kRO Zero 113, twRO 64, twRO Zero 38, kRO 27. By slot:
top 751, low 492, mid 298, garment 144, and 176 whose slot no client states.

Of the 1,249 views stage 3 says we draw and the app does not list, 1,099 reach
the catalogue; the other 150 have no sprite name in any client's table, and the
sprite name is what the icon route is keyed by.

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

Each entry is `{kind, view, sprite, origin, origins, name, nameOrigin, names,
ids, aegis, slots, files}`, plus `blank: true` on the 17 that render nothing (stage
5b). `name` is whichever client names the item, which is not always the client
the art came from: an item id is global, so twRO can name a costume iRO
supplies. `aegis` is the English identifier, a translation base rather than a
display name.

#### `names` — what every client calls it

`name` answers "what is this costume called" with one string and the id of the
client it came from, which means this pipeline already chose the language. A
consumer that wants to pick differently — English first, say — cannot, because
the other six answers are gone by the time it reads the file. `names` keeps
them all:

```json
"names": {
  "iro": "Hair Band",
  "jro": "[衣装] ヘアバンド",
  "kro": "머리띠",
  "latam": "Faixa de Cabelo",
  "twro": "(服飾)髮箍",
  "twrozero": "髮箍"
}
```

Two properties a consumer should not have to guess at:

- **Display-ready.** `idnum2itemdisplaynametable.txt` stores names
  underscore-joined and the client renders them with spaces — the file reads
  `19507#Costume:_Shining_Sun#`, and 7,379 of iRO's 8,367 names carry an
  underscore against 132 carrying a space. That transform is applied here, per
  client, decided by whether that client was actually read through that file.
  The clients read through `iteminfo_new.lub` already hold spaced names and are
  left alone.
- **Marker-intact.** `(服飾)`, `[衣装]`, `Costume:` and `[Visual]` are the
  clients' own words for "costume version" and are published verbatim. This is
  deliberate: 465 of the 663 carry a marker on every name they have, so for
  those rows it is the only thing separating the costume from the base item of
  the same name, and stripping it upstream would be lossy and irreversible. A
  consumer that wants them gone has four patterns to strip and they are listed
  right here.

The key is **absent**, never empty, for a client that cannot name the costume —
`krozero` never appears at all, because kRO Zero ships no item table and no name
table, which is a different fact from "has no name for this one".

630 of the 663 carry `names`; 390 have one from more than one client. The join
is by **resource name**, not view id: a client's `items.tsv` maps item id →
resource name, a costume's resource name is its sprite, and `names.tsv` turns
the id into that client's display name. `counts.namesPerOrigin` reports what
each client could name: jRO 455, twRO 445, iRO 420, thRO 316, twRO Zero 216,
LATAM 76, kRO 71.

**English used to be the scarce one here, and it is not any more.** iRO named 99
of the 663 and was the only English client, which this file reported as a
property of the clients and a gap that could not be closed. Both halves of that
were wrong, for two different reasons, and both were found by measuring rather
than by reasoning about what a region ships.

**thRO's item table is in English**, not Thai — 18,843 of its 18,889 names are
pure ASCII, 28 carry any Thai script, and those 28 are local produce and
Ayothaya fishing gear. It names 316 of the 663.

**iRO's own table was ten years stale, and the pipeline's fault.** iRO stopped
patching `idnum2itemdisplaynametable.txt` on 2016-12-01; its current table is
`System/itemInfo.lub`, which no other client spells that way, and stage 2 only
ever looked for `iteminfo_new.lub`. The probe had already downloaded it 33
times. Reading it takes iRO from **99 names to 420**.

Together: an English-first picker now yields English on **464 of 663** rather
than 99, and rows with no name from any client fall from 58 to 33.
`docs/per-client-names.md` has all three measurements.

#### `ids` — the real item id, per client

A costume's id in the consuming app is synthetic (a base plus the view id) and
exists in no client's item table, so a link built from it is a guaranteed 404.
`ids` carries the number each client actually uses:

```json
"ids": { "latam": 2211, "iro": 2211, "kro": 2211, "jro": 20203, "twro": 20203 }
```

Same join and same key as `names`, and where a client appears in both, **the id
is the one that very name was read from** — they can never describe two
different items. `ids` is the wider of the two (634 rows against 630), because a
client can know an item without naming it.

The AegisName is not a substitute. Searching divine-pride for `Bird_Nest_Hat`
returns both 5183 and 20265 — the ordinary hat and the costume — with nothing
in the result saying which was meant. The number is unambiguous where the name
is not.

**The clients do not always agree, and the disagreement is usually meaningful.**
Of the 516 rows that carry an id from more than one client, 379 give the same
number everywhere and 137 differ. The breakdown that follows was classified by
hand on the 112 that differed **before thRO and iRO's real table arrived**; the
25 those two added were counted but not classified, so read the three numbers
below as a reading of that earlier set, not of all 137. 55 genuinely diverge —
twRO assigned
`_Low_Pony_BU` the id 31341 where jRO and LATAM use 31218, and both resolve to
"Costume: Low Pony (Blue)" on divine-pride, so both are right. The other 57 are
the tie-break showing through: a shared id exists, but for 51 of them it is the
*base* item — `_두건` is 2211, the ordinary Bandana, in the four clients that
never shipped the costume, and 20203, `Costume: Bandana`, in the two that did.
Collapsing those to the shared number would link the wrong thing, so the
per-client pick is kept and each client's answer published as its own.

A consumer that wants one link per costume rather than one per server should
take **the highest id in the object**: that lands on the costume item rather
than the base for 479 of the 489 rows where a costume id exists at all (98.0%),
measured before thRO and re-checked only in aggregate since.

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

The bare-character comparison, the pose ladder and the retry policy live in
`renderprobe.mjs`, shared with `renderable` (2b). The two tools ask opposite
questions — "does the resolver know this id?" versus "does this art, whose
location we already know, draw?" — with one mechanism.

### 5c. `diff-catalogues` — is a view id portable between servers?

```bash
node tools/multiserver/diff-catalogues.mjs latam jro [--kind robe] [--list]
node tools/multiserver/diff-catalogues.mjs a.tsv b.tsv --label-a X --label-b Y
```

The tool behind the decision that the catalogue publishes `<view>:<sprite>` and
tells the renderer the name. It answers two questions over two clients'
`catalog/<origin>/{views,robes}.tsv`: how many view ids both define with a
**different** sprite name, and how many sprite names sit at a different view id.

Measured across all seven origins against LATAM, the accessory namespace agrees
everywhere except jRO:

| against LATAM | both name a sprite | disagree | only one side names it |
|---|---|---|---|
| iRO, twRO, twRO Zero, kRO, kRO Zero, thRO | 2,734–2,859 | **0** | 0 |
| jRO | 2,799 | **2** | 1 |

Two is enough. `_C_L_Knitting_Low_Twin` and `_C_CLB_DT_TS_Hood` are different
sprites at the same ids in jRO (2007 and 2696), plus one garment — jRO's view
136 is `20th_Anniversary_Wing` where LATAM's is `C_20th_Anniversary_Wing`. A
bare view id from another server is therefore not safe, and the name is.

The third jRO row the app-repo original reported is view 880, which LATAM calls
`_1` and jRO's table leaves blank. That is not a disagreement about which sprite
an id is, and this version counts it separately — which is why that tool said 3
and this repo has always recorded 2.

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

## Putting the two stores on the origin box

The gateway serves two things this pipeline produces, and they get there by
different routes because only one of them can be rebuilt away from the machine
that planned it.

**`resources/icons-foreign/` — rebuilt on the box, from the committed plan.**
Planning needs every origin's path index (hundreds of MB of ledgers, built over
days) and the published catalogue. Fetching needs `icons-plan.tsv` and the
public patch servers, and nothing else. `icons-plan.tsv` is committed beside
this README for exactly that reason, so the box needs no index, no catalogue and
no file copied from a laptop:

```bash
cd ~/ragassets && git pull
mkdir -p ~/ro-multiserver && cp tools/multiserver/icons-plan.tsv ~/ro-multiserver/
node tools/multiserver/cli.mjs icons --from-plan --out ~/ragassets/resources/icons-foreign
```

About 20 minutes: 695 range reads at one request per second per host, 47 MB
transferred, no patch downloaded whole. It is resumable — the mirror under
`~/ro-multiserver/mirror/` is skipped on a re-run — and it writes only under
`--out`, so it cannot disturb the derived stores beside it. Re-run
`icons --plan-only` here and commit the new `icons-plan.tsv` whenever the
catalogue grows; the plan is a snapshot of where each icon was found, not a
live query.

**`resources/raw/foreign-costumes.json` — copied up.** It cannot be rebuilt on
the box at any cost: it is `catalogueFromDisk` over all seven mirrors plus every
client's name tables, which is the whole pipeline. That is the same deal as
`raw/mobs.json`, which is also produced off-box and shipped with the rest of
`resources/raw`.

**The unit file needs root, and the deploy deliberately does not install it.**
`deploy/deploy-from-ci.sh` ships code, never units — it warns when the checkout's
copy differs from the installed one and leaves it alone, because installing a
unit needs `sudo` and the CI key is confined to a forced command that cannot get
it. So `FOREIGN_ICONS_DIR` reaches the running service only when a human runs:

```bash
sudo install -m 0644 ~/ragassets/deploy/ragassets-gateway.service /etc/systemd/system/ragassets-gateway.service
sudo systemctl daemon-reload && sudo systemctl restart ragassets-gateway
```

Until then the route answers 404 for every sprite and says so at boot — which is
how every derived store behaves before it exists, and is why the consumer falls
back to a rendered thumbnail rather than breaking.

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
