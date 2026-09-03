//go:build !(js && wasm)

// This package only means anything compiled to WebAssembly for the Workers
// runtime. Without this file, `go build ./cmd/worker` fails with "build
// constraints exclude all Go files", which reads like a mistake rather than a
// target mismatch — and would break any CI step that builds ./cmd/... natively.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "worker: build for the Workers runtime, not this platform:")
	fmt.Fprintln(os.Stderr, "  GOOS=js GOARCH=wasm go build -o build/worker.wasm ./cmd/worker")
	os.Exit(1)
}
