#!/usr/bin/env bash
# Shared helpers for the tools/ scripts that move bytes into or out of R2.
#
# Sourced, never executed:  . "$(dirname "$0")/lib.sh"
# Assumes the caller has already cd'd to the repository root.

# find_rclone sets RCLONE to an rclone binary, from PATH or the local toolchain
# directory, or exits.
#
# rclone is not optional for R2 work. The R2 REST API that `wrangler r2 object
# put` speaks is rate-limited to about 1,200 requests per 5 minutes — measured,
# the first 429 landed after 1,327 — which would put a full sync at roughly 16
# hours. The S3 endpoint rclone uses has no such limit.
find_rclone() {
  RCLONE="$(command -v rclone || true)"
  [ -z "$RCLONE" ] && [ -x "_scratch/tools/rclone.exe" ] && RCLONE="_scratch/tools/rclone.exe"
  [ -z "$RCLONE" ] && [ -x "_scratch/tools/rclone" ] && RCLONE="_scratch/tools/rclone"
  if [ -z "$RCLONE" ]; then
    echo "rclone not found. Install it (winget install Rclone.Rclone) or drop the" >&2
    echo "binary in _scratch/tools/." >&2
    exit 1
  fi
}

# R2_ARGS are the flags every copy into or out of the bucket shares. They live in
# one place because the failure mode of tuning them separately is quiet: a
# --checksum set on the way up and forgotten on the way down is a corruption that
# only surfaces at deploy time.
#
# --s3-no-check-bucket: an R2 token scoped to a single bucket cannot call
#   CreateBucket, which rclone otherwise attempts before its first upload. It
#   fails with a 403 that reads like a credentials problem rather than a
#   permissions one. The bucket already exists and this token is not allowed to
#   create buckets by design.
# --transfers/--checkers: 237k small objects, so parallelism dominates, not
#   bandwidth.
# --checksum: R2 exposes an md5 etag, so size+checksum is both cheaper and safer
#   than mtime — extraction rewrites files wholesale and their mtimes carry no
#   meaning.
R2_ARGS=(
  --s3-no-check-bucket
  --transfers 32
  --checkers 64
  --checksum
  --stats-one-line
)

# count_files echoes the number of regular files under a directory, and fails the
# script if that count falls outside the Static Assets bounds a deploy needs.
#
# Shared by stage-assets.sh (which builds ./public from a local tree) and
# hydrate-assets.sh (which rebuilds it from R2), because both feed the same
# `wrangler deploy` and both can take the site down the same way: too few files
# reads as "assets deleted", too many is over the hard 100,000-per-version cap.
check_asset_count() {
  local dir="$1" min="$2"
  local n
  n=$(find "$dir" -type f | wc -l)
  echo "  $dir holds $n file(s)"
  if [ "$n" -lt "$min" ]; then
    echo "  suspiciously few files — expected at least $min; refusing to let a" >&2
    echo "  partial build deploy and delete live assets." >&2
    exit 1
  fi
  if [ "$n" -gt 100000 ]; then
    echo "  OVER the Static Assets limit of 100,000 files per version" >&2
    exit 1
  fi
}
