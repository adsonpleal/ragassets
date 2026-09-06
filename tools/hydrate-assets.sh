#!/usr/bin/env bash
# Rebuild ./public from R2, for machines that have no extracted client.
#
# CI cannot run tools/stage-assets.sh: that reads resources/, which is 16 GB and
# gitignored. But `wrangler deploy` needs ./public present to compute its asset
# manifest — deploying with `assets` configured and the directory missing reads
# as "all 39,241 assets deleted", which would take the icons offline.
#
# So tools/sync-r2.sh keeps a copy of the four Static Assets stores under
# static/ in the bucket, and this pulls them back. 298 MB. Those keys are never
# served: the Worker's routes do not reach static/, and at request time the files
# come from Workers Static Assets where requests are free.
#
# Needs rclone and an [r2] remote (see tools/sync-r2.sh for the config), or
# RCLONE_CONFIG_R2_* environment variables, which is how CI supplies them.
#
# Usage:
#   tools/hydrate-assets.sh [out-dir] [remote:bucket]
set -euo pipefail

cd "$(dirname "$0")/.."
. tools/lib.sh

OUT="${1:-public}"
REMOTE="${2:-r2:ragassets}"

find_rclone

echo "Hydrating $OUT from $REMOTE/static"
mkdir -p "$OUT"
"$RCLONE" copy "$REMOTE/static" "$OUT" "${R2_ARGS[@]}"

# The cache policy is committed, not stored in R2, so it tracks the code rather
# than the assets. Without it Static Assets serves max-age=0 and the icons —
# 69% of traffic — revalidate on every request instead of being cached.
cp -f worker/_headers "$OUT/_headers"

# And the 404 page. Static Assets is configured not_found_handling "404-page",
# so without this file a miss is answered with an empty body. This is the copy
# that actually deploys — CI has no extracted client and never runs
# stage-assets.sh — so a control file added there has to be added here too.
cp -f worker/404.html "$OUT/404.html"

check_asset_count "$OUT" 39000
