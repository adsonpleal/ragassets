# Every client's name for a costume: why `names` looks the way it does

The measurement behind the catalogue's `names` field, taken 2026-11-19 against
the 663-costume catalogue, and kept because the numbers explain three decisions
that otherwise look arbitrary: why English is rare, why kRO Zero never appears,
and why the costume markers are left in.

The join is sprite → per-client item id (`items.tsv`) → per-client display name
(`names.tsv`), implemented in `tools/multiserver/clientnames.mjs`. It is the
same machinery that can recover a costume's real item id, measured at the same
time; that half is not published yet.

## Read this first: English is the scarcest name, not the most available

The requested order is English → Korean → Japanese → Chinese. It works, but
here is what it would actually produce across the 663:

| client | language | wins the pick |
|---|---|---|
| iro | **English** | **99** |
| kro | Korean | 5 |
| jro | Japanese | **366** |
| twro | Trad. Chinese | 108 |
| twrozero | Trad. Chinese | 27 |
| | | **605 named of 663** |

**So the app would show Japanese on 366 rows and English on 99.** That is not a
flaw in the ordering — it is that iRO's item table is small and old. It holds
8,367 names and reaches only 99 of our costumes, the same reason it resolved
only 100 item ids. Nothing among the six clients has broader English: there is
no second English source to fall back to. If English coverage is the actual
goal, this route does not deliver it and the gap is not closeable from these
clients.

Per-client naming power, independent of the order (how many each client *could*
name, not how many it has art for):

| client | language | can name | of 663 |
|---|---|---|---|
| jro | Japanese | 455 | 68.6% |
| twro | Trad. Chinese | 445 | 67.1% |
| twrozero | Trad. Chinese | 216 | 32.6% |
| iro | English | 99 | 14.9% |
| latam | Portuguese | 76 | 11.5% |
| kro | Korean | 71 | 10.7% |
| **krozero** | — | **0** | ships no item or name table at all |

**kRO Zero can never contribute a name.** It has neither `items.tsv` nor
`names.tsv`, and its stage-1 path index contains no `idnum2item*` and no
`iteminfo` entry. "Korean (kRO, then kRO Zero)" is really just kRO, which wins
only 5 picks once iRO has gone first.

## 1. Names from more than one client

**390 of 663 get a name from two or more clients.** 215 from exactly one, 58
from none. So the `names` object is worth having for 390 rows; for 215 it
carries a single key and for 58 it would be absent or empty.

## 2. What the currently-unnamed rows gain: almost nothing

63 of the 663 carry no `name` today. **Only 5 of them gain a name by this
route.** The other 58 are named by no client at all.

| sprite | art origin | names found |
|---|---|---|
| `_수녀모자` | krozero | iro: Coif · jro: [衣装] 修道女のヴェール · kro: 코이프 · latam: Chapéu de Freira · twro: 修女的帽子 |
| `_오크히어로투구` | krozero | iro: Helmet of Orc Hero · jro: オークヒーローの兜 · kro: 오크히어로의 투구 · latam: Elmo de Orc Herói |
| `_C_Halloween_Candy_Hair` | iro | jro: [衣装] ハロウィンキャンディヘア · latam: [Visual] Penteado de Halloween |
| `피아멧트의리본` | latam | iro: Ribbon Piamat · jro: [衣装] ボリュームピアメットリボン · latam: Laço Macabro |
| `C_PinkButterfly_Wing` | latam | jro: [衣装] フェアリーウィング(赤) · twro: (服飾)精靈粉蝴蝶翅膀 |

Both kRO Zero rows are the case worth noticing — a client read for art but not
for names, rescued because *other* clients name the same resource. There are
only two of them.

So, plainly: **the value of this field is the choice of language, not extra
coverage.** It moves naming from 600 to 605. Worth doing for the former, not
the latter — and worth stating here before anyone expects the sprite-name
fallbacks to shrink.

## 3. A detail that matters: the names need de-underscoring

`idnum2itemdisplaynametable.txt` stores names underscore-joined and the client
renders them with spaces. The raw file literally reads:

```
501#Red_Potion#
19507#Costume:_Shining_Sun#
```

7,379 of iRO's 8,367 names and 5,539 of kRO's 7,169 contain an underscore and
only 132 and 1 contain a space. The clients sourced from `iteminfo_new.lub`
(latam, twRO, twRO Zero) already hold spaced names, and jRO's table has no
underscores because Japanese needs none.

`clientnames.mjs` applies `_` → space to the clients read through that file,
which is why the samples read `Hair Band`, `Helmet of Orc Hero` and `외눈 안경`
rather than `Hair_Band`. Which clients those are is decided per run by whether
the file is among that origin's extracted copies, not by a hardcoded list, so a
client that moves to `iteminfo_new.lub` in a later patch stops being
transformed without anyone editing a constant. Publishing the raw underscored
form would push a client-rendering detail onto every consumer.

## 4. Costume markers

Most names carry a marker meaning "costume version", in the client's own
language:

| marker | occurrences |
|---|---|
| jRO `[衣装]` | 395 |
| twRO / twRO Zero `(服飾)` | 635 |
| iRO `Costume:` | 16 |
| LATAM `[Visual]` | 12 |

Out of 1,362 name strings in total. **465 rows have a marker on every name they
have**, so stripping markers is not cosmetic — for those rows it is the only
thing distinguishing the costume from the base item of the same name.

**The decision was to publish the string as the client gives it**, after the
underscore transform and with the marker intact. Three options were weighed —
keep, strip, or rewrite the three foreign markers into our own `[Visual]` — and
keep won: stripping upstream is lossy and irreversible, while a consumer that
wants them gone has exactly the four patterns above to match. Nothing
downstream strips them either, so what this field publishes is what a reader
sees.

## 5. Ambiguity

280 rows have at least one client offering more than one distinct name, because
several items share a sprite resource (`_햇` maps to six items). The tie-break
is the same one the id question uses: prefer the costume-flagged id from
`iteminfo_new.lub`, else the lowest id. Same caveat as there — 212 rows have
several flagged candidates and the rule is a convention, not a fact.

## The field as shipped

Additive: `name` and `nameOrigin` untouched, a new `names` object keyed by
origin, origins with no name simply absent.

```json
{
  "sprite": "_머리띠",
  "view": 9,
  "name": "Faixa de Cabelo",
  "nameOrigin": "latam",
  "names": {
    "iro": "Hair Band",
    "jro": "[衣装] ヘアバンド",
    "kro": "머리띠",
    "latam": "Faixa de Cabelo",
    "twro": "(服飾)髮箍",
    "twrozero": "髮箍"
  }
}
```

Notes on the shape:

- **Omit, do not null.** 58 rows would carry no `names` key at all; `krozero`
  never appears as a key.
- Names are display-ready (underscores already spaces), markers intact.
- `name`/`nameOrigin` keep their current meaning and their current picker, so
  nothing breaks while both exist. The two fields will disagree about which
  language is "best" — that is intended, since the new order differs from the
  catalogue's existing `NAME_ORDER` (which puts latam first).
- Size: 1,362 strings over 663 rows took the published file from 223,657 to
  302,048 bytes, +35%. Caddy gzips `/raw` and the route is
  `max-age=300, must-revalidate`, so the cost is small but not nil.

## Rebuilding it

Nothing new is extracted — `items.tsv` and `names.tsv` are already written by
stage 2 for six origins, and `clientnames.mjs` only joins them. So
`node tools/multiserver/cli.mjs publishable` regenerates the catalogue with the
field, and it prints `605 com nomes por cliente: {…}` as its own check.

Publishing it is a copy, not a deploy: `foreign-costumes.json` lives under
`resources/` on the box, which is gitignored there and which
`deploy/deploy-from-ci.sh` never writes, so a merge to `main` does not carry it
up. See `foreign-icons-on-the-box.md` in the session notes for that trap in
full.
