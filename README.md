# ragassets — a fast caching image/animation provider for Ragnarok Online sprites

`ragassets` is a thin, fast HTTP layer that renders and serves Ragnarok Online
sprites as images and animations, with aggressive on-disk caching so repeat
requests are served instantly.

> **All of the actual rendering is done by [zrenderer](https://github.com/zhad3/zrenderer)
> by [zhad3](https://github.com/zhad3).** This project is *just a caching gateway on
> top of it* — it maps URL query parameters to a zrenderer render request, asks
> zrenderer to render, then caches and serves the bytes. Huge thanks to zhad3 for
> zrenderer; please star and support the upstream project. See its
> [API docs](https://z0q.neocities.org/ragnarok-online-tools/zrenderer/api/).

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
  natively) — so there is no separate GIF format and no image processing in the
  gateway at all.
  - Pass an **`action`** (and no `frame`) → you get the **animation** (APNG).
  - Specify a **`frame`** → you get a **single still image**.
  - Neither → a single still image (frame `0`).
- **Concurrent requests for the same URL trigger exactly one render** (in-process
  single-flight), and zrenderer's own `returnExistingFiles` cache is a second
  backstop.

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
  **[grf-loader](https://github.com/vthibault/grf-loader)** (MIT). The GRF reader
  originates from `adsonpleal/ragreplaystats`.
- Ragnarok Online and its assets are © Gravity Co., Ltd. No game assets are
  included in or distributed by this repository.

This project is licensed under the **[MIT License](LICENSE)** — do whatever you
want with it.
