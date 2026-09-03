#!/usr/bin/env bash
# Build the Cloudflare Worker: the JS shim, then the Go renderer as wasm.
#
# Two steps, in this order:
#   1. workers-assets-gen writes gateway/build/{worker.mjs,runtime.mjs,wasm_exec.js}
#      — the shim that instantiates the module and bridges fetch events.
#   2. GOOS=js GOARCH=wasm go build writes gateway/build/app.wasm beside it,
#      which runtime.mjs imports by that exact name.
#
# DEPLOY_EPOCH is stamped into the binary and forms part of every edge-cache key,
# so bumping it invalidates the cache wholesale. That is the only invalidation
# available: purge-by-URL is capped at 30 URLs a call and ~1,000 a day, and
# purge-by-prefix is Enterprise-only. Defaults to the commit count, which rises
# on every deploy without needing to be tracked anywhere.
set -euo pipefail

cd "$(dirname "$0")/.."

EPOCH="${DEPLOY_EPOCH:-$(git rev-list --count HEAD 2>/dev/null || echo dev)}"

echo "Building worker (epoch $EPOCH)"
cd gateway

go run github.com/syumai/workers/cmd/workers-assets-gen -mode=go

# Replace the generated entry point with ours. It keeps wasm_exec.js and
# runtime.mjs as generated and changes only the instance lifecycle: the generated
# shim builds a new WebAssembly instance and Go runtime per request, which
# re-fetches the existence manifest from R2 every time and throws away the
# renderer's parse caches. See worker/shim.mjs.
cp ../worker/shim.mjs ./build/worker.mjs

GOOS=js GOARCH=wasm go build \
  -ldflags="-s -w -X main.deployEpoch=$EPOCH" \
  -o ./build/app.wasm ./cmd/worker

SIZE=$(wc -c < ./build/app.wasm)
GZIP=$(gzip -9 -c ./build/app.wasm | wc -c)
awk -v s="$SIZE" -v g="$GZIP" 'BEGIN {
  printf "  app.wasm: %.2f MB uncompressed, %.2f MB gzipped (limit: 10 MB gzipped)\n",
         s/1048576, g/1048576
  if (g > 10*1048576) { print "  OVER THE BUNDLE LIMIT"; exit 1 }
}'
