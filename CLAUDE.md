# Working on ragassets

## What this is

A Go server that renders Ragnarok Online sprites on demand and serves the static
assets extracted from a game client. `extract-grf.mjs` pulls assets out of the
client's GRF; `gateway/` renders and serves them.

## Where production runs

**One self-hosted Oracle Cloud ARM box**, since 2026-09-08. Not Cloudflare
Workers, not EC2, not Docker — both of those are historical and the CHANGELOG
still describes them, so check dates before trusting an old entry.

Cloudflare is **DNS only for this host**, since 2026-09-09. The `assets` record
is grey-clouded: browsers reach the box directly and Caddy holds a Let's Encrypt
certificate. Measurements are in the CHANGELOG; the short version is that a
quarter of Brazilian requests were being routed to Miami or Newark and paying
3.5x for it, on cache hits as much as misses, while 98.7% of renders were
uncacheable anyway.

The zone config in `cloudflare/` is still committed and still applied by
`.github/workflows/cloudflare.yml` — the zone-wide settings there affect four
sibling projects that are still proxied, and the cache rules are kept dormant
rather than deleted so that re-proxying is a one-click rollback. Do not change
either by clicking in the dashboard.

**Pushing to `main` deploys.** CI runs, and a green CI run starts
`.github/workflows/deploy.yml`, which SSHes in and runs the box's copy of
`deploy/deploy-from-ci.sh` — fetch, refuse anything not already on `origin/main`,
build on the box (it is aarch64), restart, roll the binary back if `/healthz`
does not answer. The key it uses is pinned to a forced command in the box's
`authorized_keys`, so it can do that and nothing else; a plain copy of that key
in `authorized_keys` would turn it into a shell key. Deploy by hand only when the
workflow is what is broken, or when there is nothing to push.

**The origin IP is public now** — one `dig assets.latam-tools.com.br` returns it,
so stop treating it as a secret. What is still deliberately not in this
repository is the SSH key and anything else that grants access. It lives in:

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
- **Port 80 must stay open on the box.** Nothing serves on it but the redirect to
  HTTPS — it is there so Caddy can answer the ACME HTTP-01 challenge when the
  certificate renews every 60 days. Close it and the site dies 30 days later.
- **There is no rate limit and no access log, on purpose.** Going direct gave up
  Cloudflare's WAF, and the replacement is deliberately not more software: usage
  is watched through Oracle's instance metrics (CPU and network), and a rate
  limit gets built if something actually abuses the box. A consequence to accept
  with it — nothing records a client IP, so an abusive caller can be seen in the
  aggregate but not identified. Adding a log is the first step if that day comes.
- **`cloudflare/cache-rules.json` looks live and is not.** Every rule tests
  `http.host eq "assets.latam-tools.com.br"`, which no longer passes through
  Cloudflare, so none of them can match. They are kept so that re-proxying
  restores render caching in one click.

## Before changing cache headers or ETags

Clients hold these for a year. `internal/api` owns every `Cache-Control` and
`ETag`; Caddy and Cloudflare deliberately set none of their own. `tools/diff-origins.sh`
compares two origins byte-for-byte and is the gate for any change that could move
bytes.

## Conventions

- Commit straight to `main`.
- `.github/workflows/` must never gain a `pull_request` trigger. The repo is
  public and two workflows hold credentials: a Cloudflare token, and an SSH key
  into the origin. A `pull_request` trigger runs a fork's code with both.
- No secrets in the repo, ever. They live in `/etc/ragassets/patch.env` on the
  box, root-owned 0600.
