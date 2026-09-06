# Changelog

All notable changes to this project are documented here. The project deploys
continuously (no version tags), so entries are grouped by date.

## 2026-09-06

### Fixed
- **Renders were never cached, only their inputs.** Paperdolls came back slower
  after the Cloudflare cutover than the EC2 gateway they replaced: measured from
  GRU, an identical `/image` URL took ~160 ms TTFB against ~85 ms to EC2, and a
  first-seen URL 350-550 ms. Production responses carried no `CF-Cache-Status` at
  all, which is the whole story — on a Worker route the Worker runs *in front of*
  the cache, so a response it returns is never stored, and every request
  re-planned, re-read and re-rendered a paperdoll that had been produced seconds
  earlier.

  `R2Store` already caches sprite bytes per colo; nothing cached the finished PNG.
  Now `/image` and `/gif` store their output in the same colo cache, keyed by
  `api.ETagFor(query)` plus the deploy epoch — the same invalidation contract the
  resource cache relies on, so new assets mean a new key rather than a stale hit.
  A repeat is a local read and no wasm CPU.

  The layer matters more than the CPU saving. A colo runs several instances of
  this Worker at once — five, sampled over ten sequential requests to `/debug/r2`
  — each with its own parse caches and its own copy of the 1.44 MiB existence
  manifest, and requests round-robin between them, so the in-isolate LRU only ever
  sees a fraction of the repeats. The Cache API is per-colo, shared by all of
  them, and survives isolate eviction: it is the only layer in the stack that sees
  a repeat as a repeat.

  `handleRender`'s tiers are now ordered by cost, and `setupRender` is no longer
  first: a 304 or a cache hit is answered without downloading and parsing the
  manifest an isolate would otherwise pay for on its first render.

- **The prefetch batch re-fetched sprites the isolate had already parsed.**
  `Prefetch` pulled every key a plan named, unconditionally, so a render whose
  body and head were already in the Manager's LRU still dragged tens of kilobytes
  per key back across the JS boundary for the Manager to discard. This is the
  *different* URL that shares sprites with one already served — every preview on a
  paperdoll grid shares a body and a head — which is exactly the case the render
  cache above cannot help with. `resource.Manager.Cached` (and `SplitKey`, its
  inverse of `Key`) answers what is already held, and `handleRender` drops those
  keys from the batch. The answer is advisory in one direction only: an eviction
  between the probe and the render just sends that key down the ordinary path.

## 2026-09-04

### Added
- **`/effects/stones.json` — the graphic stones.** The *Pedras Gráficas* from
  Malangdo's Loja Fashion are not costumes: a stone goes *inside* a costume
  already equipped in a position, and what it plays is a hat effect — the same
  `.str` system `--effects` already extracts. `--effects` now writes a catalogue
  of them next to `index.json`, keyed by the **stone's** item id (the tradeable
  one a shop lists, not the enchant it becomes), and builds the bundles it names.
  12 of the 29 stones resolve; a stone with no entry means "no preview", which
  the consumer already treats as such.

  The chain is stone → enchant → `HAT_EF_*` → `.str` and the client owns only
  half of it. `HatEffectInfo.lub` maps every `HAT_EF_*` to the file it plays, so
  that half is read live and a client update repaths it (reading it needs
  `HatEffectIDs.lub` loaded into the same Lua globals first, or every row keys on
  `nil` and the table collapses onto one). Nothing in the client links an item id
  to a `HAT_EF_*` — the server does, running the enchant's `hateffect` script — so
  that half is the hand-written `STONE_HAT_EFFECT`, transcribed from rAthena's
  `item_db` and cross-checked against each enchant's own `resourceName` where that
  name is specific rather than the generic `블루크리스탈조각`. Six of its rows are
  confirmed by eye against the extracted textures, because an effect's *name* is
  no guide to what it draws: `HAT_EF_magical_feather` draws hearts (*Corações*),
  `HAT_EF_LJOSALFAR` sparkles (*Cintilação*), `HAT_EF_ResonateTaego` a dragon
  (*Dragão Alado*), `HAT_EF_C_Time_Accessory` a clock face and hand (*Relógios*),
  `HAT_EF_WATER_BELOW4` a pool of water (*Poça d'Água*), and *Fantasmas* is
  `HAT_EF_C_Ghost_Effect`, whose texture is a ghost.

  The 17 that produce nothing split three ways, and the distinction is the point
  of the report. **10 are compiled into the client** — a `hatEffectID` row with no
  `resourceFileName`, so no `.str` exists. Eight of those have no asset at all;
  the other two, *Raios Vermelhos* and *Espaço Digital*, name a played sprite the
  same run already bundles at `/effects/sprites/eff_<id>/`, which the report now
  points at rather than calling them unrenderable — a different bundle shape, so
  not a `stones.json` key as the file stands. **6 are footprints**, a decal
  stamped per footstep out of two `.str` plus placement, which one bundle key
  cannot describe, so they are reported rather than forced into the same shape.
  And *Ventania* declares `HAT_EF_Golden_Aura_TW` in `HatEffectIDs.lub`, then
  gives it no row in any table and ships no `.str`.

### Fixed
- **Every CI deploy stamped the same cache epoch.** `DEPLOY_EPOCH` is baked into
  the wasm binary and forms part of every edge-cache key, so bumping it is how a
  deploy invalidates the colo cache wholesale — the only invalidation available,
  since purge-by-URL is capped at 30 URLs a call and roughly 1,000 a day, and
  purge-by-prefix is Enterprise-only.

  It defaulted to `git rev-list --count HEAD`, which rises on every commit. Except
  under `actions/checkout`, which clones shallow: the count is **1** on every
  commit, so the first CI deploy went out as epoch 1 and every later one would
  have too. The failure is silent in the worst way — the build passes, the deploy
  passes, and a client patch uploads to R2 while the edge keeps serving the bytes
  it already had. `deploy.yml` now passes `github.run_number`, and
  `build-worker.sh` refuses the commit-count default under a shallow clone rather
  than emitting a number it knows is wrong.

- **A `/gif` validator could win a `304` on `/image`.** The Worker tested
  `strings.Contains(ifNoneMatch, etag)` — an unquoted substring match. `/gif`'s
  ETag is `/image`'s with `-gif` appended, so a client holding `"<hash>-gif"` that
  asked for `"<hash>"` matched, and got a 304 for bytes it does not have. The
  server's comparison walks the comma-separated list and compares whole quoted
  entries, which cannot do that; both now share it, in `internal/api`.

- **The two origins published different ETags for identical bytes.** The server
  hashed the embedded `/effect/table` and `/effect/skill-map` blobs to 64 hex
  characters, the Worker to 32. Both now use `api.ETagForBytes`.

- **`/effect/sound` did not fold case on the Worker.** `?file=StormGust` resolved
  on the server and 404'd on the Worker, because the bucket is lowercased on
  upload and only the server's `soundPath` lowercased the token.
  `tools/diff-origins.sh` had no `/effect/sound` case and compared only status and
  bytes, so it could not have caught this — it now compares `Content-Type` too,
  which immediately caught a second one (`.wav` responses briefly going out as
  `application/octet-stream`).

- **`tools/*.sh` had never been executable.** Mode 644 since they were added,
  which never mattered while everything ran as `bash tools/…` locally. The
  workflows invoke them as `./tools/build-worker.sh`; the first CI run exited 126.

### Changed
- **Cutover: `assets.latam-tools.com.br` is served by the Worker.** The hostname
  was an unproxied `A` record straight to the EC2 box, which is why all ~27M
  monthly requests reached the origin and why ~$31 of the ~$50–60/month bill was
  São Paulo egress. It is now a Cloudflare custom domain in front of the Worker,
  and the bill is the $5/month Workers Paid base — everything else sits inside an
  included tier.

  Gated on `tools/diff-origins.sh` against the old origin, still reachable at
  `ragassets.duckdns.org` because Caddy serves both hostnames from the same box:
  **393 of 400 real production URLs come back byte- and `Content-Type`-identical**,
  2 are 404 on both, and 5 differ because the EC2 tree is serving sprites older
  than the ones in the GRF — the Worker is the more correct of the two there.
  Icons still answer `max-age=31536000, immutable`, which is the check that
  matters: it confirms they are still coming from Static Assets rather than the
  Worker, and so are still free and unmetered. `/raw` still answers
  `max-age=300, must-revalidate`.

  **EC2 is deliberately still running.** Rollback is repointing the hostname at an
  `A` record for `18.231.251.11`, DNS-only. It should not be decommissioned until
  a full client patch has run through the new pipeline — as of this entry the poll
  has had nothing to do, so the upload, manifest-rebuild, redeploy and announce
  steps have been exercised only by a dry run.

  Two things surfaced during the flip:

  - **`triggers` is inherited by named environments, and both environments share
    one KV namespace.** Deploying production attached a cron while staging still
    had one, so for a few minutes two pollers were reading and writing the same
    `last_seq` — either could dispatch a patch the other had, or advance the state
    past work neither did. Staging is now pinned to `crons: []`; production is the
    only poller.
  - **Production is the top-level config, not a named environment.** That is
    deliberate: the top-level config owns the custom domain, and an
    `env.production` would be a second Worker under a different name competing for
    the same hostname. So deploying production takes no `--env`, and both
    workflows now map the target name to a flag rather than passing it through.

- **A cleanup pass over the migration** — reuse, simplification, efficiency and
  altitude — with behaviour held fixed by replaying 400 real production URLs
  against both origins.

  The substantive one: `Prefetch` built a 48 MB `MapSource` and its only caller
  discarded the return value, so every key was read twice and the isolate briefly
  held a second copy of the render's whole working set. It is a colo-cache warmer,
  so it now says so and returns nothing — the mutex, the map and the byte budget
  go with it. Alongside: the Worker was inheriting the server's cache budgets
  (144 MiB, inside a 128 MB isolate — now 24/12 MiB); the existence manifest was
  read straight off the R2 binding rather than through the epoch-keyed cache, one
  billed operation and 1.44 MiB per isolate cold start rather than per colo per
  deploy; and `serveObject` hashed a 2–4 MB BGM body before it could answer a
  conditional request, discarding all of it on the 304.

  `parsePatchList` existed twice — in the poll that decides which sequences are
  new and in the applier that decides which to fetch. Drift between them either
  updates nothing or advances `last_seq` past a patch that is then never revisited,
  so it is now one module both import.

- **The "sequence below 1000" guard was measuring the wrong thing.** It tested the
  starting sequence as a proxy for how much work a run would do, which fails in
  both directions: it rejects a legitimate `from=999` and accepts `from=1200` when
  the head has moved to 5000. `tools/apply-patches.mjs` now caps the number of
  archives one run will apply (60, `--max` to override deliberately), which is the
  resource actually at risk.

## 2026-09-03

### Added
- **The service runs on Cloudflare.** Same renderer, two front ends: a Worker
  holding the Go engine compiled to WebAssembly, and Workers Static Assets in
  front of it. Egress was the entire bill — roughly $31 of the ~$50–60/month went
  on São Paulo bandwidth for ~310 GB across ~27M requests — and Cloudflare charges
  nothing for it. Measured on staging, the whole thing lands at about **$5/month**,
  which is the Workers Paid base; everything else is inside an included tier.

  The tiering is a cost decision. Icons are **69% of all traffic** and 95% of their
  URLs repeat, so they are served as static assets, where requests are free and
  unmetered, and never reach the Worker's request budget. Renders are the
  opposite — **93% of `/image` URLs are unique**, so the CDN cannot help and each
  one has to be cheap to compute.

  What makes R2 affordable is that unique URLs do not imply unique reads: the
  sprite files behind them are heavily shared, so `caches.default` absorbs nearly
  everything. Against Cloudflare's own `r2OperationsAdaptiveGroups`, replaying 150
  real production URLs: **0.85 GetObject per render cold** (straight after a deploy
  bumps the epoch), 0.58 partially warm, **0.03 fully warm** — against a 6.47-key
  average plan. Even the cold figure extrapolates to 6.8M operations a month,
  inside the 10M free tier. A design estimate of ~8 gets per render had put this at
  $19–25/month and called R2 the dominant cost; the measurement is 9–260× better.

  Two things about that cache are easy to get wrong, and both are now written down
  where they are relied on: `caches.default` is **inert on `*.workers.dev`**, so a
  hit rate measured there measures nothing; and the cache key carries a deploy
  epoch, because there is no workable purge at this scale.

- **`tools/sync-r2.sh`, and what does not belong in R2.** The renderer's inputs,
  maps, bgm and sounds go to the bucket (~15 GB); icons, illust, effects and raw
  do not — they are 39,241 files and 298 MB served by Static Assets, which caps at
  100,000 files and 25 MiB each. `data/luafiles514` is baked into the binary at
  build time and is mirrored but never read at runtime.

  rclone against the S3 endpoint, not `wrangler r2 object put`: the REST API that
  uses is rate-limited to about 1,200 requests per 5 minutes — measured, the first
  429 landed after 1,327 — which would have put a full sync at roughly 16 hours.

- **CI, and an automated update pipeline.** There was no `.github/` at all. A push
  to `main` now runs both test suites, checks formatting, cross-compiles the
  renderer to wasm, hydrates the static tree and deploys — then asserts that an
  icon still comes back `immutable`, which catches both of the configuration traps
  that cost real money (`run_worker_first` becoming a boolean, and Static Assets'
  `max-age=0, must-revalidate` default reasserting itself).

  The game patches two or three times a day, and updating assets had been a manual
  local extraction followed by a sync. A cron trigger polls the LATAM patch index
  every 10 minutes with a conditional request — 304 in 0 bytes and ~130 ms,
  ~4,380 invocations a month — and dispatches a workflow that unpacks the new
  patches, uploads what the Worker serves, rebuilds the manifest, redeploys to bump
  the epoch, and announces the result. `patch.txt` ships
  `Cache-Control: max-age=3600`, so the poll's fetch has to opt out explicitly or a
  ten-minute poll silently becomes hourly.

  The announcer posts to `#novidades` through the Discord bot REST API, like the
  four sibling projects, but the body is counts computed from what the patch
  actually delivered rather than hand-written changelog prose — and it posts
  nothing when nothing user-visible changed.

  **Not yet rebuilt by the pipeline:** icons, illust, raw, maps, bgm and sounds.
  Those modes need a merged view of the whole client rather than one patch, so for
  now a patch that adds an item updates its sprite but not its icon.

## 2026-09-02

### Added
- **The renderer can serve from an object store.** `internal/render/resource` grew
  a `Source`/`Existence` seam — bytes and existence, separately — with the
  filesystem behind it on the server and R2 behind it on the Worker. The engine,
  the caches and every parser below them are unchanged and unaware.

  Splitting existence out is the point. The renderer probes far more often than it
  reads: resolving a garment alone can test a dozen candidate `act`/`spr` pairs
  before one hits, and each of those is a stat against a local disk but a network
  round trip against a bucket. So `BuildPlan` now resolves a request — every key it
  may touch, plus the three decisions that were being made mid-render by probing —
  before a single byte is read, and `RenderPlanned` renders against that plan.
  `Render` is `RenderPlanned(req, Plan(req))`, one code path, so the golden tests
  still guard the real thing.

- **A baked existence manifest.** 188,153 keys as sorted FNV-1a 64 hashes, 1.44 MiB,
  binary-searched — `cmd/gen-manifest`. It covers the whole tree the Manager can
  read rather than only the three subtrees that are probed today, because coupling
  it to which probes exist would mean a probe added later gets a confident wrong
  answer. It lives in R2 rather than compiled in, so shipping new sprites is an
  upload instead of a redeploy.

- **The extractor reads patch archives.** Three formats it could not: **GRF v1**
  (`0x100`/`0x101`/`0x102`), which is what every `.gpf` patch is — encrypted
  filenames, extension-derived DES, the `compSize`/`compSizeAligned` fixups;
  **`.rgz`**, the loose half of a patch set carrying `System/**`, `RagHash.dat` and
  `Ragexe.exe`; and a **mirrored client directory** presented as if it were an
  opened archive.

  That last one matters more than it sounds. Only `--extract` is correct when run
  against a single patch: `--raw` and `--illust` throw without tables the patch
  does not carry, and `--effects`, `--maps` and `--icons` fail *silently or
  destructively* — `--effects` rewrites its `index.json` from whatever it happened
  to resolve, clobbering the whole catalogue. Letting every mode read a merged tree
  is what makes incremental updates safe rather than a source of quiet corruption.

- **`extract-grf.mjs --robe-index`**, so the robe prune decision can be made from
  a `path → md5` index instead of hydrating 4.5 GB of sprites to re-derive it.

### Changed
- **The cache budgets were counts, and the counts implied 219 MB.** 2000 `.spr` and
  3000 `.act` entries, against measured averages of 41.1 KB across 81,040 sprites
  and 45.6 KB across 102,345 act files — already over budget on the 500 MiB box and
  nowhere near a 128 MB isolate. The doc comment putting `.act` at "~15 KB" was
  stale by 3× and is what made the counts look safe. They are byte budgets now,
  with a 2 MiB per-entry ceiling so one 19.5 MB monster sprite cannot evict the
  entire hot set behind it.

- **No JSON parsing and no `regexp` at startup.** The generated lookup tables were
  352 KB unmarshalled in `init()` — a cost paid on every cold start, and
  `encoding/json`'s reflection is the single biggest obstacle to compiling for a
  WebAssembly target. `cmd/gen-tables` now turns the same committed JSON into Go
  source, so the JSON files stay the reviewable artifact and a client update is
  still a readable diff. `ParseCanvas` lost its regexp for a hand parser.

- **The golden tests stopped skipping.** They passed vacuously in any tree without
  the 16 GB `resources/` directory, which is every fresh checkout — so the one
  safety net guarding a port of the renderer was not running in CI. A minimal
  committed fixture pack now drives them, and they fail rather than skip.

## 2026-08-31

### Added
- **`contains` on `/raw/items.json` — what a box gives you.** Items like
  *[Evento] Artefato Oval Noturno* (107912) are boxes, and until now nothing in
  `/raw` said what came out of them: a catalogue had to join against a
  server-side `item_db` it may not have.

  The client ships the table itself, as compiled Lua bytecode at
  `data/luafiles514/lua files/probabilityinfo/packageitem.lub` — 1,604 boxes
  keyed by the box's own item id, each with its drop list. `--raw` now runs that
  chunk through the same Lua 5.1 VM the other tables use and hangs each list off
  the item row that opens the box, rather than publishing a second id-keyed file:
  `contains: [{ id, prob, group }, …]`. The key is present **only on a box** —
  the other 15,446 rows leave it out rather than carrying an empty array, so read
  it as `item.contains ?? []`.
  1,498 of the boxes land on an item row (the other 106 are keyed by ids
  `iteminfo_new.lub` no longer has), for 13,111 drop rows.

  `prob` is passed through **unnormalized** because the file has no single
  denominator: per-group sums land on 10000 and 20000 (basis points) for the
  gacha-style boxes but on 1, 2, 3, 10… for the fixed-contents ones, and 552
  groups sum to 0. `group` is the sub-pool — a box rolls each group
  independently. Drops are id-only: the client stores a display name inline and
  it is a worse copy of one `items.json` already has (4,776 of the 13,111 rows
  disagree, nearly all because the package table bakes in the `[2]` slot suffix
  that `slots` deliberately keeps apart).

  Read at its full `data/luafiles514/…` path, for the same reason the skill
  tooltips are: the GRF also ships `data/spanish/` and `data/english/` copies and
  the Spanish one is the largest, so a suffix-only lookup wins the wrong locale.
  `--raw` now also refuses to write an `items.json` where fewer than half the
  boxes matched an item — losing the table would otherwise look like a perfectly
  valid file with every box empty. `items.json` grows 8.2 → 9.3 MB raw, ~1.2 MB
  gzipped over the wire.

## 2026-08-29

### Fixed
- **Garment costumes that rendered as the Adventurer's Backpack.** `garment=97`
  (c_scepter) drew a backpack on every class except the 4th ones; so did
  `c_evil_scythe` (79), `c_sakura_wing` (83), `c_giantcatbag_jp_bl` (80) and
  `c_ice_wing` (71), and eleven more garments lost a handful of job slots each to
  the same thing.

  Gravity builds each `data/sprite/로브/<garment>/` folder by copying the
  `모험가배낭` ("Adventurer's Backpack") folder. It swaps in the new garment's
  per-job `.act` files and its folder-root `.spr`, but leaves the **per-job
  `.spr` files** behind as the backpack's. The client never reads them — it pairs
  a per-job `.act` with the folder-root `.spr` — so the mistake is invisible
  in-game. We *do* read them: `GarmentCandidates` offers `{per-job act, per-job
  spr}` before `{per-job act, root spr}`, so every job that inherited a leftover
  composed the garment's geometry over the backpack's pixels. Only the 4th
  classes escaped, because the folders are act-only for them.

  New `extract-grf.mjs --prune-robes <resources-dir>` deletes the leftovers from
  the extracted tree; the `{per-job act, root spr}` pair already in the candidate
  list then takes over on its own, so the resolver is unchanged. **Run it after
  every `--extract`** — it is idempotent, and it works on an already extracted or
  deployed `resources/`. In this client: 2090 sprites across 21 folders.

  A leftover is identified by **content**, never by position. "The root `.spr`
  always wins" would be the easy rule and it is wrong: 201 of the 218 robe folders
  are healthy and many (`c_giant_white_rabbit`, `c_niflheim_key`,
  `c_samba_carnival`) ship genuine per-job image banks that differ from their root
  `.spr` and have to keep winning. The rule is that a content shared by ten or
  more distinct robe folders cannot be any one garment's artwork — eight contents
  appear in 18–20 folders each, the next-largest sharing group is 4, and all eight
  decode to the backpack. Seven of them are that bag drawn for a different body,
  the per-job variants `모험가배낭`'s own folder no longer ships, so matching only
  `모험가배낭/모험가배낭.spr` byte-for-byte would have left ~260 bad slots behind
  — mostly the mounted jobs of `blackcatbag`, `c_traveller_bag` and the like,
  which were showing the *adventurer's* backpack rather than their own.

  Extraction itself was never at fault: the extracted bytes match the GRF.

- **`c_snow_powder` (view 100, *[Visual] Aura Nevada*) is a `.str` effect, not a
  garment.** Its robe folder is pure template — all 267 per-job sprites are
  backpack leftovers and there is no folder-root `.spr` — so once pruned it has no
  artwork anywhere in the client. `drawsNothing` now has a garment branch
  (`GARMENT_TEMPLATE_ONLY`) so `--effects` picks it up, and it resolves
  `efst_snow_powder/ssnnnn2.str` by the ordinary name rule: a 25-layer snowfall,
  now served at `/effects/c_snow_powder/`. `--prune-robes` reports any folder it
  empties, which is how the next one will surface.

## 2026-08-23

### Added
- **`GET /illust/card/{id}.png` — the full-size (300×400) card artwork**, plus the
  `extract-grf.mjs --illust` step that produces it. This is the one item picture
  `/icons` never had: cards all share a single generic inventory icon and a single
  generic description image (their iteminfo resource name is 이름없는카드,
  "nameless card"), so `/icons/collection/4001.png` and `/icons/collection/4302.png`
  are byte-identical. The real art lives in
  `data/texture/유저인터페이스/cardbmp/` and is reached by a different key
  entirely — the client's own `data/num2cardillustnametable.txt`
  (`<item id>#<bmp basename>#`) rather than an iteminfo resource name.

  It is a new route rather than an `/icons` kind because it is an illustration,
  not an icon — 12× the pixel area of the `collection` image, keyed off a
  different table. `/illust/{kind}/` leaves room for the client's other
  illustration folder (`유저인터페이스/illust/`, NPC portraits) without inventing
  a third route; `handleIcon` and `handleIllust` now share one `servePNGByKind`.

  **The name table has to be read by first-hit, not last-hit.** ~190 ids are
  re-pointed at the client's `sorry` placeholder by a block appended to the end
  of the table, and for the 마신의정수 cards that block buries artwork that is
  still shipped; conversely id `4557` names art that was never shipped
  (약화된펜릴카드) before naming art that was (펜릴카드_). So the extractor takes
  the first name that resolves to a real file and never the placeholder. Ids left
  with nothing — 192 placeholder-only, 4 never shipped — are skipped, so they
  `404` instead of serving ~190 copies of the same apology bitmap.

  Card BMPs are also full-bleed artwork with no colorkey, so they are written
  fully opaque (`bmpToPng({opaque: true})`): a magenta pixel in a card
  illustration is part of the picture, not a transparency key.

  1,095 PNGs, ~110 MB. `ILLUST_DIR` points the gateway at the store; like every
  other optional tree, a missing one just 404s.

## 2026-08-22

### Added
- **Skin tone on `/image` — `skinTone=1..4` and `skinColor=RRGGBB`** — a fan-made
  capability, stated as such in the README: Ragnarok Online has no skin-tone
  option, no client or server sends one, and no official sprite ships in more
  than one tone. The ramps are generated here from the sprites' own palettes.
  `skinTone=1` is the untouched original and is byte-identical to omitting the
  parameter. `skinColor` takes a custom colour and builds a full 8-step ramp from
  it, anchored so the colour you pass is the dominant lit midtone — not a flat
  fill. Doram is out of scope and the parameters are ignored there rather than
  erroring.

  Ramps are built in Oklab. Darkening a skin ramp in HSL drags it toward grey and
  purple, because HSL "lightness" is not perceptual; in Oklab the original ramp's
  relative lightness spacing can be preserved, so the sprite keeps its own
  shading and only the tone moves.

- **`cmd/gen-skin-table`** — bakes `internal/render/skin/data/skin_table.json`:
  which palette indices hold the skin ramp, per sprite. Two things make this a
  bake rather than a rule.

  First, the ramp is **not at a fixed palette position, and there is not always
  only one of it**. The Wanderer's default body keeps skin at 48–55; her
  `costume_1` body keeps it at 43–50; `타조원더러_여` carries it at 48–55 *and*
  240–247; and `미케닉_남_1` has no eight-long run at all because it never uses
  the lightest highlight. So the generator maps every palette index carrying a
  canonical skin colour to the ramp step it represents, rather than hunting for
  a single range. 51 body sprites hold skin in more than one place.

  Isolated skin-coloured indices are only accepted when their pixels are drawn
  touching confirmed skin. That is what keeps the mounts out: a poring is pink
  and a toad is brown, and 23 indices across the library match a skin colour
  exactly while belonging to the animal, not the rider.

  Second, and the trap worth writing down: **one palette index means two
  different things**. Index 216 (sometimes 217 or 232) is a hair highlight *and*,
  in most head sprites, the face's specular highlight. No palette swap can
  separate them — the same index has to come out two different colours in the
  same frame. So ~1,800 pixels across the 84 head sprites are identified at bake
  time and repainted individually after decoding. Each carries its position on
  the skin ramp rather than a colour, which is what keeps a hair dye from leaking
  into the face.

  Because a `.spr` is a flat image pool that the `.act` merely indexes, a
  palette-level recolour covers every action, direction and frame at once; the
  per-pixel repaints are keyed by image index, so they do too.

## 2026-08-21

### Added
- **`31089` *Fúria dos Shuras* renders** — the last of the six new costumes still
  invisible, and the only one whose visual is neither a costume sprite nor a
  `.str`. Its accessory sprite is blank by design; what the client draws instead
  is a *second sprite*, `data/sprite/아이템/c홍염의폭렬파동_이펙트` — 27 frames of
  crimson flame, 91 layers, played on a loop at the character's head.
  `/image?job=1&headgear=1500` is no longer byte-identical to a render with no
  headgear, and it is the effect's timeline, not the body's, that now sets the
  animation length.

  The chain is the client's own: `EffectHatItemTable` lists `31089` as a hat
  effect, `HatEFID.HAT_EF_BAKURETSU_HADOU = 47`, `hatEffectTable[47]` points at
  effect `1130`, and roBrowser's port of that effect table has it as
  `type: 'SPR'` — a played sprite with `head: true` and `yOffset: -50`, not a
  `.str`. The renderer uses that offset verbatim; the body's own head attach
  point sits at `-56`, so it lands where the client puts it.

  Nothing is hard-coded to the id. The link is the name: the accessory table's
  value for view `1500` is `_C홍염의폭렬파동`, and the sprite is that name plus
  `_이펙트` under the item sprite folder. It is the only file in the whole GRF
  carrying that suffix, so the rule cannot collide, and a future costume of the
  same kind is picked up without a table entry.

  The same sprite is served as a bundle at `/effects/sprites/eff_1130/` (27
  composited frames + `sprite.json`), so a consumer that plays effects by id —
  the `.rrf` replay viewer — gets it too. That id used to fail to build: the
  ported effect table names it `bakuretsu_hadou/bakuretsu_hadou`, a path this
  client does not ship, and a new `SPR_EFFECT_OVERRIDE` (the SPR side of
  `STR_OVERRIDE`) redirects it to the Korean resource name.

  One trap is worth writing down: `EffectHatItemTable` is **not** indexed by
  `HAT_EF` id. Its keys are a contiguous `1..109` — a flat list of the items that
  have a hat effect — so joining it to `HatEFID` by number yields plausible
  nonsense (`HAT_EF_Blossom_Fluttering` → `20522` *Miaura*, with the item that
  really is `흩날리는벚꽃` one row later, and `31089` → "cloaking"). There is no
  item → `HAT_EF` link in the client's lua at all; it comes from the server.

- **Six more effect-only costumes are served** — `/effects/index.json` goes from
  18 to 24 items, and the unresolved list drops from 12 to 6:

  | item | resource | bundle |
  |---|---|---|
  | `19871` Ritmo do Momento | `음계의오오라` | `decoration_of_music` |
  | `20154` Folhas Outonais | `흩날리는낙엽` | `maple_falls` |
  | `20285` Aura de Amatsu | `흩날리는벚꽃` | `blossom_fluttering` |
  | `31091` Chuva Dourada | `c골드샤워` | `gold_shower` |
  | `31092` Chapéu do Coelho Elegante | `토끼리본모자` | `rabbit_aura` |
  | `410231` Chá das Maravilhas | `Teaparty_Wonderland` | `teaparty_wonderland` |

  These are the costumes whose effect folder is romanized, so `efst_<res>` can't
  find it. The picks are not guesses from the folder name: the client ships
  `HatEffectInfo/HatEffectInfo.lub`, which maps every `HAT_EF_*` id to the exact
  `.str` it plays, and each of the six is that table's own answer. Loading it
  needs `HatEffectIds.lub` in the same Lua globals first, or the table's keys
  come back unresolved and it looks like a one-entry file.

  That table also settles the folders holding more than one `.str`, which is why
  `흩날리는낙엽` takes `maple_falls.str` and not the `dandan1.str` sitting beside
  it. Each bundle was checked against its textures before landing: `maple_falls`
  is an autumn maple leaf, `blossom_fluttering` a cherry petal, `gold_shower` a
  coin in five rotation frames, `decoration_of_music` musical notes,
  `rabbit_aura` a rabbit face and a carrot, `teaparty_wonderland` a teapot and
  the four card suits.

  The six that stay unresolved have nothing to serve: `20535` *Holograma
  Futurista*, `20950`/`24422` (the Sura level auras) and `31819` *Capacete de
  Dullahan* have an empty `resourceFileName` in the client's table, `31089`
  *Fúria dos Shuras* isn't in it at all, and `400149` *Aura de Betelgeuse* names
  `efst_black_thunder/ros2023_f.str` — which this client's GRF does not ship.

- **Every `type:"SPR"` effect now builds a bundle** — the `--effects` skill-SPR
  step went from 60 built / 9 unresolved to **68 built / 0 unresolved**, and the
  ninth (`145`) moved to the STR set. Four separate causes, none of them the same
  bug:

  | ids | why it resolved to nothing | fix |
  |---|---|---|
  | `1130` | the ported name is another client's | `SPR_EFFECT_OVERRIDE` (above) |
  | `ef_mandragora_attack`, `ef_hydra_attack` | `"../npc/x"` walks out of the effect folder, and the GRF is a flat name list — a path still carrying `..` matches nothing | collapse the `..` before the lookup |
  | `ef_odium_attack`, `ef_drosera_attack`, `ef_mavka_attack`, `ef_entweihen_attack` | the same, plus this client keeps only two of the six under `npc/` | fall back to the Korean monster folder, same basename |
  | `683` `EF_POK_WHITE` | upstream typo (below) | `EFFECT_PART_FIXUPS` |
  | `145` `EF_SHOCKWAVE` | published as a sprite no client ships (below) | restored to `STR` |

  Both table corrections live in a new `EFFECT_PART_FIXUPS` in
  `tools/gen-effect-tables.mjs`, keyed `"<id>#<partIndex>"` and shallow-merged
  over the part, so each is a minimal delta from upstream rather than a copy of
  the entry. A key that stops matching fails the build, so an upstream fix
  surfaces instead of quietly doing nothing. Regenerating changes exactly those
  two effect ids and leaves `skill_map.json`, `effect_funcs.json` and
  `effect_provenance.json` byte-identical.

  `683` *Happy White Day Banner* names its sprite in `\xHH` escapes and one byte
  is wrong — `\x5f` (an underscore) where `\xad` belongs — so 폭죽_화이트데이
  ("firework, White Day") came out a byte short and matched nothing. The sibling
  banners (`682` 러브, `684` 생일, `686` 크리스마스) are intact. The rebuilt bundle
  renders "Happy White Day!" across 22 frames, which is its own proof.

  `145` *Shockwave Trap* was the odd one: roBrowserLegacy replaced the classic
  `STR` entry with an `SPR` one naming a sprite that is in no GRF, and left the
  original commented out directly above it — same `file`, `wav` and
  `attachedEntity`, so `type` is the entire difference. This client ships
  `data/texture/effect/shockwave.str` (60 fps, 74 keyframes, five textures), so
  the entry is restored to `STR`: `/effect/table` and `/effect/str?file=shockwave`
  answer for it now, and the table's STR count goes from 251 to 252.

### Changed
- **`spriteBlank` means "renders as nothing", not "the `.act` is blank"** — a
  blank `.act` with a hat-effect sprite behind it is no longer flagged, because
  `/image` draws it. `/raw/items.json` goes from 13 flagged items to 10: the
  three rows that share view `1500` (`31089` *Fúria dos Shuras* plus two unnamed
  ones) become ordinary renderable costumes. For the same reason `31089` stops
  being an effect-only costume — the `--effects` unresolved list drops from 6 to
  5 and `/effects/index.json` is byte-identical.

### Fixed
- **Two costumes were serving the wrong `.str` of their folder** —
  `c_sakura_fubuki` (`480296`) was built from `cherryblossoms.str` and
  `c_swirling_flame` (`480131`) from `vortexf.str`; the client's hat-effect table
  names `sakura_fubuki.str` and `vortexf2.str`, and no client table references
  the two files we were using. Both bundles are rebuilt.

  `vortexf.str` is the clearer of the two: it references a texture the GRF no
  longer ships, so it extracted as "7 textures (1 missing)" and one of its four
  layers drew nothing at all. `vortexf2.str` extracts clean at 3 layers / 6
  textures, with pixel-identical flame frames. For the sakura the textures tell
  it: `cherryblossoms.str` carries a blossom-branch garland, while
  `sakura_fubuki.str` is four tumbling petal shapes plus the flower — a petal
  blizzard, which is what 桜吹雪 means and what the costume is called.

- **`rabbit_aura` no longer publishes a frozen animation** — `toto.str` carries
  `maxKey = 1835102790` in its header for an effect whose last keyframe is 180,
  so a viewer looping on it would never appear to move. An implausible header
  value now falls back to the last keyframe. It is the only one of the client's
  258 effects that needs it; every other `effect.json` is byte-identical.

## 2026-08-20

### Fixed
- **A Korean sprite name that starts with an ASCII letter no longer decodes to
  mojibake** — `decodeClientString` only tried EUC-KR when the string had no
  Latin letter at all, and the client's accessory/robe name tables prefix every
  Korean sprite name with `_C` (`AccNameTable[1500] = "_C홍염의폭렬파동"`). The
  `C` sent all of them down the CP1252 path, so they came out as
  `_CÈ«¿°ÀÇÆø·ÄÆÄµ¿` and matched no item resource name: the reverse lookup that
  recovers a costume's view when `ClassNum` is 0 simply missed. 94 of the 3,513
  name-table strings were affected; in `/raw/items.json` **8 items gain a
  `spriteView`** (`31089` *Fúria dos Shuras* → 1500, `5979` → 1380, `20457` →
  1461, …) and **82 gain a `viewKind`**. None lost either.

  The charsets genuinely overlap, so "EUC-KR decoded cleanly" is not enough to
  decide on: `ÇÃ` is a valid Hangul double byte, and a decoder that trusts a
  clean read turns `AÇÃO` into Korean. The tie-break is the *other* reading —
  real accented text is letters all the way through and never stacks three in a
  row, while EUC-KR read as CP1252 spills long runs of symbols.

### Added
- **`spriteBlank` on `/raw/items.json`** — 13 items resolve a view whose sprite
  is there but draws nothing: every layer of the `.act` is tinted alpha 0, which
  is how the client says "this costume's visual is an effect, not a sprite". The
  renderer honours that (it skips alpha-0 layers, like zrenderer and the client),
  so `/image?headgear=1500` correctly comes back byte-identical to a render with
  no headgear at all. Only accessories do this — not one of the client's 77,774
  robe `.act` files is fully transparent.

  Without the flag the decode fix above would have *cost* two working costumes:
  `5979` *Penas Encantadas* and `20457` *Penas Coloridas* are served today as
  `.str` effects (`angel_fluttering`, `feather_fluttering`), and a consumer that
  reads their new `spriteView` as "renderable" would swap a working effect for an
  empty image. `--effects` applies the same test, so `/effects/index.json` is
  byte-identical to before this change.

  `31089` *Fúria dos Shuras* and `31091` *Chuva Dourada* are still not visible
  anywhere: their blank sprite has no `.str` behind it either. The client plays
  `data/sprite/아이템/c홍염의폭렬파동_이펙트` (1 action, 27 frames, animated
  alpha) — a sprite effect, which `/effects/sprites/` can already carry but the
  costume catalogue has no field for yet.

## 2026-08-15

### Added
- **`/raw/mobs.json` now carries `res` and `mres`** — the 4th-job resistances,
  which the RagnaPlace API exposes on no monster at all (confirmed by dumping a
  full raw record for 21360). They come from a new second source,
  `tools/crawl-divine-pride.mjs`, which is the only public database that
  publishes them per server.

  The gap was not cosmetic. Downstream, latam-ro-calc's monster importer
  correctly refuses to invent a value it has no source for, so every monster
  added since the RagnaPlace migration landed at `res 0` / `mres 0` — 368 of the
  459 in that database. A level 224 MVP therefore simulated as having *no*
  resistance: measured against a recording, non-critical damage came out at
  **~3.3×** what the server actually dealt, dropping to 1.23× once the real
  values were filled in by hand.

  Both fields are **nullable, and `null` is not `0`**. Of the 2,724 records,
  2,570 publish a real `0` — correct for any pre-4th-job monster, Baphomet
  included — 136 a non-zero value, and 18 `null` for "no usable divine-pride
  data". Every one of the 136 belongs to a level 200+ monster, which is the
  shape you would expect and a decent sanity check on the whole run.

  Conflating zero with unknown is the bug, so the pipeline keeps them apart end
  to end: a stat block that parses but carries no Res row is a hard error, not a
  null, precisely because it would otherwise be indistinguishable downstream from
  a monster nobody has data for.

  divine-pride has three separate ways of saying "no data", and each had to be
  told apart from a genuinely broken page. An unknown id answers **HTTP 200**
  with a "Monster not found" page rather than a 404. A monster it lists but has
  no numbers for renders every cell as `?` titled "We don't have this yet" and
  ships no per-server blocks at all — 25239 `C4_SASQUATCH`, which stopped the
  first full crawl 33 pages from the end. And ten monsters get a stat block that
  is simply blank: level 0, 0 HP, every stat 0. Six of those ten (2504-2509, the
  Byalan mobs) have perfectly good RagnaPlace records, so taking the zeros at
  face value would have asserted "no resistance" on the strength of an empty
  page. 0 HP alone is not the test, either: 1210 and the twelve
  Agni/Varuna/Vayu/Chandra spirits carry 0 HP with a real level and RagnaPlace
  independently agrees, so the test is level 0 *and* 0 HP.

  Authority is split rather than shared. RagnaPlace stays the source of the
  record's identity and its **pt-BR name** — it is the LATAM client's own
  vocabulary, and divine-pride serves the Korean one (21360's page title is
  `슐랑`). divine-pride is the source of the resistances and nothing textual.

  **The detail that would have silently ruined this**: a monster page renders one
  stat table per server/episode, each in a
  `<div class="alternatestats" id="alternatestats_<SOURCE>">`. LATAM is
  `alternatestats_default`, and it is *not* the first in the DOM — Poring's page
  runs iRO, kRO, twRO, vnRO, then default. The blocks genuinely disagree (iRO's
  Poring: 60 HP and 13–16 attack; LATAM's: 55 and 7–8), so a positional selector
  yields another server's monster with no visible symptom. The parser selects by
  id and raises rather than falling back, and a test asserts both that the LATAM
  block is picked *and* that renaming the first block changes the answer.

  Everything both sources publish — level, HP, DEF/MDEF, the six base stats,
  race, size, element and element level — is cross-checked, and a disagreement
  **fails the run without writing the file**, reporting both values. Neither is
  silently preferred: a divergence means either the crawler broke or the
  databases genuinely differ, and only a human can tell those apart. Across the
  catalogue this surfaced **82 disagreements on 39 of 2,710 monsters**, each now
  reviewed and recorded in `tools/dp-divergences.json` with its evidence. An
  entry matches only while both recorded values still hold, so a re-review is
  forced the moment either source moves.

  The largest cluster is worth stating outright, because it is a correction to
  data this repo has been publishing all along: RagnaPlace reports
  `propertyLevel: 1` for **all 20** `E_*`/`EVENT_*` event-clone MVPs. On the 13
  whose base monster can be identified, divine-pride's value is exactly the
  base's — and the two sources already agree on the base (2100 E_BAPHOMET2 → 1039
  Baphomet, Dark 3 on both; 2104 E_DARK_SNAKE_LORD → 1418, Ghost 3 on both; and
  so on). A uniform `1` across clones whose bases span levels 1–4 is a default,
  not data, so those 20 rows now publish divine-pride's element level. That is
  the **only** pre-existing field this change touched; every other value in
  `mobs.json` is byte-identical to before, and `res`/`mres` are appended so no
  existing key moved.

  A ledger entry can also carry `"resistances": "unknown"`, which publishes
  `res`/`mres` as null for that monster instead of divine-pride's number. Four
  records need it (2501 CORNUTUS_H, 2502 DEVIACE_H, 2503 HYDRA_H, 3819
  E_MAGIC_PLANT): divine-pride's page for each is a dummy — level 1, 10 HP,
  novice-tier stats — describing something other than the monster RagnaPlace has
  real data for, so its `0` is not a measurement of anything. Their true
  resistance is almost certainly 0 given their level, which is exactly why the
  distinction is worth keeping: the file should say what it knows, not what it
  can guess.

  `attack` is deliberately excluded from that check: RagnaPlace returns the
  database's raw attack and divine-pride the computed renewal range (Baphomet
  `2520` against `2,721 - 3,981`), so they are different quantities and comparing
  them fires on ~95% of the catalogue, burying the real findings. Race is
  normalised before comparing for the same reason — kRO renamed Demi-Human to
  `Human` and laro-pt leaks `fantasma` for `Formless` on 449 rows. divine-pride
  independently confirms both are label drift, not data drift.

  The crawl is a full pass over a third party's site, so it is serialised with a
  delay, walks the ids in `mobs.json` rather than the client's ~4600 sprite ids
  (sparing ~1900 pointless requests), and caches every parsed record for 30 days
  in `_scratch/dp-cache.jsonl` — an interrupted run resumes and a re-run is
  nearly free. `tools/scrape-mobs.mjs --merge-only` re-folds a fresh crawl into
  the existing `mobs.json` without touching the RagnaPlace API, so refreshing the
  resistances no longer costs that key's whole quota.

  divine-pride served the LATAM block anonymously throughout, so no login is
  needed; the old `.dp-cookies.json` path is still supported and now fails with
  an actionable message on an expired session or a 401/403 instead of producing
  a silently empty scrape.

  21360 Schulang (res 205, mres 368) and 21361 Twisted God Freyja (res 249, mres
  499) are the regression cases, and both now carry exactly those values in the
  published file. 21361 is the control: its def/mdef/res/mres match, to the
  number, the record an older divine-pride scraper produced before the migration
  removed it.

  The test fixtures are **written rather than scraped**: checking in copies of
  divine-pride's page source would redistribute their markup under this repo's
  MIT licence, so the tests build the minimum structure the parser keys on. The
  numbers are game facts; their expression of those facts is theirs. Synthetic
  fixtures cannot notice the site changing underneath them, so the same file
  carries four **opt-in live checks** — `DP_LIVE=1 node --test
  tools/crawl-divine-pride.test.mjs` — that fetch four real pages and assert the
  written fixtures still describe reality, including that the LATAM block is
  still neither first nor identical to the first. Plain `node --test` stays
  hermetic and skips them.

## 2026-08-13

### Added
- **`/raw/skills.json` now carries each skill's `maxLevel`.** It is what makes
  the `delay` arrays below readable — the client's window prints one row per
  level, and the arrays themselves don't reliably say how many that is.

  The value is the client's `MaxLv`, read from `SkillInfoz/SkillInfoList_data.lub`.
  That file is the trap: the GRF also ships an un-suffixed `SkillInfoList.lub`
  that parses cleanly, holds the same field and agrees on every `MaxLv` — while
  being a **stale copy of the merged table**, one skill short (5383 Invocação do
  Abismo). The live client builds `SkillInfoList_data` and folds the localized
  `SkillInfoList_ptBR` names into it at load time, which is why the numbers now
  come from the former and the names still come from the latter.

  Reading it needed the Lua VM to grow real control flow: `_data.lub` ends with a
  guarded `for k,v in pairs(…)` merge, the only branching in any data chunk the
  extractor runs, and `JMP` had until now been a deliberate no-op. `JMP` moves
  the pc, `TEST` follows Lua truthiness (`0` and `""` are true), and `TFORLOOP`
  ends its loop immediately because the iterator would come from a call and calls
  stay no-ops — so the chunk's *own* table is what gets read, never the
  `SKILL_INFO_LIST` its unrun merge targets. Three VM tests pin that down, and
  every other `/raw` table came out byte-identical afterwards.

  1,558 of 1,558 skills carry a max level. Six unreleased ones carry the client's
  own `MaxLv: 0` (`null` would mean no row at all), and the tooltips corroborate
  the rest: of the 1,179 that spell out a *Nível máximo*, 1,178 match, the lone
  exception (2535 Loja de Compras, `2` against a tooltip saying `1`) being the
  same wording drift between client tables the descriptions already showed.

- **`/raw/skills.json` now carries each skill's cast and delay times (`delay`).**
  The client grew a *Conjuração e Espera* window — Fixa, Variável, Pós and
  Recarga, one row per skill level — and the numbers behind it ship in
  `SkillInfoz/SkillDelayList.lub`, a table nothing extracted until now. It is the
  only automated source for them that is LATAM's own: the tooltip text says what
  a skill does but never how long it takes, and external databases are keyed to
  their own server's balance, not this one's.

  `delay` is `{castFixed, castVariable, afterCast, cooldown}` in **milliseconds**
  (the client's `SkillCastFixedDelay`, `SkillCastStatDelay`,
  `SkillGlobalPostDelay` and `SkillSinglePostDelay`), each a per-level array
  published **verbatim** — index `N-1` is level `N`, trailing zeros kept, nothing
  padded. Array length is deliberately *not* normalised to `maxLevel`: it usually
  matches (2,733 of the 3,044 columns), but 258 are padded past it and 53 stop
  short — 52 of those a single value meaning "same at every level", one (399
  Ataque Vital) five values for ten levels — so normalising would bake a guess
  about that last case into every consumer. 939 of the 1,558 skills carry timings; the rest (passives, and
  entries whose row the client left empty) keep `delay: null`, and a single
  missing column stays `null` rather than `[0]` so it can't be read as an actual
  zero delay. The id universe and every existing field are unchanged.

  Spot-checked against the client: Grito de Guerra (155) comes out
  300/1000/1000/30000 ms, exactly the 0.3s / 1s / 1s / 30s the window prints, and
  Nevasca's variable cast climbs 4.5s → 6.3s across its ten levels. The run now
  also fails outright if fewer than a quarter of the skills come back timed, the
  same guard the descriptions have. `SkillFlag` (8 skills) is dropped: its values
  are `SKFLAG_*` constants no shipped lua file defines.

- **`/raw/skills.json` now carries each skill's pt-BR `description`.** The table
  was `{id, name}` only, so the one place the client spells out what a skill
  actually does — its in-game tooltip — had no automated path out of the GRF at
  all. latam-ro-calc's `skill-meta.generated.ts` came from a single hand-run
  extraction in July 2026 and has been maintained by hand since, which meant any
  skill it never catalogued (Fúria Solar 435 and Fúria Lunar 436, the two that
  prompted this) simply had no text to write a formula from. The usual external
  references answer 403/402 to anything automated, and divine-pride and the Sigma
  blog disagree with each other and with LATAM, so the client's own pt-BR text is
  the source of truth here.

  The text is **raw**, exactly like `items.json`: `^RRGGBB` colour codes and line
  breaks preserved, nothing reflowed. Skills whose tooltip the client ships empty
  or doesn't ship at all keep `description: null` and stay listed — 283 of the
  1,558 (149 empty blocks, 134 with no entry), so the id universe is unchanged.

  Two traps are pinned down in code, both of which produce plausible-looking
  wrong output: the tooltips are read from `SkillDescript.lub` at its **full**
  `data/luafiles514/…` path, because the GRF's `data/spanish/` copy of that same
  file is the largest of the three and a suffix-only lookup returns Spanish; and
  the run now fails outright if fewer than half the skills come back described.
  `name` is untouched, and the descriptions corroborate it: each tooltip opens
  with the skill's own name, and 1,255 of the 1,275 match the published `name`
  exactly — the 20 that differ are wording drift between the two client tables
  ("Passos de Salamandra" / "Passos da Salamandra"), not a mispairing. The
  contested 5471/5473 pair agrees.

## 2026-08-11

### Added
- **`/raw/*` serves the client's data tables, making this the single source of
  truth for game-file extraction.** `extract-grf.mjs --raw resources/raw` writes
  `items.json`, `jobs.json`, `skills.json`, `randomopt.json`, `status.json`,
  `classes.json` and `hair.json`, and the gateway serves them at
  `/raw/<name>.json`. Until now latam-ro-calc, latamvisuais and ragreplaystats
  each carried their own fork of the GRF reader and the Lua 5.1 VM and extracted
  the client separately — four passes over a 4.3 GB GRF after every client
  update, four things to fix when a `.lub` shifts. They now download these tables
  and reshape them locally.

  The tables are a deliberately *faithful* projection of the client rather than a
  curated one: per-consumer naming overrides, the `[3]` slot-suffix formatting
  and slot bitmasks stay in each consumer's own sync step. Two consequences worth
  knowing: item `name` is the **bare** identified name with `slots` kept
  separate, and items with no display name are kept with `name: null` because
  ~640 of them still carry a renderable `view`. Each consumer's existing data
  files were verified to rebuild byte-identically from these.

  Items also carry **`spriteView`** and **`viewKind`** alongside the raw
  `ClassNum` in `view`. Newer costumes ship `ClassNum: 0` and keep their real
  view only in the client's accessory/robe name tables — 228 items in the current
  client — so a costume catalogue built on `view` alone silently drops them, and
  a few items' sprite lives in the *other* table from the one their equip slot
  implies. `--effects` already resolved both to decide what it could render;
  `items.json` now publishes them instead of leaving every consumer to pin the
  exceptions by hand.

### Changed
- **`mobs.json` moved out of the repo to `/raw/mobs.json`.** It was the one
  committed data file here; it now lives in the gitignored `resources/raw/`
  alongside the extracted tables, so all published data has one delivery path.
  Consumers that fetched it from `raw.githubusercontent.com` should switch to
  `https://assets.latam-tools.com.br/raw/mobs.json`. `tools/scrape-mobs.mjs`
  writes to the new location by default. Regenerating it costs a full
  rate-limited walk of the RagnaPlace API, so the deployed copy is the one to
  keep — a checkout no longer carries it.
- **`/raw` is the one endpoint that is not immutably cached.** Everything else
  here is content-addressed by its `ETag`, but these tables change at a stable
  URL whenever the client does, so they are served with
  `public, max-age=300, must-revalidate` instead of the year-long immutable
  policy. `ETag`/`304` and wildcard CORS are unchanged.
- **Caddy now compresses `/raw/*`.** These tables are the only text this host
  serves — `items.json` is 8.2 MB raw and ~1.1 MB gzipped, fetched by three
  projects on every client update. The `encode` directive is scoped to `/raw` on
  purpose: every other response is already-compressed image, audio or map bytes.
  Requires redeploying `caddy/ragassets.caddy`.

## 2026-08-10

### Fixed
- **Garments that share one image bank no longer render ~28px too high.** Four
  costumes (`wing_of_angel_move` / view 61, `천사날개` / 1,
  `c_papilio_ulysses_feather` / 85, `c_giant_white_rabbit` / 98) ship a complete
  `.act`+`.spr` pair at their folder root next to per-job `.act` files that have
  no per-job `.spr` — the root `.spr` *is* their shared image bank. Garment
  resolution only accepted same-folder act/spr pairs, so for any job without a
  per-job `.spr` the per-job act was rejected and the root pair matched instead.
  The root act is not a player-body act (frame 0 sits at `y=-62` vs `y=-34` for
  `초보자_남`), so the wings floated up by the head on every class and every
  rotation. `GarmentCandidates` now returns act/spr *pairs* rather than shared
  bases and offers each per-job act over the folder-root image bank before the
  root act is considered. Worst case was view 61, broken on 171 of 177 jobs; the
  other three were broken only on the 4th classes that lack a per-job `.spr`.
  No other garment changed — every other layout already matched a same-folder
  pair or reached the equivalent split-path fallback.

## 2026-07-12

### Added
- **`/effect/skill-map` entries now carry a resolved `wav` array.** Most
  3rd/4th-class skill effects have no `wav` in roBrowserLegacy's `EffectTable`
  (only ~435 of ~1127 rows do), so those skills were silent in the replay
  viewer even though `/effect/sound` already served their audio under the
  right name. `tools/gen-effect-tables.mjs` (`resolveSkillWav`) now derives
  candidate sound names per skill — the effect's table `wav`, its STR `file`
  base name, then the skill's own SKID constant (whole and job-prefix-stripped,
  e.g. `RA_WUGSTRIKE` → `wug_strike`, `WL_JACKFROST` → `jack_frost`) — and keeps
  only names verified against the extracted `data/wav/` tree
  (`resources/sounds/index.json`), so every value is guaranteed servable and
  never fabricated. Skills with no `effectId` at all in roBrowserLegacy's table
  (e.g. Windhawk's `WH_HAWKRUSH`/`WH_GALESTORM`/`WH_CRESCIVE_BOLT`) now get a
  `wav`-only entry synthesized purely from the SKID guess. 380 of 683 skills
  now resolve a sound (up from the 179 that already had a table `wav`), with no
  regressions — every skill whose effect already had a servable table `wav`
  still resolves to that exact same name. Backward compatible (`wav` is
  additive); the sibling `ragreplaystats` will read it directly and drop its
  client-side STR-name/hardcoded-map fallback.

### Investigated
- **The reported "sound deploy gap" isn't a deploy issue.** `/effect/sound?file=wh_hawkrush`
  404s, but that's because the client GRF only ships `data/wav/effect/wh_hawkrush.wav`
  (confirmed via a direct GRF listing) — `effect/wh_hawkrush` already returns
  `200` today, and the deployed `SOUNDS_DIR` tree matches `resources/sounds/`
  exactly (2678/2678 names, byte-for-byte the same set on prod and locally).
  The real fix is the `wav` field above, which resolves Windhawk's skills to
  `effect/wh_hawkrush` etc. — the correctly-prefixed real path — instead of a
  bare guessed name that was never going to exist.

## 2026-07-11

### Added
- **`GET /effect/sound?file=<name>` serves skill/effect/monster sound-effect
  audio** so the replay viewer can play the "swing" of Bash, the Frost Diver
  freeze, portal whoosh, heal chime, monster death cries, hit sparks, etc. It is
  the audio counterpart of the `wav` field the `/effect/table` rows already carry
  (435 references → 304 unique names): the client resolves a skill to its
  effect(s), reads each row's `wav`, and fetches it here — no new mapping. `<name>`
  is a `data/wav/`-relative path without the `.wav` extension, exactly as the table
  stores it (`effect/ef_portal`, the bare `_heal_effect`). Same immutable-cache /
  wildcard-CORS / `ETag` headers as `/bgm`; a name the client GRF never shipped
  returns `404` (the viewer treats that as "no sound" and skips it — a wrong sound
  is never served). `GET /effect/sound/index.json` lists the names present.
- **`extract-grf.mjs --sounds <out-dir>`** extracts the whole `data/wav/` tree
  (every name a `wav` field can reference, `%d` variants included) into `<out>/`,
  mirroring the GRF paths. Standard PCM wavs are copied verbatim; the handful
  stored as **MS/IMA ADPCM** (which some browsers can't decode) are transcoded to
  16-bit PCM, so the tree is uniformly browser-playable under one `audio/wav`
  Content-Type. Current client: **2678 sounds written, 6 transcoded from ADPCM, 1
  corrupt GRF entry skipped**; writes `index.json`. Served via the new `SOUNDS_DIR`
  env (`docker-compose.yml` mounts `resources/sounds` at `/sounds`).
- **Coverage: 296 of the 304 table `wav` names resolve** (293 concrete + all three
  `%d` families: `ef_firearrow`/`ef_icearrow` 1–3, `_hit_fist` 1–4), verified live
  end-to-end (browser `decodeAudioData` succeeds on PCM, both ADPCM formats, and
  Korean names). 87 of those are Korean names the effect table stores as raw
  **EUC-KR bytes** rendered one-per-rune; the resolver retries a miss under the
  decoded Hangul path (`effect.EUCKRReinterpret`), reproducing how the real client
  matches them. The 8 that stay silent are genuinely absent from this client's GRF
  (or reference an `effect/`-prefixed path that exists only bare — a client-data
  quirk the real client would also `404`); the resolver never strips/adds the
  prefix. The `wav` field was already emitted by `gen-effect-tables.mjs`, so no
  table regeneration was needed.

## 2026-07-07

### Changed
- **Full GRF re-extraction against the updated client.** The client `data.grf`
  (and `System/iteminfo_new.lub`) picked up newly-added items, so every served
  asset tree was rebuilt from the current GRF:
  - **Icons** — item `15792` / collection `15793` (up from ~`15189` at the June
    baseline, ≈ +600 new items), skill `1194`, job `282`, status `459`, ui `128`.
  - **Core sprite/palette/imf/luafiles514/texture-effect** data (used by the
    in-process renderer and `/effect/*`): 208,071 files re-extracted, 12,171 of
    them DES-decrypted.
  - **Effect-only costume + map-effect bundles** (`/effects/*`): catalogue of 23
    costume bundles plus 3 sprite effects; the level-aura / EXE-bound costumes
    remain unresolved by design (no derivable `.str`).
  - **World maps** (`/maps/*`): 922 maps extracted (17 ground-mesh-less
    server/template maps skipped), 272 with fog, 289 with in-world effects.
  - **Per-map background music** (`/bgm/*`): 1081 map→track mappings, 183 unique
    tracks.
- **Regenerated the baked resolver tables** (`gateway/internal/render/resolve/data/`)
  from the updated client `.lub` so the newly-added equipment resolves for
  `/image` rendering. Dumped via the 32-bit lua5.1 path + `cmd/gen-resolver`;
  a clean additive change (43 insertions, 0 removed): 6 new headgears
  (`2866`–`2871`) and 2 new garments (`323`/`324`) in `tables.json`, plus 30 new
  `layer_priority.json` entries. `accname=2853 robe=323 weapon=101 jobname=5011
  istoplayer=219 layerPriority=559`. Requires the gateway rebuild+redeploy below
  (the tables are `go:embed`ed).

## 2026-07-06

### Changed
- **Production no longer uses Docker.** The EC2 host now runs everything as
  native systemd services: the gateway is built on the server with the Go
  toolchain (installed at `/usr/local/go`) and runs as `ragassets-gateway.service`
  (port 8080, `GOMEMLIMIT=500MiB`, `MemoryMax=600M`), and Caddy is installed from
  its official apt repo as `caddy.service` reading the repo `Caddyfile` from
  `/etc/caddy/Caddyfile`. The existing Let's Encrypt certificates were migrated
  out of the old `caddy-data` volume, so no re-issuance occurred. The `short`
  URL shortener (already a native systemd service on port 8081) is unaffected —
  Caddy now reaches both apps via `localhost` instead of the compose network /
  `host.docker.internal`. Docker Engine was purged from the instance, freeing
  ~4 GB of disk and ~370 MB of RAM.
  - `docker-compose.prod.yml` is gone; the `Caddyfile` now targets
    `localhost:8080` / `localhost:8081`. `docker-compose.yml` and
    `gateway/Dockerfile` remain for local development only.

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
