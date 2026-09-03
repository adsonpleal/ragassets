#!/usr/bin/env bash
# Sync the extracted resource tree into the R2 bucket the Worker reads.
#
# What goes to R2 and what does not is the whole point of this script:
#
#   R2        data/{sprite,palette,imf}   the renderer's inputs
#             data/texture/effect         /effect/str and /effect/texture
#             maps, bgm, sounds           bulky, cold, served straight through
#             manifest/exists.bin         the existence manifest (cmd/gen-manifest)
#
#   NOT R2    icons, illust, effects, raw ~410 MB / 39k files, served by Workers
#                                         Static Assets instead, where requests
#                                         are free — that is 69% of all traffic,
#                                         and it is what keeps billed Worker
#                                         requests under the included 10M/month.
#                                         `wrangler deploy` uploads these.
#             data/luafiles514            baked into the binary by cmd/gen-resolver
#                                         at build time; never read at runtime.
#
# Keys are uploaded with the tree's own casing, NOT lowercased. The manifest
# hashes keys the same way, and extraction preserves whatever the client shipped
# (see internal/effect/store.go) — lowercasing here would silently orphan any
# mixed-case file a different client ships.
#
# Setup (once):
#
#   1. Cloudflare dashboard -> R2 -> API -> Manage API tokens -> Create API token
#      with Object Read & Write on the `ragassets` bucket. Note the S3
#      Access Key ID and Secret Access Key; they are shown once.
#
#   2. rclone config, or write ~/.config/rclone/rclone.conf directly:
#
#        [r2]
#        type = s3
#        provider = Cloudflare
#        access_key_id = <ACCESS_KEY_ID>
#        secret_access_key = <SECRET_ACCESS_KEY>
#        endpoint = https://<ACCOUNT_ID>.r2.cloudflarestorage.com
#        acl = private
#
# Usage:
#   tools/sync-r2.sh [resources-dir] [remote:bucket]
#   DRY_RUN=1 tools/sync-r2.sh          # show what would transfer
set -euo pipefail

RESOURCES="${1:-resources}"
REMOTE="${2:-r2:ragassets}"

# rclone, from PATH or the local toolchain dir. It is not optional: the R2 REST
# API that `wrangler r2 object put` uses is rate-limited to ~1200 requests per 5
# minutes, measured — the first 429 landed after 1,327 requests — which would put
# this sync at roughly 16 hours. The S3 endpoint rclone speaks has no such limit.
RCLONE="$(command -v rclone || true)"
[ -z "$RCLONE" ] && [ -x "_scratch/tools/rclone.exe" ] && RCLONE="_scratch/tools/rclone.exe"
[ -z "$RCLONE" ] && [ -x "_scratch/tools/rclone" ] && RCLONE="_scratch/tools/rclone"
if [ -z "$RCLONE" ]; then
  echo "rclone not found. Install it (winget install Rclone.Rclone) or drop the" >&2
  echo "binary in _scratch/tools/." >&2
  exit 1
fi

if [ ! -d "$RESOURCES/data" ]; then
  echo "No $RESOURCES/data — run the extraction first (see README)." >&2
  exit 1
fi

if [ ! -f "$RESOURCES/manifest/exists.bin" ]; then
  echo "No $RESOURCES/manifest/exists.bin — run:" >&2
  echo "  (cd gateway && go run ./cmd/gen-manifest -resources ../$RESOURCES)" >&2
  exit 1
fi

ARGS=(
  copy "$RESOURCES" "$REMOTE"
  # Served by Workers Static Assets, not R2.
  --exclude "/icons/**"
  --exclude "/illust/**"
  --exclude "/effects/**"
  --exclude "/raw/**"
  # Compiled into the binary; not read at runtime.
  --exclude "/data/luafiles514/**"
  # An R2 token scoped to one bucket cannot call CreateBucket, which rclone
  # otherwise attempts before its first upload — it fails with a 403 that reads
  # like a credentials problem rather than a permissions one. Skipping the check
  # is correct here: the bucket already exists and this token is not allowed to
  # make buckets by design.
  --s3-no-check-bucket
  # 237k small objects: parallelism dominates, not bandwidth.
  --transfers 32
  --checkers 64
  --s3-chunk-size 32M
  # Re-runs after a client patch should move only what changed. R2 exposes an
  # md5 etag, so size+checksum is both cheaper and safer than mtime here —
  # extraction rewrites files wholesale and mtimes carry no meaning.
  --checksum
  --progress
  --stats-one-line
)

if [ -n "${DRY_RUN:-}" ]; then
  ARGS+=(--dry-run)
fi

echo "Syncing $RESOURCES -> $REMOTE"
"$RCLONE" "${ARGS[@]}"

# The four Static Assets stores go up a second time, under static/, purely as a
# source CI can hydrate from.
#
# They are NOT served from these keys — the Worker's routes never reach static/,
# and at request time they come from Workers Static Assets, where requests are
# free. This copy exists because `wrangler deploy` needs the asset directory
# present to compute its manifest: deploying with `assets` configured but
# ./public missing reads as "all 39k assets deleted". CI has no resources/ tree
# (it is 16 GB and gitignored), so it rebuilds ./public from here instead.
#
# 298 MB, about half a cent a month, to make code deploys independent of having
# the client extracted.
STATIC_ARGS=(
  copy "$RESOURCES" "$REMOTE/static"
  --include "/icons/**"
  --include "/illust/**"
  --include "/effects/**"
  --include "/raw/**"
  --s3-no-check-bucket
  --transfers 32
  --checkers 64
  --checksum
  --progress
  --stats-one-line
)
if [ -n "${DRY_RUN:-}" ]; then
  STATIC_ARGS+=(--dry-run)
fi

echo "Syncing the Static Assets sources -> $REMOTE/static"
"$RCLONE" "${STATIC_ARGS[@]}"
