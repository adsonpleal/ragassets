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

find_rclone

if [ ! -d "$RESOURCES/data" ]; then
  echo "No $RESOURCES/data — run the extraction first (see README)." >&2
  exit 1
fi

if [ ! -f "$RESOURCES/manifest/exists.bin" ]; then
  echo "No $RESOURCES/manifest/exists.bin — run:" >&2
  echo "  (cd gateway && go run ./cmd/gen-manifest -resources ../$RESOURCES)" >&2
  exit 1
fi

# The two copies below differ only in destination and filter set, so they share
# one invocation. R2_ARGS (tools/lib.sh) carries the flags every transfer needs;
# --progress and the 32M chunk size are specific to pushing a 15 GB tree.
copy_to() {
  local dest="$1"
  shift
  "$RCLONE" copy "$RESOURCES" "$dest" "$@" \
    "${R2_ARGS[@]}" --s3-chunk-size 32M --progress ${DRY_RUN:+--dry-run}
}

# The four stores Workers Static Assets serves, named once. Everything else in
# the tree goes to R2, and these same four are what the static/ mirror below
# includes — one list, used in both directions, so they cannot disagree.
STATIC_STORES=(icons illust effects raw)

main_filters=()
for store in "${STATIC_STORES[@]}"; do
  main_filters+=(--exclude "/$store/**")
done
# Compiled into the binary by cmd/gen-resolver; never read at runtime.
main_filters+=(--exclude "/data/luafiles514/**")

echo "Syncing $RESOURCES -> $REMOTE"
copy_to "$REMOTE" "${main_filters[@]}"

# The Static Assets stores go up a second time, under static/, purely as a source
# CI can hydrate from.
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
static_filters=()
for store in "${STATIC_STORES[@]}"; do
  static_filters+=(--include "/$store/**")
done

echo "Syncing the Static Assets sources -> $REMOTE/static"
copy_to "$REMOTE/static" "${static_filters[@]}"
