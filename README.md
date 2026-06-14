# ragassets — a fast caching image/animation provider for Ragnarok Online sprites

`ragassets` is a thin, fast HTTP layer that renders and serves Ragnarok Online
sprites as images and animations, with aggressive on-disk caching so repeat
requests are served instantly. It also serves the client's **item, collection,
skill and class (job) icons** as static transparent PNGs — those are plain
files extracted straight from the GRF, no rendering involved.

> **All of the actual rendering is done by [zrenderer](https://github.com/zhad3/zrenderer)
> by [zhad3](https://github.com/zhad3).** This project is *just a caching gateway on
> top of it* — it maps URL query parameters to a zrenderer render request, asks
> zrenderer to render, then caches and serves the bytes. Huge thanks to zhad3 for
> zrenderer; please star and support the upstream project. See its
> [API docs](https://z0q.neocities.org/ragnarok-online-tools/zrenderer/api/).

---

## Live demo — free public instance

A free, best-effort public instance runs at **<https://ragassets.duckdns.org>**.
You can use it right away — no API key, no sign-up — by pointing an `<img>` (or
anything) at it:

```html
<img src="https://ragassets.duckdns.org/image?job=1002&action=0" alt="Poring">
```

It's a small hobby server with **no SLA** — it may be slow, rate-limited, or go
away at any time, so please don't build anything critical on it. For real or
heavy use, **self-host** (it's a few minutes with Docker — see [Running it](#running-it)).

### Gallery

The images below are served live by that instance (animations are APNG and play
in your browser):

| Poring · idle | Poring · attack | Dragon Knight · idle |
|:---:|:---:|:---:|
| ![Poring idle](https://ragassets.duckdns.org/image?job=1002&action=0) | ![Poring attack](https://ragassets.duckdns.org/image?job=1002&action=16) | ![Dragon Knight idle](https://ragassets.duckdns.org/image?job=4252&head=1&action=0&frame=0) |
| **Dragon Knight · attack** | **Arch Mage ♀** | **Custom Swordman ♀** |
| ![Dragon Knight attack](https://ragassets.duckdns.org/image?job=4252&head=1&action=40) | ![Arch Mage](https://ragassets.duckdns.org/image?job=4255&gender=female&head=3&action=0&frame=0) | ![Custom Swordman](https://ragassets.duckdns.org/image?job=1&gender=female&head=4&headgear=4,125&garment=1&weapon=1&action=0&frame=0) |

The last three are 4th-class and customized **player** sprites; the first row are
monsters. Every one is just a URL — see the [API](#get-image) below.

---

## How it works

```
client ──GET /image?job=1002&...──▶  gateway (Go)        ──POST /render──▶  zrenderer
                                       │  cache hit? serve instantly         (does the work,
                                       │  miss? render once, cache, serve     writes PNG/APNG)
                                       ▼
                                  disk cache (immutable, hashed by query)
```

- **The full query string is the cache key.** `GET /image?job=1002&action=0` is
  hashed (order-independent) into a cache entry. Once rendered, responses are
  served from disk with `Cache-Control: public, max-age=31536000, immutable` and
  an `ETag`, so browsers and CDNs cache them forever.
- **Images vs. animations.** zrenderer composites a multi-frame render into a
  single **animated PNG (APNG)**; a single frame is a normal PNG. The gateway
  serves both as `Content-Type: image/png` (modern browsers animate APNG
  natively).
  - Pass an **`action`** (and no `frame`) → you get the **animation** (APNG).
  - Specify a **`frame`** → you get a **single still image**.
  - Neither → a single still image (frame `0`).
  - Want a **GIF** instead? Send the same request to **`/gif`** rather than
    `/image` (see [`GET /gif`](#get-gif)). Converting APNG→GIF is the *only*
    image processing the gateway does — everything else is just caching bytes.
- **Concurrent requests for the same URL trigger exactly one render** (in-process
  single-flight), and zrenderer's own `returnExistingFiles` cache is a second
  backstop.
- **`GET /icons/*` is plain static file serving** — the icons are extracted
  once from the client GRF by `extract-grf.mjs --icons` (see
  [GRF extraction](#resources--grf-extraction-required)); zrenderer is not
  involved at all.

## API

### `GET /image`

Renders (or serves from cache) a sprite. Every meaningful zrenderer render
parameter is available as a query parameter:

| Query param | Type | Notes |
|---|---|---|
| `job` | comma-separated IDs | **Required.** e.g. `job=1002` or `job=1002,1003` |
| `action` | integer | Animation/action index. Its presence (without `frame`) yields an animation. |
| `frame` | integer | A specific frame → a still image. `-1` = all frames (animation). |
| `gender` | `male`/`female` or `1`/`0` | Default male. |
| `head` | integer | Player head id. |
| `outfit` | integer | Alternate outfit (`0` = default). |
| `headgear` | comma-separated ints | Up to 3, e.g. `headgear=4,125`. |
| `garment` | integer | |
| `weapon` | integer | |
| `shield` | integer | |
| `bodyPalette` | integer | `-1` = standard. |
| `headPalette` | integer | `-1` = standard. |
| `headdir` | `straight`/`right`/`left`/`all` or `0`/`1`/`2`/`3` | Default all. |
| `madogearType` | `robot`/`suit` or `0`/`2` | |
| `enableShadow` | boolean | `true`/`false`. |
| `canvas` | string | `WxH±X±Y`, e.g. `canvas=200x200+75+175`. |
| `outputFormat` | `png`/`zip` or `0`/`1` | Default `png`. `zip` returns a ZIP of PNGs. |

> Server/deployment-level zrenderer flags (resource path, output dir, host/port,
> token file, TLS, CORS, log level, `singleframes`, `enableUniqueFilenames`,
> `returnExistingFiles`) are fixed by the deployment and intentionally **not**
> exposed as query parameters.

A missing `job` returns `400`. Upstream render errors return `502`.

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
is converted to a **GIF** before it's cached and served (`Content-Type:
image/gif`):

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
| `ui` | Character-creation UI element | client filename (see below) |

```
/icons/item/501.png          # Red Potion inventory icon
/icons/collection/501.png    # Red Potion description image
/icons/skill/28.png          # Heal
/icons/job/4252.png          # Dragon Knight
/icons/ui/bt_female_on.png   # gender toggle, female, selected
```

The source BMPs use magenta (`#FF00FF`) as the transparency colorkey; the
extractor converts that to a real PNG alpha channel. Responses carry the same
immutable cache headers and `ETag`/`304` support as `/image`. Unknown names
(or types) return `404`.

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

### `GET /healthz`

Liveness check — returns `200 ok`.

## Running it

Everything runs via Docker Compose: the gateway (built from `./gateway`) and the
official `zhade/zrenderer:latest` image.

```bash
# 1. Provide game assets (see "Resources" below) into ./resources
# 2. Bring it up
docker compose up --build
```

- The gateway is published on **`http://localhost:8080`** (override with
  `GATEWAY_PORT`, see `.env.example`). zrenderer itself is **not** exposed to the
  host — only the gateway can reach it on the internal network.
- **Access token:** on first run zrenderer auto-generates an access token into the
  shared `secrets` volume and prints it to its logs. The gateway reads that same
  file automatically. If you'd rather pin it, set `ZRENDERER_TOKEN` (grab the value
  with `docker compose logs zrenderer`).

### Layout

```
docker-compose.yml        # gateway + zrenderer, shared output/secrets/cache volumes
zrenderer.docker.conf     # zrenderer server config
gateway/                  # the Go caching gateway (this project)
resources/                # YOUR extracted GRF assets (git-ignored, not distributed)
resources/icons/          # static icons (extract-grf.mjs --icons), served at /icons/*
extract-grf.mjs           # helper to extract a GRF into resources/
```

## Resources / GRF extraction (required)

**This project distributes no Ragnarok Online game assets.** To render anything,
zrenderer needs the sprite/palette data from a Ragnarok Online client's GRF
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

This populates `resources/data/sprite`, `resources/data/palette`, etc., which
zrenderer reads via `resourcepath=resources` in `zrenderer.docker.conf`.

To serve the static icons (`/icons/*`), run the icon extraction step too:

```bash
node extract-grf.mjs --icons resources/icons --grf path/to/data.grf
```

This decodes the item/collection/skill/job icon BMPs (keyed by numeric id) and
the character-creation UI elements (keyed by their client basename) into
transparent PNGs under `resources/icons/{item,collection,skill,job,ui}/`,
which the gateway serves directly. Item ids are resolved via
`System/iteminfo_new.lub` (found automatically next to the GRF; override with
`--iteminfo <path>`), skill ids via `skillid.lub` inside the GRF. Rerunning
overwrites in place.

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
  — does 100% of the sprite rendering. This project is only a layer on top.
- The GRF extractor's DES routine is ported from
  **[grf-loader](https://github.com/vthibault/grf-loader)** (MIT). The GRF reader,
  the icon pipeline and the mini Lua 5.1 VM originate from
  `adsonpleal/ragreplaystats`.
- Ragnarok Online and its assets are © Gravity Co., Ltd. No game assets are
  included in or distributed by this repository.

This project is licensed under the **[MIT License](LICENSE)** — do whatever you
want with it.
