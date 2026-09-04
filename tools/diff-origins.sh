#!/usr/bin/env bash
# Compare two origins byte-for-byte over a set of URLs.
#
# This is the cutover gate. The Worker is a different implementation of the same
# renderer reading from different storage, so "it works" is not the bar —
# every response has to be identical to what the current gateway serves, because
# clients hold ETags derived from the query and will keep using cached bytes
# across the switch.
#
# Usage:
#   tools/diff-origins.sh [paths-file]
#   NEW=https://... OLD=https://... tools/diff-origins.sh
#
# paths-file is one request path per line (with query), e.g.
#   /image?job=1002&action=0
# Lines starting with # are ignored. With no file, a built-in smoke set is used.
#
# Exits non-zero if any response differs.
set -uo pipefail

NEW="${NEW:-https://assets-next.latam-tools.com.br}"
OLD="${OLD:-https://assets.latam-tools.com.br}"
LIST="${1:-}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

paths() {
  if [ -n "$LIST" ]; then
    grep -v '^\s*#' "$LIST" | grep -v '^\s*$'
  else
    cat <<'EOF'
/healthz
/effect/table
/effect/skill-map
/effect/sound?file=_blind
/effect/sound?file=_BLIND
/effect/str?file=stormgust
/image?job=1&head=1&action=0&frame=0&enableShadow=false
/image?job=1&head=1&action=0&frame=0&gender=female&enableShadow=false
/image?job=1&head=1&action=0&frame=0&headgear=1&enableShadow=false
/image?job=1&head=1&action=0&frame=0&garment=245&enableShadow=false
/image?job=4252&head=1&action=0&frame=0&enableShadow=false
/image?job=1002&action=0&frame=0&enableShadow=false
/gif?job=1&head=1&action=0&frame=0&enableShadow=false
EOF
  fi
}

same=0
diff=0
skip=0

while IFS= read -r p; do
  # content_type travels with the body. Comparing only bytes misses a response
  # that is byte-identical but labelled differently, which a browser treats as a
  # different resource entirely — exactly how /effect/sound briefly went out as
  # application/octet-stream instead of audio/wav.
  read -r nc nt < <(curl -s --max-time 90 "$NEW$p" -o "$tmp/new"     -w '%{http_code} %{content_type}' 2>/dev/null; echo)
  read -r oc ot < <(curl -s --max-time 90 "$OLD$p" -o "$tmp/old"     -w '%{http_code} %{content_type}' 2>/dev/null; echo)

  if [ "$nc" != "$oc" ]; then
    printf '  DIFF  %-60s status %s vs %s\n' "${p:0:60}" "$nc" "$oc"
    diff=$((diff+1))
    continue
  fi
  if [ "$nc" != "200" ]; then
    printf '  skip  %-60s both %s\n' "${p:0:60}" "$nc"
    skip=$((skip+1))
    continue
  fi
  if [ "${nt%%;*}" != "${ot%%;*}" ]; then
    printf '  DIFF  %-60s type %s vs %s
' "${p:0:60}" "${nt:-none}" "${ot:-none}"
    diff=$((diff+1))
    continue
  fi
  if cmp -s "$tmp/new" "$tmp/old"; then
    same=$((same+1))
  else
    printf '  DIFF  %-60s %s vs %s bytes\n' "${p:0:60}" \
      "$(wc -c < "$tmp/new")" "$(wc -c < "$tmp/old")"
    diff=$((diff+1))
  fi
done < <(paths)

echo
echo "  identical: $same   differing: $diff   skipped: $skip"
echo "  new: $NEW"
echo "  old: $OLD"
[ "$diff" -eq 0 ]
