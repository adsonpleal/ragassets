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
| `headgear` | comma-separated ints | Up to 3, e.g. `headgear=4,125`. A **hat-effect** costume (`1500` *Fúria dos Shuras*, the only one the client ships today) has a blank accessory sprite and its visual in a separate looping sprite the client plays at the character's head; the renderer composites that automatically, and its longer timeline sets the animation's length. |
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

> A few companion job ids don't render the sprite `jobname.lub` names for them: the
> Windhawk (Ranger 4th-job) falcon `job=20830` and warg `job=20833` are drawn by the
> client from class-specific sprites in the `이팩트` ("effect") folder
> (`windhawk_hawk` / `windhawk_wolf`), not the generic monster falcon/warg. The
> resolver hardcodes these two remaps; every other companion (e.g. `job=20831`,
> `job=20832`) already resolves correctly.

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
`luafiles514/.../stateicon/efstids.lub`). Not every EFST has an icon — those the
client maps to an image in `stateiconimginfo.lub` are served, plus a supplemental
hardcoded `STATUS_ICON_OVERRIDES` table (in `extract-grf.mjs`) for EFSTs the client
shows an icon for via a convention baked into its exe rather than the lua data —
e.g. the stat food buffs (`241`–`246` `EFST_FOOD_*` and `271`–`276` `*_CASH`) →
`data/texture/effect/*_gogi.tga`. `stateiconimginfo.lub` wins whenever it has its
own entry for an id. Most status icons are 32×32, but the source TGA's own header
is honoured (the `*_gogi` icons vary), so the served PNG matches the client asset.

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

Some costumes have **no character sprite to draw** — auras, falling petals,
spotlights, ghosts, weather. Either the client ships no accessory sprite for them
at all, or it ships one that is deliberately blank (every `.act` layer tinted
alpha 0, flagged as `spriteBlank` on
[`/raw/items.json`](#get-raw--client-data-tables-items-jobs-skills-monsters)).
Either way it draws them with its `.str` world-effect system, so the sprite
renderer above can't produce them. (One blank accessory is *not* in this set: a
**hat effect** puts its visual in a separate looping sprite instead of a `.str`,
and [`/image`](#get-image--rendered-sprite) composites that itself — see
`spriteBlank` below.) `extract-grf.mjs --effects` pulls each one's
`.str` out of the GRF as a small JSON + PNG bundle (see
[GRF extraction](#resources--grf-extraction-required)); the gateway serves those
bundles for the [latamvisuais](https://github.com/adsonpleal/latamvisuais) map
simulator to render client-side. These endpoints return `404` until you run the
`--effects` step.

A costume is linked to its `.str` by resource name — `efst_<res>` names the
folder — but Gravity romanizes some folders (`흩날리는낙엽` lives in
`efst_maple_falls/`) and some folders hold more than one `.str`. Both cases go in
the `STR_OVERRIDE` table in `extract-grf.mjs`, and the picks there come from the
client's own hat-effect table, `HatEffectInfo/HatEffectInfo.lub`, which maps each
`HAT_EF_*` id to the exact file it plays. Read it with the `HAT_EF_*` constants
from `HatEffectInfo/HatEffectIds.lub` loaded into the same Lua globals, or the
table's keys come back unresolved. It has no item ids — the item → hat-effect
link is server-side — so the costume still has to be matched by hand, but it
settles *which* `.str` an ambiguous folder plays.

`EffectHatItemTable.lub` looks like the missing link and is not: its keys are a
contiguous `1..109`, so it is a flat *list* of the items that have a hat effect,
not a `HAT_EF` id → item map. Joining the two by number produces plausible
nonsense — `HAT_EF_Blossom_Fluttering` lands on `20522` *Miaura* while the item
that really is `흩날리는벚꽃` sits one row later. Match by resource name instead.

| Path | What you get |
|---|---|
| `GET /effects/index.json` | Catalogue: `{"items":[{"id","name","slots","effect"}]}` — one entry per effect-only costume (`effect` is the bundle key; there is no character `view`). |
| `GET /effects/{key}/effect.json` | The parsed `.str` animation: `{"key","fps","maxKey","layers":[{"textures":[…],"anims":[…]}]}`. |
| `GET /effects/{key}/tex_N.png` | That effect's layer textures (TGA alpha kept; BMP magenta-keyed → alpha). |
| `GET /effects/sprites/{key}/sprite.json` | A sprite-based effect's play list: `{"frames":[{"img":"0.png","delay":96,"offset":[x,y]},…]}` — frames in play order, per-frame `delay` in ms, and `offset` (RO px, +x right / +y down) the composited image centre relative to the effect's placement origin. `key` is a map effect's slug (`torch_01`) or `eff_<id>` for the skill/hat effects the replay viewer plays by effect id. |
| `GET /effects/sprites/{key}/N.png` | That sprite effect's composited frames (each `.act` frame's layers baked into one image). |

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
`/effects/sprites/{key}/` bundle: one composited `N.png` per frame of the effect's
first `.act` action — every layer's scale, rotation, mirror and colour baked in, so
the served image already looks like the in-game frame — plus a `sprite.json`
`{frames:[{img, delay, offset}]}` play list. `delay` is the action's real frame
interval from the `.act` (default `100`ms); `offset` is the composited image's centre
relative to the effect's placement origin (RO px, +x right / +y down — the client
negates `y` for its Y-up world), so frames whose size shifts across the animation
still sit on the effect's origin. A map's `manifest.effects` references these by `key`
in a `sprite` field (see [`/maps`](#get-maps--world-maps)).

### `GET /effect/...` — skill & world effects (data + textures)

The [`.rrf` replay viewer](https://github.com/adsonpleal/latamvisuais) renders
**skill effects** (Fire Bolt flames, Heal sparkles, Storm Gust, auras…) itself in
WebGL — a port of roBrowser's `StrEffect` renderer, which needs the correct
per-layer additive blending. So ragassets is a **data + texture server** here, not
a renderer: it parses the `.str` binaries and converts the layer textures, but
never bakes an effect to a flat image (that would destroy the blend modes). This
is a separate namespace from [`/effects/...`](#get-effects--effect-only-costumes)
above (pre-built costume/map bundles); `/effect/...` (singular) parses **any**
effect on demand from the extracted GRF tree.

`str`/`texture` read from `data/texture/effect/` in `RESOURCE_DIR`, so they need
that subtree extracted (see [GRF extraction](#resources--grf-extraction-required))
and `404` otherwise. `skill-map`/`table` are embedded in the binary and always
serve.

| Path | What you get |
|---|---|
| `GET /effect/str?file=<name>` | The parsed `.str` as JSON: `{"fps","maxKey","layers":[{"textures":["<name>",…],"animations":[{"frame","type","pos":[x,y],"uv":[8],"xy":[8],"aniframe","anitype","delay","angle","color":[r,g,b,a],"srcalpha","destalpha","mtpreset"}]}]}`. `srcalpha`/`destalpha` are the **raw D3DBLEND ints** (the client maps them to `gl.blendFunc` — never collapsed); `color` stays in the file's `0–255` range. `<name>` is relative to `data/texture/effect/` and may omit the `.str` suffix. |
| `GET /effect/texture?file=<name>` | One `.str` layer texture as an RGBA PNG: magenta (`#FF00FF`) colorkey → alpha, transparent RGB bled outward to kill bilinear fringes; 32-bit TGA keeps its real alpha. `.bmp`/`.tga` source resolves either way when the extension is omitted. |
| `GET /effect/sound?file=<name>` | One sound effect as browser-playable WAV (`audio/wav`) — the audio behind an effect table row's `wav` field. `<name>` is relative to `data/wav/` **without** the `.wav` extension, exactly as `wav` carries it (`effect/ef_portal`, the bare `_heal_effect`). Reads the static tree `extract-grf.mjs --sounds` writes (`SOUNDS_DIR`); a name the client GRF never shipped `404`s (the viewer treats that as "no sound" and skips it). |
| `GET /effect/sound/index.json` | `{"count", "names":[…]}` — the sound names present in the extracted tree, for coverage preflighting. |
| `GET /effect/skill-map` | `skillId → {effectId?, hitEffectId?, groundEffectId?, wav?}` — from roBrowserLegacy's `SkillEffect` (~683 skills, all job eras). `skillId` is the AEGIS/packet id the client sends (matches rAthena). `wav` is a de-duplicated array of sound names already verified against the extracted tree (see below) — fetch `/effect/sound?file=<name>` directly, no fallback needed. It fills in the many 3rd/4th-class skills whose effect has no `wav` in the table below, by also trying the skill's own SKID constant name. |
| `GET /effect/table` | `effectId → [{type, file, min?, wav?, attachedEntity?, rand?, …}]` — roBrowserLegacy's `EffectTable`. `type` is `STR` for the served (`.str`) effects; `2D`/`3D`/`SPR`/`CYLINDER`/`FUNC` parts are procedural (client-only) and carry only metadata. The `wav` field is the sound name for `/effect/sound` above (both visual rows and sound-only rows carry it). |

```
/effect/str?file=stormgust                 # Storm Gust  (skill 89 → effectId 89)
/effect/str?file=firewall1                  # Fire Wall   (skill 18 → groundEffectId 25)
/effect/texture?file=snow_a                 # a Storm Gust layer texture (.bmp)
/effect/texture?file=stormcannon/sto_shine_00
/effect/skill-map
/effect/table
/effect/sound?file=effect/ef_portal        # the portal-open whoosh (effect 6)
/effect/sound?file=effect/ef_frostdiver2    # Frost Diver (skill 105 → effect 28)
/effect/sound?file=_heal_effect             # a bare-name sound (no effect/ prefix)
```

Resolve a skill to its assets client-side: `skill-map[skillId]` → the `effectId`s →
`table[effectId]` → each part's `file` (expand a `%d` over `rand:[a,b]`) → fetch
`/effect/str?file=<file>`, then `/effect/texture?file=<texname>` for every name the
STR lists. For **audio**, prefer `skill-map[skillId].wav` directly (already
verified, needs no fallback); it's only absent when nothing resolved. Otherwise
read the effect rows' own `wav` field and fetch `/effect/sound?file=<wav>` (`%d`
variants like `effect/ef_firearrow%d` expand the same way). A row with no `type`
is a sound-only part — just a `wav`, no visual. `<name>` lookups are **case-insensitive** (GRF paths carry inconsistent
casing / EUC-KR); responses carry the same immutable cache headers, `ETag`/`304`
and wildcard CORS as `/icons`. The two tables are ported from **roBrowserLegacy**
(`SkillConst`/`SkillEffect`/`EffectTable`) by `tools/gen-effect-tables.mjs` and
embedded, so they need no extraction; re-run that script (optionally `--src <dir>`)
if the upstream tables change. A handful of upstream rows name an asset that
cannot exist — a `\xHH` escape with a wrong byte, a sprite no client ships — and
`EFFECT_PART_FIXUPS` in that script corrects them per part; each key has to keep
matching, so an upstream fix fails the build instead of passing unnoticed.

`type:"STR"` parts render from `/effect/str`, and `type:"SPR"` parts have a
pre-composited bundle at
[`/effects/sprites/eff_<id>/`](#get-effects--effect-only-costumes) — every one of
them, so a skill that maps to a SPR effect has something to play. A skill that
maps only to `2D`/`3D`/`CYLINDER`/`FUNC` effects still shows nothing: those the
client generates procedurally.

`/effect/sound` reads a separate static tree (`extract-grf.mjs --sounds`, see
[GRF extraction](#resources--grf-extraction-required)) and `404`s until it's built.
RO's `data/wav/` is almost all standard PCM (browser-playable, copied verbatim);
the few ADPCM sources are transcoded to PCM WAV at extraction, so every sound plays
in Chrome/Firefox/Safari and the whole tree is one `Content-Type`. Names resolve
case-insensitively, and a name the table stores as raw **EUC-KR** bytes (the client
requests Korean-named sounds verbatim) is retried under its decoded Hangul path — so
those resolve too. The endpoint never strips or adds the `effect/` prefix: a `wav`
that points at a file this client's GRF didn't ship stays a `404`, exactly as it
would in the real client. Responses carry the same immutable cache / `ETag` / CORS
headers as `/bgm`.

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

### `GET /raw/...` — client data tables (items, jobs, skills, monsters…)

The client's reference data as plain JSON, so a project can consume it without
owning a GRF reader, a Lua VM or a Ragnarok install. This is the endpoint that
makes ragassets the single source of truth for game-file extraction: the LATAM
calculator, the costume simulator, the replay viewer and the market catalogue all
build their own data files from these instead of each extracting the client
themselves.

| Path | What you get |
|---|---|
| `GET /raw/items.json` | Every item: `id, name, slots, aegisName, resourceName, description, view, spriteView, spriteBlank, viewKind, equipSlots, costume`. |
| `GET /raw/jobs.json` | Every class: `id, jt, name, hasIcon`. |
| `GET /raw/skills.json` | Every skill: `id, name, maxLevel, description, delay`. |
| `GET /raw/status.json` | Status-effect (EFST) `id` → `name`. |
| `GET /raw/randomopt.json` | Random-option `id` → display template (`"ATQM +%d"`). |
| `GET /raw/classes.json` | Classes with palettes, swatches and alternative outfits. |
| `GET /raw/hair.json` | Hair styles and colour swatches per race/gender. |
| `GET /raw/mobs.json` | Monster stats — see [Monster stats](#monster-stats-rawmobsjson). |

Every table is a **flat JSON array sorted by `id`**, written compact. They are a
deliberately *faithful* projection of the client, not a curated one: naming
overrides, slot-suffix formatting and per-project reshaping stay in each
consumer's own sync step, so this stays one unopinionated upstream.

`name` is the **bare** identified name — the client appends the `[3]` slot suffix
at display time, so `slots` is a separate number and a consumer that wants
`"Espada [3]"` re-joins them. Items with no display name are kept with
`name: null`, because ~640 of them still carry a renderable `view`.

`view` is the literal client `ClassNum`; **`spriteView` is the one to render
with**. Newer costumes ship `ClassNum: 0` and keep their real view only in the
client's accessory/robe name tables, so `spriteView` falls back to that lookup
(232 items in the current client) — a costume catalogue built on `view` alone
silently loses them. `viewKind` (`"headgear"`/`"garment"`/`null`) says which of
the two sprite tables the view lives in, which usually follows the equip slot but
not always; rendering those few from the slot-implied table draws the wrong item.

`spriteBlank` marks the handful of views (10 items in the current client) that
**render as nothing**. Their sprite is there but every layer of the `.act` is
tinted alpha 0, which is how the client says "this costume's visual is an effect,
not a sprite": the falling-petal and aura costumes all work this way. Rendering
them yields an empty image, so a costume catalogue has to skip them and take the
visual from [`/effects/index.json`](#get-effects--effect-only-costumes) instead —
where the effect is a `.str` we can serve.

A blank `.act` is not on its own enough to set the flag. `31089` *Fúria dos
Shuras* (view `1500`) is a **hat effect**: the client plays its visual from a
second sprite shipped beside the item sprites under the costume's own resource
name plus `_이펙트` (`아이템/c홍염의폭렬파동_이펙트`), attached to the character's
head. [`/image`](#get-image--rendered-sprite) composites that sprite, so the view
does draw and `spriteBlank` is `false` — those items are ordinary renderable
costumes, listed only in `items.json` and not in `/effects/index.json`. It is the
only file in the whole GRF carrying that suffix, and the only costume of its kind
today. The same sprite is served as a bundle at `/effects/sprites/eff_1130/` —
that is the numbered effect the client reaches it by
(`HAT_EF_BAKURETSU_HADOU` → `hatEffectTable[47].hatEffectID`), for consumers that
play effects by id rather than render a character.

`description` — on both `items.json` and `skills.json` — is the client's own
pt-BR tooltip, **raw**: the `^RRGGBB` colour codes and the line breaks are kept
and nothing is reflowed, because consumers treat that text as the source of truth
for what an item or skill actually does and each formats it its own way. Skills
whose tooltip the client ships empty (or doesn't ship at all) keep
`description: null` rather than dropping out — 283 of the 1,558 in the current
client. The tooltips come from `SkillInfoz/SkillDescript.lub` at its **full**
`data/luafiles514/…` path: the GRF also carries a `data/spanish/` copy of that
same file, and it is the *largest* of the three, so a suffix-only lookup quietly
publishes Spanish.

`delay` on `skills.json` is the client's *Conjuração e Espera* window — the four
columns it prints, **in milliseconds**, one entry per skill level:

```json
"delay": {
  "castFixed":    [1500, 1500, 1500, …],   // Fixa — cast time nothing reduces
  "castVariable": [4500, 4700, 4900, …],   // Variável — the DEX/INT-reducible part
  "afterCast":    [1000, 1000, 1000, …],   // Pós — blocks every skill afterwards
  "cooldown":     [6000, 6000, 6000, …]    // Recarga — blocks only this skill
}
```

The arrays are **verbatim**: index `N-1` is level `N`, trailing zeros are kept
and nothing is padded out. Their length is *usually* `maxLevel` (2,733 of the
3,044 columns) but not reliably — 258 are padded past it and 53 stop short, 52 of
those holding the single value that plainly means "same at every level" — so
clamp on `maxLevel` and repeat the last entry rather than trusting the length. A
skill the client gives no timings — every passive, and 619 of the 1,558 in total
— has `delay: null`, and a single column the client omits is `null` rather than
`[0]`, so "says nothing" never reads as "says zero". 939 skills carry timings in
the current client.

`maxLevel` is the client's `MaxLv`, and it comes from `SkillInfoList_data.lub`
— **not** from the `SkillInfoList.lub` sitting next to it, which is a stale copy
of the same table, one skill short (5383 Invocação do Abismo). Six skills the
client never released carry `MaxLv: 0`; that zero is the client's own, while a
skill with no row at all would be `null`. The tooltips corroborate the numbers:
of the 1,179 that spell out a *Nível máximo*, 1,178 match, the one exception
(2535 Loja de Compras) being wording drift between the two client tables.

Unlike every other endpoint here these files are **mutable at a stable URL** —
they change whenever the client does — so they are served with a short
`Cache-Control: public, max-age=300, must-revalidate` instead of the immutable
policy the content-addressed assets use. `ETag`/`304` and wildcard CORS work the
same, so a sync that finds nothing new costs one `304`. Everything under `/raw`
returns `404` until you run `extract-grf.mjs --raw` (and, for `mobs.json`,
`tools/scrape-mobs.mjs`).

These are also the only text this host serves, and the reverse proxy compresses
them (`encode zstd gzip` on `/raw/*` in `caddy/ragassets.caddy`) — `items.json`
is 8.2 MB raw and ~1.1 MB gzipped. Everything else ragassets serves is already
compressed bytes, so the directive is deliberately scoped to `/raw`.

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
resources/sounds/         # skill/effect/monster sound effects (extract-grf.mjs --sounds), served at /effect/sound
resources/raw/            # client data tables (extract-grf.mjs --raw), served at /raw/*
extract-grf.mjs           # helper to extract a GRF into resources/
tools/scrape-mobs.mjs     # rebuilds resources/raw/mobs.json from the RagnaPlace Public API
tools/crawl-divine-pride.mjs  # second source for that file: the res/mres RagnaPlace omits
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

Extract exactly the directories the gateway needs into `./resources`:

```bash
node extract-grf.mjs --extract resources --grf path/to/data.grf \
  --match "data\\(sprite|palette|imf|luafiles514|texture\\effect)\\"
```

This populates `resources/data/sprite`, `resources/data/palette`,
`resources/data/imf`, `resources/data/luafiles514`, `resources/data/texture/effect`,
etc., which the gateway reads via `RESOURCE_DIR` (default `/resources` in the
container). `texture/effect` holds the `.str` skill/world effects and their layer
textures that [`/effect/str`](#get-effect--skill--world-effects-data--textures) and
`/effect/texture` parse on demand; drop `texture\\effect` from the match if you
don't need those endpoints. The headgear/garment
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
`EF_BANJJAKII`) into `resources/effects/sprites/<key>/` — one composited `N.png` per
`.act` frame plus a `sprite.json` `{frames:[{img, delay, offset}]}` play list — so a
map's `sprite` effect references resolve.

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

To serve the effect **sound** effects (`/effect/sound`), run the sound extraction
step:

```bash
node extract-grf.mjs --sounds resources/sounds --grf path/to/data.grf
```

This extracts the whole `data/wav/` tree — every name an effect table row's `wav`
field can reference — into `resources/sounds/`, mirroring the GRF paths
(`effect/ef_portal.wav`, `_heal_effect.wav`, …). Standard PCM wavs are copied
verbatim; the handful stored as MS/IMA ADPCM (which some browsers can't decode) are
transcoded to 16-bit PCM so the whole tree is uniformly browser-playable. It writes
`resources/sounds/index.json` listing the names present. (In the current client:
2678 sounds, 6 transcoded from ADPCM, 1 corrupt GRF entry skipped.) A full run
rebuilds the directory from scratch.

### Client data tables (`/raw`)

```bash
node extract-grf.mjs --raw resources/raw --grf path/to/data.grf
```

Writes `items.json`, `jobs.json`, `skills.json`, `randomopt.json`, `status.json`,
`classes.json` and `hair.json` into `resources/raw/`, which the gateway serves at
[`/raw/...`](#get-raw---client-data-tables-items-jobs-skills-monsters). This is
the step that lets every other project stop extracting the client for itself, so
re-run it after a client update. It reads `System/iteminfo_new.lub` from next to
the GRF (override with `--iteminfo`) plus the job, skill, status and
random-option tables from inside it, and refuses to write an empty table — or a
`skills.json` where fewer than half the skills kept their description (or fewer
than a quarter their cast/delay times), which is what reading the tooltips or the
timings from the wrong chunk looks like.

`mobs.json` is the one file in `resources/raw/` this doesn't produce — it isn't
in the client at all, see [Monster stats](#monster-stats-rawmobsjson).

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

## Monster stats (`/raw/mobs.json`)

`resources/raw/mobs.json` is the only table served here that isn't extracted from
the GRF — the client carries no monster HP or EXP anywhere. One record per monster
(2724 of them), with the id, names, level, HP, EXP, DEF/MDEF/ATK, the six base
stats, race/size/element, the boss/MVP flags and the 4th-job resistances:

```json
{ "id": 1039, "aegisId": "BAPHOMET", "name": "Bafomé", "boss": true, "mvp": true,
  "level": 81, "baseExp": 218089, "jobExp": 167053, "mvpExp": 109044,
  "hp": 668000, "def": 379, "mdef": 45, "attack": 2520,
  "str": 120, "agi": 125, "vit": 30, "int": 85, "dex": 186, "luk": 85,
  "race": "Demon", "size": "Large", "property": "Dark", "propertyLevel": 3,
  "res": 0, "mres": 0 }
```

**`res` / `mres` are nullable, and `null` is not `0`.** `0` means the monster
genuinely has no resistance — true of 2,570 of the 2,724 records, Baphomet above
included. `null` (18 records) means *unknown*: divine-pride has no usable data for
that monster. Consumers must keep the two apart. Treating an unknown resistance as
0 puts a level 224 MVP's simulated damage at roughly **3.3×** what the server
actually deals. All 136 non-zero resistances belong to level 200+ monsters.

It is rebuilt from two sources, split by which one is authoritative for what:

| | authority for |
| --- | --- |
| [RagnaPlace Public API](https://ragnaplace.com/pt/api/reference) | identity (`id`, `aegisId`) and the pt-BR `name`, plus the whole stat block |
| [divine-pride.net](https://www.divine-pride.net) | `res` / `mres`, which exist in no other source |

RagnaPlace needs a `RAGNAPLACE_API_KEY` in `.env` (request one at
<https://ragnaplace.com/api>); divine-pride is crawled anonymously.

```bash
node extract-grf.mjs --mobids _scratch/mobids.json --grf path/to/data.grf
node tools/scrape-mobs.mjs --ids _scratch/mobids.json --no-dp   # first run only
node tools/crawl-divine-pride.mjs                               # ~1 h, resumable
node tools/scrape-mobs.mjs --merge-only                         # no API quota
```

The first two steps are split because neither source is sufficient alone. The API
has no bulk mob endpoint — its search caps at 20 pages × 20 rows — so every monster
needs its own `GET /v1/<gateway>/mob/<id>`, and the id list to walk has to come from
the client's `datainfo/npcidentity.lub` (`--mobids`, ~4585 candidates; the ~1900
that aren't monsters simply 404). `--gateway` selects the server (default
`laro-pt`; `/v1/gateways` lists all 36). The run throttles itself off the API's
`X-RateLimit-*` headers and resumes from `mobs.json.partial.jsonl` if interrupted.

Once `mobs.json` exists, the crawler walks *it* rather than the client's id list,
sparing divine-pride ~1900 requests for ids that aren't monsters. It is serialised
with a delay, caches every parsed record in `_scratch/dp-cache.jsonl` and reuses
anything younger than 30 days, so re-runs are nearly free and an interrupted crawl
resumes. `--merge-only` then folds the result into the existing `mobs.json` without
touching the RagnaPlace API at all, so refreshing the resistances doesn't cost the
key's whole quota.

### Cross-validation

Everything **both** sources publish — level, HP, DEF/MDEF, the six base stats,
race, size, element and element level — is compared, and any disagreement
**fails the run without writing `mobs.json`**, reporting both values and a link
to the monster's page. Neither source is silently preferred: a divergence means
either the crawler broke or the two databases genuinely differ, and only a human
can tell those apart. Acknowledge one by adding it to
[`tools/dp-divergences.json`](tools/dp-divergences.json); the entry matches only
while both recorded values still hold, so a re-review is forced the moment either
source moves. `attack` is deliberately *not* compared — RagnaPlace returns the
database's raw attack and divine-pride renders the computed renewal range
(Baphomet: `2520` vs `2,721 - 3,981`), so they are different quantities.

Across the full catalogue this found **82 disagreements on 39 of 2,710 monsters**,
all reviewed and recorded. The largest cluster is instructive: RagnaPlace reports
`propertyLevel: 1` for all 20 `E_*`/`EVENT_*` event-clone MVPs, while divine-pride
reports a varied value that — on the 13 clones whose base monster can be
identified — is exactly the base's, on which the two sources already agree. A
uniform `1` across clones whose bases span levels 1–4 is a default, not data, so
those 20 now publish divine-pride's value. That is the only pre-existing field the
second source changed.

A ledger entry may also carry `"resistances": "unknown"`, which makes that monster
publish `res`/`mres` as **null** rather than divine-pride's number. It exists for
the four records where divine-pride's page is a dummy (level 1, 10 HP) describing
something other than the monster RagnaPlace has real data for: its `0` there is
not a measurement, and publishing it would be the very mistake this source fixes.

### The one detail that will silently ruin a divine-pride scrape

A monster page renders one stat table per server/episode, each in a
`<div class="alternatestats" id="alternatestats_<SOURCE>">`. LATAM is
`alternatestats_default`, and it is **not the first** — on Poring the order is
iRO, kRO, twRO, vnRO, *then* default. The blocks disagree (iRO's Poring has 60 HP
and 13–16 attack; LATAM's has 55 and 7–8), so a positional selector yields another
server's monster, plausibly and silently. The crawler selects by id and raises a
hard error if the block is missing rather than falling back.

Three further states all mean *unknown* and must not be mistaken for a broken
page — or for zero. An unknown id answers **HTTP 200** with a "Monster not found"
page, not a 404. A monster the site lists but has no numbers for renders every
cell as `?` with the title "We don't have this yet" and ships no per-server blocks
at all (25239 `C4_SASQUATCH`). And ten monsters get a stat block that is simply
blank — level 0, 0 HP, every stat 0 — including six Byalan mobs with perfectly
good RagnaPlace records, so taking those zeros at face value would assert "no
resistance" on the strength of an empty page. Note that 0 HP *alone* is not the
test: 1210 and the twelve Agni/Varuna/Vayu/Chandra spirits carry 0 HP with a real
level, and RagnaPlace independently agrees.

### Testing the crawler without redistributing their pages

**No divine-pride HTML is checked in.** Copies of their page source would put
their markup into this MIT-licensed repo, so the fixtures in
[`tools/crawl-divine-pride.test.mjs`](tools/crawl-divine-pride.test.mjs) are
*written*: `page()` and `statBlock()` emit only the structure the parser keys on.
The stat numbers in them are game facts, which is a separate thing from
divine-pride's expression of those facts.

Written fixtures can only encode what we *believe* the markup is, so the same
file carries four **opt-in live checks**:

```bash
DP_LIVE=1 node --test tools/crawl-divine-pride.test.mjs
```

They fetch four real pages and assert the written fixtures still describe
reality — including that `alternatestats_default` is still not first *and* still
disagrees with the first block, the assumption the whole parser rests on. Plain
`node --test` skips them and stays hermetic. Run the live pass whenever you touch
the parser, or before trusting a crawl after a long gap.

This file used to be committed at the repo root and consumers fetched it from
`raw.githubusercontent.com`. It now lives in the gitignored `resources/raw/`
alongside the extracted tables and is served at `/raw/mobs.json`, so there is one
delivery path for all of it. Regenerating it costs a full rate-limited walk of the
API, so keep the deployed copy — it is not recoverable from a checkout.

## Credits & license

- **[zrenderer](https://github.com/zhad3/zrenderer)** by **[zhad3](https://github.com/zhad3)**
  — the original D renderer this project's `internal/render` engine is ported
  from. All the hard-won RO sprite knowledge (formats, layering, head direction)
  is theirs; please star and support it.
- The GRF extractor's DES routine is ported from
  **[grf-loader](https://github.com/vthibault/grf-loader)** (MIT). The GRF reader,
  the icon pipeline and the mini Lua 5.1 VM originate from
  `adsonpleal/ragreplaystats`.
- The monster stats in `/raw/mobs.json` (level, HP, EXP, DEF/MDEF/ATK, base
  stats, race, size, element, boss/MVP flags) come from
  **[RagnaPlace](https://ragnaplace.com)**, via their
  [Public API](https://ragnaplace.com/pt/api/reference) — thanks to them for
  compiling and publishing per-server RO database data, and for offering a proper
  keyed API for it. That table is the only data here sourced from them;
  everything else under `/raw` is extracted from the client GRF. If you find it
  useful, visit and support the site.
- The `res` / `mres` resistances in `/raw/mobs.json` come from
  **[divine-pride.net](https://www.divine-pride.net)**, which is the only public
  source that publishes them per server. The crawler fetches one page per monster,
  serialised and cached, and takes nothing else from the site. Thanks to them for
  maintaining it — please visit and support the site.
- Ragnarok Online and its assets are © Gravity Co., Ltd. No game assets are
  included in or distributed by this repository.

This project is licensed under the **[MIT License](LICENSE)** — do whatever you
want with it.
