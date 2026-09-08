#!/usr/bin/env bash
# Regenerate the baked id -> sprite-name tables from the current client mirror.
#
# Run this when tools/patch-cycle.mjs warns that a patch shipped
# data/luafiles514/. Skipping it is not cosmetic: a job id missing from jobName
# is not a missing costume, it is an unresolvable request, and /image returns
# 500 rather than degrading. That is not hypothetical — the first check after
# the migration found 40 such ids live in production.
#
# This deliberately is NOT part of the patch cycle. It recompiles the renderer,
# which is a far larger blast radius than rewriting an icon, and it runs the
# golden tests before restarting anything. A human decides when to take that.
#
# Why a 32-bit Lua is needed, since it is the surprising part: the client ships
# .lub files as precompiled Lua 5.1 bytecode, whose header pins the word size —
#
#     1b 4c 75 61 51 00 01 04 04 04 08 00
#                          ^^ sizeof(size_t) = 4
#
# and lua_undump refuses a chunk whose sizes do not match the host. A 64-bit
# interpreter cannot read these files at all. The fix is a 32-bit *interpreter*,
# not a 32-bit machine: lua5.1:armhf runs here through qemu-user-static's binfmt
# handler, because Ampere Altra is AArch64-only and cannot execute AArch32
# natively. Verified to produce byte-identical tables.json to a 32-bit x86 lua on
# Windows.
set -euo pipefail

REPO="${REPO:-$HOME/ragassets}"
MIRROR="${RAGASSETS_MIRROR:-$REPO/mirror}"
LUAFILES="$MIRROR/data/luafiles514/lua files"
DUMP="$(mktemp -d)"
trap 'rm -rf "$DUMP"' EXIT

cd "$REPO"

command -v lua5.1 >/dev/null || {
  echo "lua5.1 not installed. Run tools/provision-oracle.sh, or:" >&2
  echo "  sudo dpkg --add-architecture armhf && sudo apt-get update" >&2
  echo "  sudo apt-get install -y qemu-user-static lua5.1:armhf" >&2
  exit 1
}
[ -d "$LUAFILES/datainfo" ] || { echo "no $LUAFILES/datainfo — is the mirror extracted?" >&2; exit 1; }

echo "==> dumping the client tables (32-bit lua under qemu)"
lua5.1 gateway/cmd/gen-resolver/dump.lua \
  "$LUAFILES/datainfo" "$LUAFILES/offsetitempos" "$DUMP"
# Two tables fail to execute on this client and always have — ShadowTable indexes
# a nil key, OffsetItemPos expects a global the dump does not build. Neither feeds
# tables.json. They are reported above rather than hidden, but they are not errors.

echo "==> generating tables.json"
cd gateway
go run ./cmd/gen-resolver "$DUMP" internal/render/resolve/data/tables.json

if git -C "$REPO" diff --quiet -- gateway/internal/render/resolve/data/; then
  echo "==> tables unchanged; nothing to rebuild"
  exit 0
fi
echo "==> tables changed:"
git -C "$REPO" diff --stat -- gateway/internal/render/resolve/data/ | sed 's/^/    /'

echo "==> baking into Go source"
go run ./cmd/gen-tables

echo "==> vet + test (the golden renders are the gate)"
go vet ./...
go test ./... -count=1 | grep -vE "no test files"

echo "==> building"
go build -ldflags='-s -w' -o ragassets-gateway .

echo "==> restarting"
sudo systemctl restart ragassets-gateway.service
sleep 3
systemctl is-active ragassets-gateway.service

echo
echo "Done. The regenerated JSON and baked Go source are UNCOMMITTED in your"
echo "checkout — commit and push them, or the next git pull will revert the box"
echo "to the stale tables and quietly reintroduce the 500s."
