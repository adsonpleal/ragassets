# ragassets — a fast caching image/animation provider for Ragnarok Online sprites

`ragassets` is a thin, fast HTTP layer that renders and serves Ragnarok Online
sprites as images and animations, with aggressive on-disk caching so repeat
requests are served instantly. It also serves the client's **item, collection,
skill, class (job) and status-effect (buff/debuff) icons** as static transparent
PNGs — those are plain files extracted straight from the GRF, no rendering involved.

> **Rendering is done in-process by a native Go reimplementation of
> [zrenderer](https://github.com/zhad3/zrenderer)'s algorithm** (under
> `gateway/internal/render`): the SPR/ACT/PAL/IMF parsers, sprite compositing,
> z-ordering, palette application and APNG output. There is no separate renderer
> service — the gateway reads the extracted GRF assets and renders directly. The
> rendering logic is a faithful port of zhad3's [zrenderer](https://github.com/zhad3/zrenderer)
> (output is pixel-identical for player/monster sprites); huge thanks to zhad3 —
> please star and support the original project. See its
> [API docs](https://z0q.neocities.org/ragnarok-online-tools/zrenderer/api/).

---

## Live demo — free public instance

A free, best-effort public instance runs at **<https://assets.latam-tools.com.br>**.
You can use it right away — no API key, no sign-up — by pointing an `<img>` (or
anything) at it:

```html
<img src="https://assets.latam-tools.com.br/image?job=1002&action=0" alt="Poring">
```

It's a small hobby server with **no SLA** — it may be slow, rate-limited, or go
away at any time, so please don't build anything critical on it. For real or
heavy use, **self-host** (it's a few minutes with Docker — see [Running it](#running-it)).

### Gallery

The images below are served live by that instance (animations are APNG and play
in your browser):

| Poring · idle | Poring · attack | Dragon Knight · idle |
|:---:|:---:|:---:|
| ![Poring idle](https://assets.latam-tools.com.br/image?job=1002&action=0) | ![Poring attack](https://assets.latam-tools.com.br/image?job=1002&action=16) | ![Dragon Knight idle](https://assets.latam-tools.com.br/image?job=4252&head=1&action=0&frame=0) |
| **Dragon Knight · attack** | **Arch Mage ♀** | **Custom Swordman ♀** |
| ![Dragon Knight attack](https://assets.latam-tools.com.br/image?job=4252&head=1&action=40) | ![Arch Mage](https://assets.latam-tools.com.br/image?job=4255&gender=female&head=3&action=0&frame=0) | ![Custom Swordman](https://assets.latam-tools.com.br/image?job=1&gender=female&head=4&headgear=4,125&garment=1&weapon=1&action=0&frame=0) |

The last three are 4th-class and customized **player** sprites; the first row are
monsters. Every one is just a URL — see the [API](#get-image) below.

---

## How it works

```
client ──GET /image?job=1002&...──▶  gateway (Go)
                                       │  render in-process, stream bytes
                                       │  (internal/render: parse SPR/ACT/PAL/IMF,
                                       │   composite layers, z-order, APNG encode)
                                       ▼
                              immutable bytes + ETag → browser/CDN caches them
```

- **Renders are served directly; caching is delegated to the client.** The
  gateway keeps **no disk cache** — every render is fast and in-process. Each
  response carries `Cache-Control: public, max-age=31536000, immutable` and an
  `ETag` derived (order-independently) from the query string, so browsers and
  CDNs cache them forever and a revalidating client gets a `304` (answered
  without re-rendering).
- **Images vs. animations.** A multi-frame render is composited into a single
  **animated PNG (APNG)**; a single frame is a normal PNG. The gateway serves
  both as `Content-Type: image/png` (modern browsers animate APNG natively).
  - Pass an **`action`** (and no `frame`) → you get the **animation** (APNG).
  - Specify a **`frame`** → you get a **single still image**.
  - Neither → a single still image (frame `0`).
  - Want a **GIF** instead? Send the same request to **`/gif`** rather than
    `/image` (see [`GET /gif`](#get-gif)). The APNG→GIF conversion is the only
    image processing on top of rendering.
- **Concurrent requests for the same URL trigger exactly one render** (in-process
  single-flight); parsed sprite/palette resources are cached in memory and reused
  across requests.
- **`GET /icons/*` is plain static file serving** — the icons are extracted
  once from the client GRF by `extract-grf.mjs --icons` (see
  [GRF extraction](#resources--grf-extraction-required)); no rendering involved.

## API

### `GET /image`

Renders a sprite. Every meaningful render parameter is available as a query
parameter:

| Query param | Type | Notes |
|---|---|---|
| `job` | comma-separated IDs | **Required.** e.g. `job=1002` or `job=1002,1003` |
| `action` | integer | Animation/action index. Its presence (without `frame`) yields an animation. |
| `frame` | integer | A specific frame → a still image. `-1` = all frames (animation). |
| `gender` | `male`/`female` or `1`/`0` | Default male. |
| `head` | integer | Player head id. |
| `outfit` | integer | Alternate outfit (`0` = default). |
| `headgear` | comma-separated ints | Up to 3, e.g. `headgear=4,125`. |
| `headgearBehind` | comma-separated ints | **Usually unnecessary** — whether an effect headgear (aura/halo/the Sun God's Ornament `2669`) draws behind the character is decided automatically per direction from the client's layer-priority table. This param is a manual override that forces the listed ids behind in every direction (for accessories the client table doesn't cover). |
| `garment` | integer | |
| `weapon` | integer | |
| `shield` | integer | |
| `bodyPalette` | integer | `-1` = standard. |
| `headPalette` | integer | `-1` = standard. |
| `headdir` | `straight`/`left`/`right`/`all` or `0`/`1`/`2`/`3` | Default all. For stand/sit, `straight`/`left`/`right` pin the head to that facing across the whole animation (the body still animates); `all` cycles the head through directions. |
| `madogearType` | `robot`/`suit` or `0`/`2` | |
| `enableShadow` | boolean | `true`/`false`. |
| `canvas` | string | `WxH±X±Y`, e.g. `canvas=200x200+75+175`. |
| `outputFormat` | `png`/`zip` or `0`/`1` | Default `png`. `zip` returns a ZIP of PNGs. |

> Deployment-level settings (resource path, port) are configured via environment
> variables, not query parameters.

A missing or malformed `job`/parameter returns `400`. A render failure (e.g. a
job whose sprite isn't in the extracted assets) returns `500`.

### Examples

```
/image?job=1002                          # still Poring
/image?job=1002&action=0                 # animated Poring (APNG)
/image?job=1002&action=0&frame=2         # a single frame of that action
/image?job=1&gender=female&headgear=4,125&garment=1&weapon=2&head=4&action=32
/image?job=0&canvas=200x200+75+175&action=93
```

### Understanding `action` (animations & directions)

zrenderer has no flat list of named actions: the `action` number is an **index
into the sprite's `.act` file**, and it encodes **two things at once**:

```
action = (animation type × 8) + direction
```

Every animation is stored as 8 directional variants (one per 45°), so actions
come in blocks of 8.

**Direction** (the `+0…7` part) — `0` faces south/front, then rotates 45° each step:

| 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| S | SW | W | NW | N | NE | E | SE |

(Conventional order — easiest to confirm by rendering `frame` 0–7 of a block.)

**Animation type** (the `× 8` part) depends on the sprite kind.

Players / jobs (rich set):

| Type | `action` (south-facing) | Meaning |
|---|---|---|
| 0 | 0 | Idle / stand |
| 1 | 8 | Walk |
| 2 | 16 | Sit |
| 3 | 24 | Pick up |
| 4 | 32 | Standby (ready to fight) |
| 5 | 40 | Attack |
| 6 | 48 | Hurt (took damage) |
| 7 | 56 | Frozen / stun |
| 8 | 64 | Dead |
| 9 | 72 | Frozen 2 |
| 10–12 | 80 / 88 / 96 | Attack variants 1–3 (weapon-dependent) |

Monsters (only ~5 blocks):

| Type | `action` | Meaning |
|---|---|---|
| 0 | 0 | Idle |
| 1 | 8 | Walk |
| 2 | 16 | Attack |
| 3 | 24 | Hurt |
| 4 | 32 | Dead |

So `action=18` is "walk, facing west" for a monster (`8 + 2`), and the zrenderer
examples line up: `--action=16` is a monster attack, `--action=32` a player
standby pose, `--action=93` a player attack variant (`88 + 5`) facing direction 5.

> NPCs, homunculi, mercenaries, pets and mounts each have their own (usually
> smaller) tables. The real source of truth is always the individual sprite's
> `.act` file — zrenderer renders whatever index exists in it, so the valid range
> varies per sprite.

Note: body direction is part of `action`; the separate `headdir` parameter only
rotates the **head**.

### `GET /gif`

Exactly like [`GET /image`](#get-image) — **every query parameter above works the
same way**, including the still-vs-animation rule — except the rendered PNG/APNG
is converted to a **GIF** before it's served (`Content-Type: image/gif`):

- An **`action`** (and no `frame`) → an **animated, infinitely-looping GIF**.
- A **`frame`** (or neither) → a **single-frame GIF** (a still image).

```
/gif?job=1002&action=0                   # animated Poring, as a GIF
/gif?job=1002                            # still Poring, as a GIF
/gif?job=4252&head=1&action=40           # Dragon Knight attack, as a GIF
/gif?job=1&gender=female&headgear=4,125&garment=1&weapon=2&head=4&action=32
```

Use this for clients that can't display APNG (some chat embeds, link-preview
crawlers, older image tooling). Two caveats are inherent to the GIF format:

- **Hard-edged transparency.** GIF has a single fully-transparent palette index,
  not an alpha channel, so the sprite's soft (antialiased) edges harden. Prefer
  `/image` (APNG) when you can keep crisp edges.
- **256 colors per frame.** Each frame is quantized to its own ≤256-color
  palette (with a reserved transparent slot). RO sprites usually fit comfortably,
  so quality stays high.

The same immutable cache headers and `ETag`/`304` support as `/image` apply. The
only parameter that behaves differently is **`outputFormat`**: `zip` is rejected
(`400`), since the response is always a single GIF image.

### `GET /icons/{type}/{name}.png`

Serves a static image extracted from the client GRF (see
[GRF extraction](#resources--grf-extraction-required) — this endpoint returns
`404` until you run the `--icons` extraction step):

| `type` | What you get | `name` |
|---|---|---|
| `item` | Inventory icon (~24×24) | item id |
| `collection` | Larger item description image (~75×100) | item id |
| `skill` | Skill icon (~24×24) | skill id |
| `job` | Class/job icon | job id |
| `status` | Status-effect (buff/debuff) icon (32×32) | EFST status id |
| `ui` | Character-creation UI element | client filename (see below) |

```
/icons/item/501.png          # Red Potion inventory icon
/icons/collection/501.png    # Red Potion description image
/icons/skill/28.png          # Heal
/icons/job/4252.png          # Dragon Knight
/icons/status/883.png        # Poison status icon
/icons/status/876.png        # Freezing status icon
/icons/ui/bt_female_on.png   # gender toggle, female, selected
```

The source images carry transparency either via a magenta (`#FF00FF`) colorkey
(item/collection/skill/job/ui BMPs) or a real alpha channel (status-effect TGAs);
the extractor normalizes both to a PNG alpha channel. Responses carry the same
immutable cache headers and `ETag`/`304` support as `/image`. Unknown names
(or types) return `404`.

The `status` type is keyed by the client's **EFST** status id (the numeric ids in
`luafiles514/.../stateicon/efstids.lub`). Not every EFST has an icon — only those
the client maps to an image in `stateiconimginfo.lub` are served.

The `ui` type exposes the character-creation screen's elements under their
original client filenames:

| Element | Names |
|---|---|
| Gender toggle | `bt_male_<state>`, `bt_female_<state>` with states `off` (idle), `on` (selected), `over` (hover), `press` |
| Rotation arrows | `bt_leftturn_<state>`, `bt_rightturn_<state>` with states `normal`, `over`, `press` |
| Hair styles — human | `img_hairstyle01`…`img_hairstyle23` (male), `img_hairstyle_girl01`…`girl23` (female), `img_hairstyle_none` |
| Hair styles — doram | `img_hairstyle_doramboy01`…`06`, `img_hairstyle_doramgirl01`…`06` |
| Hair colors | `color01`…`color09` with states `off`, `on`, `over`, `press` (e.g. `color03_on`) |
| Misc | `bt_make_*`, `bt_close_*`, `bt_doublecheck_*`, `bt_hairstyle_*`, `img_human_on/off`, `img_doram_*`, `bg_makebg` |

### `GET /effects/...` — effect-only costumes

Some costumes have **no character sprite** — auras, falling petals, spotlights,
ghosts, weather. The client draws them with its `.str` world-effect system, so the
sprite renderer above can't produce them. `extract-grf.mjs --effects` pulls each
one's `.str` out of the GRF as a small JSON + PNG bundle (see
[GRF extraction](#resources--grf-extraction-required)); the gateway serves those
bundles for the [latamvisuais](https://github.com/adsonpleal/latamvisuais) map
simulator to render client-side. These endpoints return `404` until you run the
`--effects` step.

| Path | What you get |
|---|---|
| `GET /effects/index.json` | Catalogue: `{"items":[{"id","name","slots","effect"}]}` — one entry per effect-only costume (`effect` is the bundle key; there is no character `view`). |
| `GET /effects/{key}/effect.json` | The parsed `.str` animation: `{"key","fps","maxKey","layers":[{"textures":[…],"anims":[…]}]}`. |
| `GET /effects/{key}/tex_N.png` | That effect's layer textures (TGA alpha kept; BMP magenta-keyed → alpha). |
| `GET /effects/sprites/{key}/sprite.json` | A sprite-based map effect's play list: `{"frames":["0.png",…],"delays":[…]}` (frames in play order; per-frame delay in ms). |
| `GET /effects/sprites/{key}/N.png` | That sprite effect's rendered frames. |

```
/effects/index.json
/effects/c_spot_light/effect.json
/effects/c_spot_light/tex_0.png
/effects/sprites/torch_01/sprite.json
/effects/sprites/torch_01/0.png
```

`key` is a costume resource-name slug (`[a-z0-9_]`); the few Korean-named effects
get an ASCII key from their `.str` folder instead (e.g. `angel_fluttering`).
Responses carry the same immutable cache headers, `ETag`/`304` and wildcard CORS as
`/icons`. Not every effect-only costume resolves to a `.str` automatically — the
extraction step prints a resolved/unresolved/excluded report and a manual override
table covers the rest (see below).

The same `--effects` step also builds bundles for the **in-world map effects** — the
`.str` effects a map's `.rsw` places (underwater bubbles, etc.; see
[`/maps`](#get-maps--world-maps) `manifest.effects`). These share the `/effects/{key}/`
format above, keyed by the `.str` basename (e.g. `bubble1`). The id→`.str` mapping is
the STR-type subset of roBrowser's `EffectTable.js`, ported into `extract-grf.mjs`; a
bundle is built for every servable STR effect in that table, so any map's effect
references resolve.

A handful of map effects are **played sprites** (`.spr`/`.act`) rather than `.str` —
`EF_TORCH`, `EF_SMOKE` and `EF_BANJJAKII`. The `--effects` step renders each into a
`/effects/sprites/{key}/` bundle: one `N.png` per truecolor `.spr` frame plus a
`sprite.json` `{frames, delays}` play list (per-frame delay from the `.act`, default
`100`ms). A map's `manifest.effects` references these by `key` in a `sprite` field
(see [`/maps`](#get-maps--world-maps)).

### `GET /maps/...` — world maps

The full 3D world maps (ground mesh, models, textures, animated water) for the
[latamvisuais](https://github.com/adsonpleal/latamvisuais) map simulator to render
client-side. `extract-grf.mjs --maps` pulls every map's `.gat`/`.gnd`/`.rsw`
geometry plus the `.rsm` models and BMP/TGA textures they reference (see
[GRF extraction](#resources--grf-extraction-required)). The geometry binaries are
served raw (parsed in the browser); models, textures, water frames and the shared
cursor/grid UI are **de-duplicated** across all maps (922 in the current client)
into content-addressed stores, so each blob is stored and served exactly once —
keeping the whole set to ~5.8 GB instead of the ~10–15 GB a per-map copy would
cost. These endpoints return `404` until you run the `--maps` step.

| Path | What you get |
|---|---|
| `GET /maps/index.json` | Catalogue: `{"maps":[…]}` — every extracted map name. |
| `GET /maps/{map}/manifest.json` | The map's asset manifest: `files` (geometry), `models`, `textures`, `water`, `ui` — resource names mapped to shared blob paths (`../_t/<hash>.png`, …) — plus `fog` (`{near,far,color:[r,g,b],factor}`, present only for maps listed in `data/fogparametertable.txt`) and `effects` (the `.rsw` in-world effects — `.str` bundles, played sprites, procedural `FUNC` effects and parametric emitters; present only for maps that place any). |
| `GET /maps/{map}/{map}.gat\|gnd\|rsw` | Raw geometry binaries (altitude, ground mesh, world objects). |
| `GET /maps/_t/{hash}.png` | A shared texture (TGA alpha kept; BMP magenta-keyed → alpha, fringe-bled). |
| `GET /maps/_m/{hash}.rsm` | A shared model (raw `.rsm`). |
| `GET /maps/_w/{hash}.jpg` | A shared animated-water frame. |
| `GET /maps/_u/{hash}.png` | A shared UI image (hover-cell grid selector / cursor frame). |

```
/maps/index.json
/maps/prontera/manifest.json
/maps/prontera/prontera.gnd
/maps/_t/a6abef1ba59fbf23.png
```

The manifest references blobs with a leading `../` so the browser fetches them as
`baseUrl + path` and the URL parser folds the `..` to resolve against the shared
store. Map names are lowercase slugs (`[a-z0-9_@-]`); blob hashes are 16 hex chars
— the strict per-segment patterns make path traversal structurally impossible.
Responses carry the same immutable cache headers, `ETag`/`304` and wildcard CORS as
`/icons` and `/effects`.

When a map's `.rsw` places in-world effects, the manifest carries an `effects`
array — one entry per placed instance (positions are **not** deduplicated; the client
proximity-culls). There are four renderable kinds:

```json
"effects": [
  { "id": 109, "pos": [x, y, z], "str": ["bubble1","bubble2","bubble3","bubble4"], "delay": 0, "param": [0,0,0,0] },
  { "id": 47,  "pos": [x, y, z], "sprite": "torch_01", "delay": 125, "param": [1,0,0,0] },
  { "id": 45,  "pos": [x, y, z], "delay": 500, "param": [0.1,0.1,0,0] },
  { "id": 974, "pos": [x, y, z], "delay": 1, "param": [0,0,0,0],
    "emitter": { "dir1": [-3,-5,-3], "dir2": [5,0,5], "gravity": [0.7,-2,0.7], "color": [255,255,255,255],
                 "rate": [1,3], "size": [6,8], "life": [3,4], "texture": "../_t/<hash>.png",
                 "speed": [0], "srcmode": [5], "destmode": [2], "maxcount": [20], "zenable": [1] } }
]
```

`id` is the `.rsw` effect id and `pos` is the ÷5 world position.

- **STR effects** carry `str` — the id's deduped set of
  [`/effects/{key}/`](#get-effects--effect-only-costumes) bundle keys (resolved via the
  ported `EffectTable.js` STR subset) the client picks from at random per spawn.
  `iz_dun03`, for instance, places 312 of `id 109` (`EF_BUBBLE` → `bubble1`…`bubble4`).
- **Sprite effects** carry `sprite` — the key of a
  [`/effects/sprites/{key}/`](#get-effects--effect-only-costumes) bundle (a played
  `.spr`/`.act`). `EF_TORCH` (`47` → `torch_01`), `EF_SMOKE` (`44` → `smoke`) and
  `EF_BANJJAKII` (`165` → `banjjakii`). `iz_dun00`, for instance, places 53 of `id 47`.
- **Procedural `FUNC` effects** carry no asset field — just `id`/`pos`/`delay`/`param`;
  the client generates them itself. `45` `EF_FIREFLY` is the one baked (`iz_dun00` places
  369 of them).
- **Parametric emitters** — `EF_EMITTER` (`974`), `EF_ANIMATED_EMITTER` (`1073`) and
  `EF_MAGIC_FLOOR` (`1025`) are not `.str` files; their particle spec lives per-map in
  the client's `effecttool/<map>.lub` (a parsed Lua emitter table). Each placement is
  matched to its lub entry by horizontal (X/Z) position and the spec is baked inline as
  `emitter` (a `texture` field is rewritten into the shared `_t` store; magic-floor
  entries carry `Speed`/`Size`/`Angle`/`RiseAngle`/`Alpha`/`Height0…20` instead).

Any other id — the classic hardcoded ambient effects (forest lights, light pillars, …)
the client draws procedurally with no shippable data — is skipped.

### `GET /bgm/...` — per-map background music

Each world map's background-music track, for a client to play alongside the map
simulator. `extract-grf.mjs --bgm` reads the client's `data/mp3nametable.txt`
(which maps `<map>.rsw` → a track in the `bgm\` folder) and copies the referenced
`.mp3` files out of the client's loose `BGM/` folder (they live next to the GRF,
not inside it — see [GRF extraction](#resources--grf-extraction-required)). Many
maps share one track, so tracks are **de-duplicated** by their (numeric) filename
and each is stored and served once (~325 MB / ~183 tracks for the current client,
covering ~1080 maps). These endpoints return `404` until you run the `--bgm` step.

| Path | What you get |
|---|---|
| `GET /bgm/index.json` | Catalogue: `{"maps":{"<map>":"<track>.mp3",…}}` — every mapped map name → its track filename. |
| `GET /bgm/{track}.mp3` | One background-music track (`audio/mpeg`). |

```
/bgm/index.json
/bgm/210.mp3
```

Track names are numeric slugs (`[0-9a-z_-].mp3`) — the strict filename pattern
makes path traversal structurally impossible. Responses carry the same immutable
cache headers, `ETag`/`304` and wildcard CORS as `/maps`.

### `GET /healthz`

Liveness check — returns `200 ok`.

## Running it

A single self-contained service, built from `./gateway`, that renders in-process
and reads assets from `./resources`.

```bash
# 1. Provide game assets (see "Resources" below) into ./resources
# 2. Bring it up
docker compose up --build
```

- The gateway is published on **`http://localhost:8080`** (override with
  `GATEWAY_PORT`, see `.env.example`).
- `./resources` is mounted read-only at `/resources` (set via `RESOURCE_DIR`).
  There is no render cache to persist — renders are served directly and cached by
  the client (see [How it works](#how-it-works)).

### Layout

```
docker-compose.yml        # the gateway service
gateway/                  # the Go gateway + in-process renderer (this project)
gateway/internal/render/  # the native zrenderer reimplementation (parsers, raster, engine)
gateway/cmd/gen-resolver/ # offline tool: bakes id→sprite-name tables from the client .lub
resources/                # YOUR extracted GRF assets (git-ignored, not distributed)
resources/icons/          # static icons (extract-grf.mjs --icons), served at /icons/*
resources/effects/        # effect-only costume bundles (extract-grf.mjs --effects), served at /effects/*
resources/maps/           # world-map bundles (extract-grf.mjs --maps), served at /maps/*
resources/bgm/            # per-map background music (extract-grf.mjs --bgm), served at /bgm/*
extract-grf.mjs           # helper to extract a GRF into resources/
```

## Resources / GRF extraction (required)

**This project distributes no Ragnarok Online game assets.** To render anything,
the gateway needs the sprite/palette data from a Ragnarok Online client's GRF
archive, extracted into `./resources`. **You must extract your own GRF** from a
client you are entitled to use.

A standalone extractor, `extract-grf.mjs`, is included. It needs only **Node 18+**
(no dependencies) and reads Gravity's GRF/GPF formats — including the custom
`0x300` "Event Horizon" fork used by recent official clients, with the per-entry
DES decryption that the standard tools can't handle.

Extract exactly the directories zrenderer needs into `./resources`:

```bash
node extract-grf.mjs --extract resources --grf path/to/data.grf \
  --match "data\\(sprite|palette|imf|luafiles514)\\"
```

This populates `resources/data/sprite`, `resources/data/palette`,
`resources/data/imf`, `resources/data/luafiles514`, etc., which the gateway reads
via `RESOURCE_DIR` (default `/resources` in the container). The headgear/garment
ID→sprite-name tables are baked from the client `luafiles514/.lub` into the binary
by `gateway/cmd/gen-resolver` — re-run it when you update the client (see that
directory's `dump.lua` and `main.go`).

To serve the static icons (`/icons/*`), run the icon extraction step too:

```bash
node extract-grf.mjs --icons resources/icons --grf path/to/data.grf
```

This decodes the item/collection/skill/job icon BMPs (keyed by numeric id), the
status-effect icon TGAs (keyed by EFST id) and the character-creation UI elements
(keyed by their client basename) into transparent PNGs under
`resources/icons/{item,collection,skill,job,status,ui}/`, which the gateway serves
directly. Item ids are resolved via `System/iteminfo_new.lub` (found automatically
next to the GRF; override with `--iteminfo <path>`), skill ids via `skillid.lub`,
and status icons via the `stateicon/efstids.lub` + `stateicon/stateiconimginfo.lub`
tables — all inside the GRF. Rerunning overwrites in place.

To serve the effect-only costumes (`/effects/*`), run the effect extraction step:

```bash
node extract-grf.mjs --effects resources/effects --grf path/to/data.grf
```

This enumerates the costumes that have **no character sprite** (drawn by the
client's `.str` world-effect system) from `System/iteminfo_new.lub`, maps each to
its `.str` in the GRF, and writes a per-effect bundle (`effect.json` describing the
keyframe animation + the `tex_N.png` textures it references) under
`resources/effects/<key>/`, plus the catalogue `resources/effects/index.json`. It
prints a **resolved / unresolved / excluded** report: the "invisible" gear-hiding
costumes are excluded (no visual), and a handful of Korean-named or EXE/shared-bound
effects (the level auras, magic circles, …) whose `.str` path isn't derivable from
the resource name stay unresolved — those are filled in by hand via the
`STR_OVERRIDE` table near the top of the effects section in `extract-grf.mjs`.

The same run then builds the **in-world map effects**: for every servable STR entry
in the ported `EffectTable.js` table (`EFFECT_STR_TABLE`), it resolves the `.str` in
the GRF and writes a `resources/effects/<basename>/` bundle (same format), so the
`.rsw` effects a map places — see [`/maps`](#get-maps--world-maps) `manifest.effects`,
e.g. `iz_dun03`'s `bubble1`…`bubble4` — resolve. `%d`/`rand` names expand to one
bundle each; Korean-named (unservable) STR effects are skipped. The run also renders
the **sprite-based** map effects (`SPRITE_EFFECT_TABLE`: `EF_TORCH`/`EF_SMOKE`/
`EF_BANJJAKII`) into `resources/effects/sprites/<key>/` — one `N.png` per `.spr` frame
plus a `sprite.json` play list — so a map's `sprite` effect references resolve.

To serve the world maps (`/maps/*`), run the map extraction step:

```bash
node extract-grf.mjs --maps resources/maps --grf path/to/data.grf
# or just one map:
node extract-grf.mjs --maps resources/maps --grf path/to/data.grf --map prontera
```

This enumerates every `data/<name>.rsw` in the GRF and, for each map, writes the
raw `.gat`/`.gnd`/`.rsw` geometry and a `manifest.json` under
`resources/maps/<name>/`, while the `.rsm` models, BMP/TGA textures (converted to
transparent PNG), animated-water JPGs and the shared cursor/grid UI are
de-duplicated by content hash into the shared stores `resources/maps/{_m,_t,_w,_u}/`
— so identical assets shared between maps are written once. A catalogue
`resources/maps/index.json` lists every map. Maps missing a required geometry file
are skipped (reported at the end — in the current client 17 of 939 `.rsw` entries
are ground-mesh-less server/template maps, leaving 922 extracted). A full run with no `--map` rebuilds the whole
tree from scratch; `--map <name>` refreshes just that map and merges it into the
existing `index.json`.

To serve the per-map background music (`/bgm/*`), run the BGM extraction step:

```bash
node extract-grf.mjs --bgm resources/bgm --grf path/to/data.grf
# the .mp3 tracks live in the client's BGM/ folder next to the GRF; override with:
node extract-grf.mjs --bgm resources/bgm --grf path/to/data.grf --bgmsrc path/to/BGM
```

This reads `data/mp3nametable.txt` from the GRF (the client's `<map>.rsw → bgm\<file>.mp3`
table) and copies each referenced track out of the client's loose `BGM/` folder —
the `.mp3` files are **not** inside the GRF — into `resources/bgm/`, de-duplicated by
filename (many maps share one track). It writes `resources/bgm/index.json` mapping
each map name to its track. A full run rebuilds the directory from scratch.

Other modes:

```bash
# List every entry in a GRF (filename, size, flags):
node extract-grf.mjs --list path/to/data.grf

# Dump a single file to stdout (use forward slashes in the path):
node extract-grf.mjs --dump path/to/data.grf::data/sprite/some_file.spr > some_file.spr
```

The `--match` value is a JavaScript regex tested case-insensitively against each
stored filename. Stored names use **backslash** separators, so escape them
(`data\\sprite\\`).

## Credits & license

- **[zrenderer](https://github.com/zhad3/zrenderer)** by **[zhad3](https://github.com/zhad3)**
  — the original D renderer this project's `internal/render` engine is ported
  from. All the hard-won RO sprite knowledge (formats, layering, head direction)
  is theirs; please star and support it.
- The GRF extractor's DES routine is ported from
  **[grf-loader](https://github.com/vthibault/grf-loader)** (MIT). The GRF reader,
  the icon pipeline and the mini Lua 5.1 VM originate from
  `adsonpleal/ragreplaystats`.
- Ragnarok Online and its assets are © Gravity Co., Ltd. No game assets are
  included in or distributed by this repository.

This project is licensed under the **[MIT License](LICENSE)** — do whatever you
want with it.
