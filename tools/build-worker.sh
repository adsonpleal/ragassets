#!/usr/bin/env bash
# Build the Cloudflare Worker: the JS shim, then the Go renderer as wasm.
#
# Two steps, in this order:
#   1. workers-assets-gen writes gateway/build/{worker.mjs,runtime.mjs,wasm_exec.js}
#      — the shim that instantiates the module and bridges fetch events.
#   2. GOOS=js GOARCH=wasm go build writes gateway/build/app.wasm beside it,
#      which runtime.mjs imports by that exact name.
#
# Two cache epochs are stamped into the binary, and each forms part of an
# edge-cache key. Bumping one invalidates that cache wholesale, which is the only
# invalidation available: purge-by-URL is capped at 30 URLs a call and ~1,000 a
# day, and purge-by-prefix is Enterprise-only.
#
#   ASSET_EPOCH   keys the cached R2 objects — sprites, palettes, imf, maps, bgm.
#                 Those bytes change only when the asset pipeline ships a client
#                 update, so it must survive a code deploy. It used to not, and
#                 that cost availability: every deploy dropped the inputs too, so
#                 the first traffic afterwards was a burst of fully cold renders
#                 at 470-1050 ms with 8 of 60 failing, against 107-211 ms and none
#                 once warm. update-assets.yml writes the current value to
#                 r2:ragassets/manifest/epoch and deploy.yml reads it back.
#
#   RENDER_EPOCH  keys the finished renders. A render depends on the assets AND on
#                 the renderer, so it is ASSET_EPOCH with a build id appended, and
#                 a code deploy DOES invalidate it. That is the point: a change to
#                 the engine must not keep serving the pixels it replaced.
#
# Both fall back to a fresh timestamp rather than to anything reused, because the
# danger is one-sided. Invalidating too often costs a cold cache for a few
# minutes; an asset epoch that fails to change serves last week's sprites
# indefinitely. That asymmetry is also why the old shallow-clone guard is gone
# rather than ported — it existed because the previous default (the commit count)
# silently repeated under CI's shallow checkout, and a default that cannot repeat
# needs no guard.
#
# DEPLOY_EPOCH is still honoured as the asset epoch, so a caller that has not been
# updated keeps the previous behaviour — safe and wasteful — rather than quietly
# pinning the cache.
set -euo pipefail

cd "$(dirname "$0")/.."

ASSET_EPOCH="${ASSET_EPOCH:-${DEPLOY_EPOCH:-}}"
if [ -z "$ASSET_EPOCH" ]; then
  ASSET_EPOCH="$(date +%s)"
  echo "ASSET_EPOCH unset; using $ASSET_EPOCH, which drops the resource cache." >&2
fi

# The build id only has to differ between builds of different code, which the
# commit sha is exactly — no counter to keep, and it survives a shallow clone.
if [ -z "${RENDER_EPOCH:-}" ]; then
  BUILD_ID="$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
  RENDER_EPOCH="$ASSET_EPOCH-$BUILD_ID"
fi

echo "Building worker (assets $ASSET_EPOCH, renders $RENDER_EPOCH)"
cd gateway

go run github.com/syumai/workers/cmd/workers-assets-gen -mode=go

# Replace the generated entry point with ours. It keeps wasm_exec.js and
# runtime.mjs as generated and changes only the instance lifecycle: the generated
# shim builds a new WebAssembly instance and Go runtime per request, which
# re-fetches the existence manifest from R2 every time and throws away the
# renderer's parse caches. See worker/shim.mjs.
cp ../worker/shim.mjs ./build/worker.mjs
# The shim imports patchlist.mjs as a sibling, so it has to land beside it —
# wrangler bundles from build/worker.mjs and resolves relative imports there.
cp ../worker/patchlist.mjs ./build/patchlist.mjs

GOOS=js GOARCH=wasm go build \
  -ldflags="-s -w -X main.assetEpoch=$ASSET_EPOCH -X main.renderEpoch=$RENDER_EPOCH" \
  -o ./build/app.wasm ./cmd/worker

SIZE=$(wc -c < ./build/app.wasm)
GZIP=$(gzip -9 -c ./build/app.wasm | wc -c)
awk -v s="$SIZE" -v g="$GZIP" 'BEGIN {
  printf "  app.wasm: %.2f MB uncompressed, %.2f MB gzipped (limit: 10 MB gzipped)\n",
         s/1048576, g/1048576
  if (g > 10*1048576) { print "  OVER THE BUNDLE LIMIT"; exit 1 }
}'
