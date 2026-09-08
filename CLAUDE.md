# Working on ragassets

## What this is

A Go server that renders Ragnarok Online sprites on demand and serves the static
assets extracted from a game client. `extract-grf.mjs` pulls assets out of the
client's GRF; `gateway/` renders and serves them.

## Where production runs

**One self-hosted Oracle Cloud ARM box**, since 2026-09-08. Not Cloudflare
Workers, not EC2, not Docker — both of those are historical and the CHANGELOG
still describes them, so check dates before trusting an old entry.

Cloudflare is **DNS and CDN cache only**. Its config is committed in
`cloudflare/` and applied by `.github/workflows/cloudflare.yml`; do not change
cache rules by clicking in the dashboard.

**Connection details (host, SSH key) are deliberately not in this repository** —
it is public, and the DNS record is proxied so the origin IP is otherwise hidden.
They live in:

- the `deploy` skill (`.claude/skills/deploy/`, gitignored) — say "deploy" or
  "ship it" to load it, and it documents the whole procedure
- project memory, under the entry for the Oracle box

If you need to reach the box and neither is available, ask rather than guessing.

## The one distinction that causes real bugs

On the origin these are **different trees**:

| | |
|---|---|
| `mirror/` | the merged client — the whole GRF plus every patch since. This is `RESOURCE_DIR`, and the extractor's input. ~18 GB. |
| `resources/` | **only** the derived stores: icons, illust, effects, maps, bgm, sounds, raw. |

Pointing `--grf` at `resources/` walks the 21k-file maps output it is about to
rewrite. Locally the two can share a tree; on the box they must not.

## Things that look like bugs and are not

- **`/icons/item/501.png`, not `/icon/501`.** There is no `/icon` route, and no
  `/sounds` route either — sounds are at `/effect/sound?file=<name>`.
- **Most Go tests skip without `resources/`.** The golden render tests do not;
  they run against a committed fixture pack so CI cannot pass vacuously.
- **A patch cycle restarts the gateway, and must.** The parse caches are keyed by
  name and the effect store's directory index is built once per folder, so a live
  process serves a patched sprite stale and 404s a new effect file forever.
- **A missing sprite returns 500, not 404.** Pre-existing; the render fails rather
  than reporting absence.

## Before changing cache headers or ETags

Clients hold these for a year. `internal/api` owns every `Cache-Control` and
`ETag`; Caddy and Cloudflare deliberately set none of their own. `tools/diff-origins.sh`
compares two origins byte-for-byte and is the gate for any change that could move
bytes.

## Conventions

- Commit straight to `main`.
- `.github/workflows/` must never gain a `pull_request` trigger. The repo is
  public and one workflow holds a Cloudflare token.
- No secrets in the repo, ever. They live in `/etc/ragassets/patch.env` on the
  box, root-owned 0600.
