# Changelog

All notable changes to this project are documented here. The project deploys
continuously (no version tags), so entries are grouped by date.

## 2026-06-26

### Added
- **`mobs.json` — a `jobID → { en, pt, es }` map of localized monster names, plus the
  `tools/mobnames/` pipeline that maintains it.** Monster names live only in the
  client's base64 i18n CSV (`data/i18n/sc/<hash>.csv`), keyed by a positional `strId`
  with no job id attached; the one static game file that links an identifier to a
  `strId` is the navigation DB `navi_mob_br.lub` (each spawn row carries an
  `AEGIS` + `"\x1c"+base64(strId)+"\x1c"` token), joined to job ids via
  `npcidentity.lub`. The pipeline resolves rows by descending certainty — **navi token
  (exact) → ordered-fill between anchors (high) → grouped/shadow variant matching →
  agents** (aegis semantics + ascending-order rails, with the Divine Pride API as a
  verification oracle) — and never lets any tier contradict a navi anchor. The current
  `mobs.json` covers **2,941 job ids / 2,768 of 2,834 name rows (97.7%)**, each tagged
  with `source` + `confidence`, ground truth 9/9 (incl. `20620 → Pimentinha`). The
  build is incremental — `mobs.json` is the source of truth, so a client update only
  re-resolves new/changed rows (`node tools/mobnames/resolve.mjs`). New
  `/update-mob-names` skill runs the full loop (resolve → optional DP warm → agents →
  merge → audit). The Divine Pride key lives in the git-ignored `.env`; pipeline caches
  are git-ignored. See `tools/mobnames/README.md`.

## 2026-06-25

### Changed
- **Refreshed all client assets and resolver tables for the 2026-06-25 game
  update.** Re-ran `extract-grf.mjs` (`--extract`/`--icons`/`--effects`) against the
  rebuilt client GRF and regenerated the embedded id→sprite-name tables
  (`resolve/data/tables.json`) and layer-priority table (`resolve/data/layer_priority.json`)
  from the updated `luafiles514` via `gen-resolver`. The resolver tables gain **101
  new entries with none removed** — new headgears (e.g. `_pulse_of_yggdrasil`,
  `_c_giant_panda`), garments (e.g. `c_accordion_bag`) and EP18 NPC sprites now
  resolve and render — and two accessories (`1602`, `2251`) get re-tuned draw
  priorities. The extracted assets grew by ~860 sprite files and ~494
  item/collection icons each; effect-only costumes are unchanged (23 resolved).

## 2026-06-19

### Added
- **Effect-only costumes are now extracted and served at `/effects/*`.** Some
  costumes have no character sprite — auras, falling petals, spotlights, ghosts,
  weather — because the client draws them with its `.str` world-effect system, not
  as a body sprite, so the renderer can't produce them. `extract-grf.mjs --effects`
  enumerates these costumes from `iteminfo_new.lub` (exactly the ones with no
  resolvable character view), maps each to its `.str` in the GRF, and writes a
  per-effect bundle — `effect.json` (the parsed keyframe animation) plus the
  `tex_N.png` layer textures (TGA alpha kept, BMP magenta-keyed) — under
  `resources/effects/<key>/`, with a catalogue at `resources/effects/index.json`.
  The gateway serves them at `/effects/index.json`, `/effects/{key}/effect.json`
  and `/effects/{key}/tex_N.png` with the same immutable cache/`ETag`/CORS headers
  as `/icons`, for the latamvisuais map simulator to render client-side. Of the 56
  effect-only costumes in the current client, 23 resolve automatically (4 invisible
  gear-hiding costumes are excluded; the rest are Korean-named or EXE/shared-bound
  and filled in via the `STR_OVERRIDE` table). New `EFFECTS_DIR` env var
  (default `/effects`).

## 2026-06-16

### Fixed
- **Effect headgears now draw behind the character automatically, per direction.**
  Big effect accessories (auras, halos, the Sun God's Ornament `2669`) used to
  render on top of the body. RO's `TB_Layer_Priority` table gives every accessory
  a per-direction draw priority (negative = behind), so this is now derived from
  client data: the Sun God hangs behind you when you face the camera and in front
  when you face away — no per-id flagging by the caller. The `headgearBehind`
  query param is kept as a manual override for ids the table doesn't cover. The
  table is baked offline by `gen-resolver` into a new embedded
  `resolve/data/layer_priority.json` (549 accessories); `tables.json` is unchanged.

### Removed
- **The server-side render cache is gone.** Rendering is now in-process and fast,
  so the gateway renders on every request and streams the bytes directly instead
  of persisting them to a `CACHE_DIR` volume. Responses keep the same immutable
  `Cache-Control`/`ETag` headers, so the browser/CDN does the caching (and a
  revalidating client still gets a `304`, answered without re-rendering).
  Concurrent identical requests are still coalesced into a single render
  (in-process single-flight). Dropped the `CACHE_DIR` env var, the
  `gateway-cache` Docker volume, and the cache-dir setup in the Dockerfile.

### Changed
- **Rendering is now done in-process by a native Go reimplementation of
  zrenderer** (`gateway/internal/render`): SPR/ACT/PAL/IMF parsers, transform/
  compositing math, sprite assembly with attach-point parenting and z-ordering,
  palette application, and PNG/APNG output. The separate `zrenderer` Docker
  service is removed — the gateway reads the extracted GRF assets and renders
  directly, eliminating the HTTP round-trip, the shared output/secrets volumes,
  and the access-token handshake. Output is pixel-identical to the previous
  zrenderer for the validated player/monster cases.
- **`docker-compose.yml` / `docker-compose.prod.yml`**: dropped the `zrenderer`
  service and its volumes; the gateway now mounts `./resources` (read-only) and
  is configured via `RESOURCE_DIR`. Removed `ZRENDERER_URL`/`TOKEN_FILE`/
  `OUTPUT_DIR`/`ZRENDERER_TOKEN` and the `zrenderer.docker.conf` file.

### Fixed
- **`headdir`**: the head-direction enum was mislabeled (`left`/`right` swapped)
  and `headdir=straight` rendered identically to `all` (the head cycled through
  directions instead of facing front). `straight`/`left`/`right` now pin the head
  to that facing for the whole stand/sit animation while the body keeps animating
  (no frame-locking); `all` keeps the legacy looking-around cycle.
- **Garment palette variants**: ids now resolve via the client's robe tables, so
  e.g. `garment=245` renders the correct (red) "Cesta de Pitaya" basket.
- **Garment draw order per direction** (`_New_DrawOnTop`): a garment now draws in
  front of the body for back-facing directions (2–6) and behind for front-facing
  ones (0,1,7), so capes hang behind you facing the camera and over your back
  facing away. Previously every garment drew behind the body in all directions.
- **Garment sprite resolution** now picks the first folder layout where the `.act`
  and `.spr` form a matched pair (classic `로브/N/<g>/<job>`, nested
  `로브/N/N/<g>/<job>` used by newer costumes, or shared `로브/N/N`), instead of
  pairing a per-job `.act` with a shared `.spr` from a different folder (which
  rendered garbage, e.g. `garment=195` "Rabo de Rata").
- **Effect headgears behind the character** via `headgearBehind=<ids>` — lists
  the headgear ids (e.g. the Sun God's Ornament `2669`) that should render behind
  the body/head instead of in front. RO decides this in client code with no GRF
  signal, so the caller marks them.

### Added
- `gateway/cmd/gen-resolver` — an offline tool that bakes the headgear/garment/
  weapon/monster ID→sprite-name tables from the client's `luafiles514/.lub`
  bytecode into embedded JSON (decoded EUC-KR→UTF-8), so no Lua runs at request
  time. Re-run it when the client GRF is updated.

## 2026-06-15

### Changed
- The public instance is now reachable at **`https://assets.latam-tools.com.br`**
  (its own auto-provisioned Let's Encrypt certificate); documentation and the
  README gallery now point at this domain. The previous
  `https://ragassets.duckdns.org` hostname continues to work — Caddy serves both.

## 2026-06-14

### Added
- **`GET /gif`** — a sibling of `/image` that accepts every `/image` query
  parameter (same still-vs-animation rule, cache headers, and `ETag`/`304`
  support) but converts the rendered PNG/APNG to a **GIF**. An `action` yields an
  animated, infinitely-looping GIF; a `frame` (or neither) yields a still GIF.
  `outputFormat=zip` is rejected (`400`) since the response is a single image.
  Intended for clients that can't display APNG (chat embeds, link-preview
  crawlers, older tooling).

### Changed
- The gateway now does in-process **APNG→GIF conversion** (`gateway/gif.go`) —
  the only image processing it performs. It composites APNG frames onto a full
  canvas (honoring per-frame offset/blend/dispose ops) and quantizes each frame
  to its own ≤256-color palette with a reserved transparent index. GIF
  transparency is a single palette index, so antialiased sprite edges harden;
  prefer `/image` (APNG) for crisp edges.
- Added two small pure-Go dependencies used only by `/gif`: `github.com/kettek/apng`
  (APNG decode) and `github.com/ericpauley/go-quantize` (color quantization).
- All served assets (`/image`, `/gif`, `/icons/*`) now send
  `Access-Control-Allow-Origin: *`, so browsers can read the bytes via `fetch()`
  — e.g. to download a sprite or convert it client-side, not just embed it in an
  `<img>`. They're public, read-only, no-credential assets, so a wildcard origin
  is safe and needs no preflight for a simple GET.
