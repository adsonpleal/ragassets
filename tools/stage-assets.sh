#!/usr/bin/env bash
# Stage the stores that Workers Static Assets serves into ./public.
#
# Four stores go here rather than to R2 — icons, illust, effects and raw, about
# 363 MB across ~39k files. They are 69% of all traffic by measurement, and
# requests to static assets are free and unmetered, which is what keeps billed
# Worker requests inside the 10M included each month. Everything else (the
# renderer's inputs, maps, bgm, sounds) is bulk and cold, and lives in R2.
#
# They need staging because wrangler serves one directory and these live under
# resources/ next to 15 GB that must NOT be published. Copying the whole lot on
# every build would be wasteful, so hardlinks are used where the filesystem
# allows: same inode, no extra space, and a re-stage after an extraction picks up
# only what changed.
#
# Limits worth knowing (Workers Paid): 100,000 files per version and 25 MiB per
# file. Measured here: ~39k files, largest 9.26 MB (raw/items.json). Comfortable,
# but --check reports them so a future client update cannot quietly cross a line.
#
# Usage:
#   tools/stage-assets.sh [resources-dir] [out-dir]
#   tools/stage-assets.sh --check          # report counts and sizes only
set -euo pipefail

cd "$(dirname "$0")/.."

RESOURCES="resources"
OUT="public"
CHECK=""
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    *) if [ "$RESOURCES" = "resources" ]; then RESOURCES="$a"; else OUT="$a"; fi ;;
  esac
done

STORES=(icons illust effects raw)

for s in "${STORES[@]}"; do
  if [ ! -d "$RESOURCES/$s" ]; then
    echo "missing $RESOURCES/$s — run the extraction first (see README)." >&2
    exit 1
  fi
done

if [ -n "$CHECK" ]; then
  total=0
  echo "  store      files      bytes  largest"
  for s in "${STORES[@]}"; do
    n=$(find "$RESOURCES/$s" -type f | wc -l)
    b=$(find "$RESOURCES/$s" -type f -printf '%s\n' | awk '{t+=$1} END {print t+0}')
    big=$(find "$RESOURCES/$s" -type f -printf '%s\n' | sort -n | tail -1)
    total=$((total + n))
    awk -v s="$s" -v n="$n" -v b="$b" -v big="$big" 'BEGIN {
      printf "  %-8s %7d  %8.1f MB  %.2f MB\n", s, n, b/1048576, big/1048576 }'
  done
  echo "  total files: $total  (Static Assets cap: 100,000 per version, 25 MiB per file)"
  exit 0
fi

echo "Staging ${STORES[*]} -> $OUT"
mkdir -p "$OUT"

# Try a hardlink first. It is instant and free, but fails across filesystems and
# on filesystems without link support, so fall back to a copy rather than
# guessing which case we are in.
link_or_copy() {
  ln -f "$1" "$2" 2>/dev/null || cp -f "$1" "$2"
}

staged=0
for s in "${STORES[@]}"; do
  while IFS= read -r src; do
    rel="${src#$RESOURCES/}"
    dest="$OUT/$rel"
    # Skip anything already staged and unchanged, so a re-run after an
    # extraction only touches what actually moved.
    if [ -f "$dest" ] && [ "$dest" -nt "$src" ]; then
      continue
    fi
    mkdir -p "$(dirname "$dest")"
    link_or_copy "$src" "$dest"
    staged=$((staged + 1))
  done < <(find "$RESOURCES/$s" -type f)
done

n=$(find "$OUT" -type f | wc -l)
echo "  staged $staged file(s); $OUT now holds $n"
if [ "$n" -gt 100000 ]; then
  echo "  OVER the Static Assets limit of 100,000 files per version" >&2
  exit 1
fi
