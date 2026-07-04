# Changelog

All notable changes to this project are documented here. The project deploys
continuously (no version tags), so entries are grouped by date.

## 2026-07-04

### Changed
- **Broadened `/effect/skill-map` from 63 to 488 skills** so modern skills render in
  the `.rrf` replay viewer instead of showing no effect. The client resolves a
  skill's visual via `skill-map[skillId] → {effectId?, hitEffectId?, groundEffectId?}`,
  but the table only covered classic 1st/2nd-job skills, so anything 3rd-job or newer
  (Arrow Storm, Chain Lightning, the 4th-job classes…) mapped to nothing.
  - **Source switched to [roBrowserLegacy](https://github.com/MrAntares/roBrowserLegacy)**
    (`SkillConst`/`SkillEffect`/`EffectTable`), whose `SkillEffect` covers ~1000 skills
    vs. the ~63 in the old vthibault/roBrowser port. The client's own
    `skilleffectinfolist.lub` was evaluated but is **not** the full table — it holds
    only ~66 scripted `KO_*` skills; every other skill's visual is hardcoded in the
    packed client EXE, so roBrowserLegacy's reconstruction is the usable source.
  - Both `skill_map.json` and `effect_table.json` are regenerated from the **same**
    Legacy source, because the effect-id numbering shifted between roBrowser versions
    (~130 of 318 ids differ) and the two tables only agree within one source. Skill
    ids are the AEGIS/packet ids the client sends (match rAthena; verified `SM_BASH=5`,
    `WZ_STORMGUST=89`). `effect_table.json` grew 318 → 752 effect ids.
  - `tools/gen-effect-tables.mjs` was rewritten to evaluate the Legacy **ES** modules
    (strip imports, stub renderer deps, bind the real `SkillConst` so `SkillEffect`
    keys resolve to numeric skill ids), fold multi/named/function effect values down
    to the single-numeric-id contract, and apply a small validated override for four
    skills Legacy leaves empty but its `EffectTable` still defines (Safety Wall,
    Brandish Spear, Auto Counter, Chain Lightning). Deterministic; `--src <dir>`
    produces byte-identical output to the GitHub fetch.
  - All 63 previously-mapped skills are preserved and still resolve. Verified the
    full chain end-to-end against the extracted GRF: Arrow Storm
    (`2233 → 746 → arrowstorm.str`), Storm Gust, Pneuma, Fire Wall, Meteor and Chain
    Lightning all resolve to on-disk `.str` files with valid `STRM` magic. ~179 skills
    resolve to a `STR` effect; the rest map to procedural (`2D`/`3D`/`SPR`/`CYLINDER`/
    `FUNC`) effects the client can't render (unchanged behavior). No client changes.

## 2026-07-03

### Added
- **Skill/world effect data + textures for the `.rrf` replay viewer (`/effect/…`).**
  A new, self-contained subsystem that serves Ragnarok effect assets (Fire Bolt,
  Heal, Storm Gust, auras…) as **data**, not baked images — the replay client
  renders them itself in WebGL (a port of roBrowser's `StrEffect`) and needs the
  per-layer additive blend fields intact. Four endpoints (distinct from the
  existing `/effects/…` costume bundles):
  - `GET /effect/str?file=<name>` — parses a `.str` (STRM) binary into JSON:
    `fps`, `maxKey`, and per-layer `textures` + keyframe `animations` (`frame`,
    `type`, `pos`, `uv`, `xy`, `aniframe`, `anitype`, `delay`, `angle`, `color`,
    `srcalpha`, `destalpha`, `mtpreset`). The `srcalpha`/`destalpha` D3DBLEND ints
    are kept **raw** (the client maps them to `gl.blendFunc`); `color` stays in the
    file's `0–255` range. Cross-checked byte-for-byte against the existing
    `--effects` bundle keyframes.
  - `GET /effect/texture?file=<name>` — converts a `.str` layer texture (`.bmp`
    magenta-`#FF00FF`-colorkeyed, or 32-bit `.tga` with real alpha) to an RGBA PNG
    with the transparent RGB bled outward to kill bilinear fringes. Pixel-identical
    to the vetted `extract-grf.mjs` texture pipeline.
  - `GET /effect/skill-map` and `GET /effect/table` — roBrowser's `SkillEffect` and
    `EffectTable` lookups, ported verbatim to embedded JSON by the new
    `tools/gen-effect-tables.mjs` (63 skills, 318 effect ids). Lets the client
    resolve `skillId → effectId(s) → parts` without shipping its own copy.

  `str`/`texture` parse on demand from `RESOURCE_DIR/data/texture/effect` (like
  `/image` renders from the sprite tree — no on-disk cache), with case-insensitive,
  traversal-safe path resolution for the GRF's inconsistent casing / EUC-KR names,
  and the usual immutable cache headers + `ETag`/`304` + wildcard CORS. Add
  `texture\effect` to the base `--match` to populate the source tree (see README).
  New Go package `gateway/internal/effect` (STR parser, BMP/TGA decoder, file
  store, embedded tables) with unit tests.

## 2026-07-02

### Fixed
- **Windhawk 4th-job companions now render their class-specific sprites.** The Ranger
  4th-job (Windhawk) falcon (`job=20830`, `JT_4JOB_H_FALCON`) and warg (`job=20833`,
  `JT_4JOB_WORG`) were served as the generic light monster sprites (`몬스터/매` brown
  falcon, `몬스터/워그` gray warg) because `jobname.lub` maps those ids to the plain
  monster names. The client actually draws these two from class-specific sprites in
  the `이팩트` ("effect") folder — `windhawk_hawk` (dark falcon with red ribbon
  streamers) and `windhawk_wolf` (black armored warg with green eyes) — which are
  distinct assets, not the monster ones. The resolver now hardcodes a targeted
  `nonPlayerSpriteOverride` for these two ids (both are Windhawk-only, so the remap is
  safe); they still render like any monster (own `.act`, embedded SPR palette, all 8
  directions + walk). Investigated the rest of the companion cluster too — the other
  two 4th-job companion ids `20831` (`매2`) and `20832` (`owl`) already resolve
  correctly (their `이팩트/` copies are byte-identical to the `몬스터/` sprites), and the
  lone other effect-folder creature sprite, `soul_falcon`, is a skill effect (action 0
  only, no directional frames), not a companion — so no other remap is needed.

## 2026-07-01

### Added
- **Status icons for EFSTs missing from `StateIconImgList`, starting with the stat
  food buffs.** `/icons/status/<id>.png` was previously extracted only from
  `stateiconimginfo.lub`'s `StateIconImgList` (~450 of ~1241 EFSTs). Many EFSTs the
  client *does* show an icon for are absent from that table — the client maps them to
  a `data/texture/effect/*.tga` via a convention hardcoded in its exe, not the lua
  data — so those ids `404`ed. `extract-grf.mjs` now applies a supplemental hardcoded
  `STATUS_ICON_OVERRIDES` table after `StateIconImgList` (the lua table wins whenever
  it has its own entry for an id), seeded with the 12 stat-food mappings:
  `241`–`246` (`EFST_FOOD_STR`…`LUK`) and `271`–`276` (their `_CASH` variants) →
  `str/agi/vit/dex/int/luk_gogi.tga`. Each referenced TGA is decoded to a transparent
  PNG and written to `resources/icons/status/<id>.png` exactly like the existing path,
  so `/icons/status/241.png`…`246.png` and `271.png`…`276.png` now serve the gogi
  icons. The writer reads each TGA's own header for dimensions (it never assumed a
  fixed size), so the served PNG matches the client asset regardless of shape. The
  override table is the extension point for porting the client's remaining ~129
  hardcoded EFST→effect-texture mappings.

## 2026-06-29

### Added
- **Sprite-based map effects are now baked and served.** Three more `.rsw` "type 4"
  effect ids whose asset is a *played sprite* (`.spr`/`.act`), not a `.str` —
  `EF_TORCH` (`47`), `EF_SMOKE` (`44`) and `EF_BANJJAKII` (`165`) — are now baked
  into `manifest.effects` as `{"id","pos","sprite":"<key>","delay","param"}`, and
  the procedural `EF_FIREFLY` (`45`, type `FUNC`, no asset — the client draws it
  itself) as `{"id","pos","delay","param"}`. The sprites live in the client's
  `data/sprite/이팩트/` (이팩트 = "effect") folder (`torch_01` / `굴뚝연기` /
  `크리스마스`), resolved via the `SPRITE_EFFECT_TABLE` port of roBrowser's
  `EffectTable.js`. `--effects` renders each one once into `/effects/sprites/<key>/`
  (keys `torch_01` / `smoke` / `banjjakii`): one **composited** `<i>.png` per frame
  of the effect's first `.act` action — every layer's scale, rotation, mirror and
  colour baked into a single image at its natural bounding size (a faithful JS port
  of the native renderer's per-layer affine placement + alpha/tint rasteriser), with
  `.spr` **truecolor (RGBA)** frames decoded (stored ABGR, swizzled to RGBA — the
  existing decoder is palette-only). The `sprite.json` is a
  `{"frames":[{"img","delay","offset":[x,y]}]}` play list: `delay` is the action's
  real frame interval in ms (the `.act` value ×25, default `100`), and `offset` is the
  composited image's centre relative to the effect's placement origin (RO px, +x right
  / +y down; the client negates `y`), so frames whose size shifts across the animation
  (e.g. the torch flame's growing glow) still sit on the origin. Parsing the `.act`
  required correcting the 2.x layer layout (the colour is a 4-**byte** packed value,
  not 4 floats, and attach points are 16 bytes each) and reading each layer's full
  placement. The gateway's `/effects` handler gained a
  `sprites/{key}/{sprite.json|N.png}` route. Validated on `data.grf`: `torch_01`
  (7 frames, offset `[-11,-56]`), `smoke` (1) and `banjjakii` (24 frames, real delay
  `125`) all resolving. STR/emitter/fog baking is unchanged; the EXE-bound hardcoded
  ambient ids remain skipped.
- **Parametric map emitters are now baked into `manifest.effects`.** The modern
  ambient map effects `EF_EMITTER` (`974`), `EF_ANIMATED_EMITTER` (`1073`) and
  `EF_MAGIC_FLOOR` (`1025`) are **not** `.str` files (roBrowser's `EffectTable.js`
  leaves them undefined and the client draws them from a particle spec, not an
  asset). That spec lives per-map in the client's
  `data/luafiles514/lua files/effecttool/<map>.lub` as Lua emitter tables
  (`_<map>_emitterInfo` / `_animatedEmitterInfo` / `_magicfloorInfo`, plus a generic
  `_<map>_Effect` container). During `--maps` extraction we now read that lub
  (`readEffectToolLub` — a straight-line Lua 5.1 VM reusing the iteminfo reader's
  opcode/table machinery, with a plain-text fallback for the one uncompiled lub),
  match each `.rsw` placement to its lub entry by horizontal **X/Z** position
  (≤5 units), and bake the entry's spec inline as an `emitter` field:
  `{"id","pos","delay","param","emitter":{…}}`. The emitter's `texture` is rewritten
  into the shared `_t` store (content-addressed, deduplicated like every other map
  texture); magic-floor entries carry `Speed`/`Size`/`Angle`/`RiseAngle`/`Alpha`/
  `Height0…20` instead of a texture. STR-effect baking is unchanged, and the classic
  hardcoded ambient effects (forest lights, torches, light pillars, …) remain
  skipped — the client draws those procedurally with no data we can ship. A full run
  bakes **6,740 emitter placements across 106 maps** (`974`: 6,573, `1073`: 141,
  `1025`: 26), resolving 6,713 distinct emitter textures.

## 2026-06-28

### Added
- **In-world map effects are now extracted into the pipeline.** A map's `.rsw`
  places "type 4" effect objects (`{name, pos÷5, id, delay, param[4]}`); during
  `--maps` extraction we parse them and add an `effects` array to `manifest.json` —
  one entry per placed instance, `{"id","pos","str","delay","param"}` (positions are
  **not** deduplicated; the client proximity-culls). Each `id` is resolved to its
  `.str` asset(s) via `EFFECT_STR_TABLE`, the STR-type subset of roBrowser's
  `EffectTable.js` ported into `extract-grf.mjs` (handling the `file:'bubble%d'`
  `rand:[1,4]` → `bubble1`…`bubble4` pattern); `str` is the id's deduped set of
  `/effects/<key>/` bundle keys the client picks from at random. Non-STR effect
  types (FUNC/3D/CYLINDER/SPR/weather, e.g. `45` `EF_FIREFLY`) and Korean-named
  (unservable) effects are skipped. The `--effects` step now also builds a
  `/effects/<basename>/` bundle (same `effect.json` + `tex_N.png` format as the
  costume effects) for every servable STR effect in the table, so any map's
  references resolve. `iz_dun03`, for example, gains **312 `effects`** entries (all
  `id 109` `EF_BUBBLE`), served by `/effects/bubble1`…`bubble4`.
- **Per-map fog is now folded into each map's `manifest.json`.** During `--maps`
  extraction we parse `data/fogparametertable.txt` and add a `fog` block —
  `{"near","far","color":[r,g,b],"factor"}` — to every map that has a fog row
  (omitted otherwise), the same way the shared `ui` block is added. Fog isn't in
  the `.rsw`; it lives only in this table. `near`/`far`/`factor` are the table's raw
  floats (the client multiplies `near`/`far` by 240 itself); the colour is the
  packed `0xAARRGGBB` value with the alpha byte dropped and each RGB byte ÷ 255.
  The official table puts each record's five `#`-terminated fields on separate
  lines, so the parser tokenizes on `#` across newlines. The current client yields
  **fog for ~288 maps**.
- **Every map's background music is now extracted and served at `/bgm/*`.** A new
  `extract-grf.mjs --bgm` mode reads `data/mp3nametable.txt` from the GRF (the
  client's `<map>.rsw → bgm\<file>.mp3` table) and copies the referenced `.mp3`
  tracks out of the client's loose `BGM/` folder — the audio lives next to the GRF,
  not inside it — into `resources/bgm/`, **de-duplicated by filename** since many
  maps share one track. It emits `resources/bgm/index.json` mapping each map name to
  its track. The gateway serves `/bgm/index.json` (the catalogue) and
  `/bgm/{track}.mp3` (`audio/mpeg`) with the same immutable cache/`ETag`/CORS headers
  as `/maps`. The current client yields **~183 tracks (~325 MB)** covering ~1080 maps.
- **Every world map is now extracted and served at `/maps/*`.** A new
  `extract-grf.mjs --maps` mode enumerates all `data/<name>.rsw` maps in the client
  GRF and, per map, emits the raw `.gat`/`.gnd`/`.rsw` geometry (parsed client-side)
  plus a `manifest.json`; the `.rsm` models, BMP/TGA textures (converted to
  transparent PNG with the same magenta-key + fringe-bleed as `/effects`),
  animated-water JPGs and the shared cursor/grid UI are **de-duplicated by content
  hash** into shared stores (`_m`/`_t`/`_w`/`_u`), so assets reused across maps are
  written and served exactly once. The gateway serves `/maps/index.json` (the
  catalogue), `/maps/{map}/manifest.json`, `/maps/{map}/{map}.gat|gnd|rsw` and the
  shared `/maps/_{t,m,w,u}/<hash>.*` blobs with the same immutable cache/`ETag`/CORS
  headers as `/icons` and `/effects` — replacing the per-app map bundle the
  [latamvisuais](https://github.com/adsonpleal/latamvisuais) simulator previously
  shipped, which now fetches maps remotely. A GRF-entry index makes the ~100 resource
  lookups per map O(1), keeping a full run to minutes. The current client yields
  **922 maps** (17 of the 939 `.rsw` entries are ground-mesh-less server/template
  maps and are skipped); the content-addressed stores hold 9.8k textures, 7.3k models
  and 313 water frames in **5.8 GB total** — vs. ~10–15 GB had each map's assets been
  copied per directory (water alone: 313 shared frames instead of ~30k duplicates).

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
