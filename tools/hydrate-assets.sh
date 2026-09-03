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

OUT="${1:-public}"
REMOTE="${2:-r2:ragassets}"

RCLONE="$(command -v rclone || true)"
[ -z "$RCLONE" ] && [ -x "_scratch/tools/rclone.exe" ] && RCLONE="_scratch/tools/rclone.exe"
[ -z "$RCLONE" ] && [ -x "_scratch/tools/rclone" ] && RCLONE="_scratch/tools/rclone"
if [ -z "$RCLONE" ]; then
  echo "rclone not found. Install it, or drop the binary in _scratch/tools/." >&2
  exit 1
fi

echo "Hydrating $OUT from $REMOTE/static"
mkdir -p "$OUT"
"$RCLONE" copy "$REMOTE/static" "$OUT" \
  --s3-no-check-bucket \
  --transfers 32 \
  --checkers 64 \
  --checksum \
  --stats-one-line

# The cache policy is committed, not stored in R2, so it tracks the code rather
# than the assets. Without it Static Assets serves max-age=0 and the icons —
# 69% of traffic — revalidate on every request instead of being cached.
cp -f worker/_headers "$OUT/_headers"

n=$(find "$OUT" -type f | wc -l)
echo "  $OUT holds $n file(s)"
if [ "$n" -lt 39000 ]; then
  echo "  suspiciously few files — expected ~39,241; refusing to let a partial" >&2
  echo "  hydration deploy and delete live assets." >&2
  exit 1
fi
if [ "$n" -gt 100000 ]; then
  echo "  OVER the Static Assets limit of 100,000 files per version" >&2
  exit 1
fi
