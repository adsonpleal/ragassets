// Command gen-manifest bakes an existence manifest for the renderer's resource
// tree, so a build serving from an object store can answer "does this sprite
// exist?" without a network round trip.
//
// The renderer probes far more often than it reads. BuildPlan resolves a request
// by testing candidate act/spr pairs — loadGarment alone can walk a dozen before
// one hits — and every one of those is a stat against a local disk but would be a
// request against a bucket, all before a single byte of sprite is fetched.
//
// Scope is the whole tree the render Manager can read: data/{sprite,palette,imf}.
// It would be smaller to cover only the three subtrees BuildPlan probes today
// (로브, costume_*, 아이템/*_이펙트 — 134,937 of the 188,199 files, saving 416 KiB),
// but that couples the manifest to which probes exist, and a probe added later
// would get a confident "no" instead of an answer. The contract here is simply
// "is this key in the tree", which cannot rot that way.
//
// Usage, from the gateway module root:
//
//	go run ./cmd/gen-manifest -resources ../resources -out ../resources/manifest/exists.bin
//
// Rerun after any extraction that adds or removes sprites. The output is content
// independent of path order, so an unchanged tree produces an identical file.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/ragassets/gateway/internal/render/resource"
)

// folders are the category directories the Manager addresses, and the extensions
// it reads from each. Anything else in the tree is not reachable through a
// resource key, so listing it would only inflate the manifest.
var folders = map[string][]string{
	"sprite":  {".spr", ".act"},
	"palette": {".pal"},
	"imf":     {".imf"},
}

func main() {
	log.SetFlags(0)
	res := flag.String("resources", "../resources", "resource directory (the one holding data/)")
	out := flag.String("out", "", "output file (default: <resources>/manifest/exists.bin)")
	keyList := flag.String("keys", "", "read keys from this file (one per line) instead of walking -resources")
	flag.Parse()

	dest := *out
	if dest == "" {
		dest = filepath.Join(*res, "manifest", "exists.bin")
	}

	var (
		keys   []string
		counts map[string]int
		err    error
	)
	if *keyList != "" {
		// The update pipeline has no extracted client — it runs in CI, where the
		// tree is 16 GB and gitignored. But R2 knows the whole key set, so the
		// workflow lists the bucket and feeds it here. Reading a list is also
		// exactly reproducible, which walking a filesystem is not.
		keys, counts, err = readKeys(*keyList)
	} else {
		keys, counts, err = collectKeys(*res)
	}
	if err != nil {
		log.Fatalf("gen-manifest: %v", err)
	}
	if len(keys) == 0 {
		if *keyList != "" {
			log.Fatalf("gen-manifest: %s listed no keys", *keyList)
		}
		log.Fatalf("gen-manifest: no resource files under %s — is it extracted?", *res)
	}

	m, collisions, err := resource.BuildManifest(keys)
	if err != nil {
		// Astronomically unlikely, but if it ever happens the two keys are right
		// here and the format needs widening rather than a silent wrong answer.
		for _, c := range collisions {
			log.Printf("  collision: %s", c)
		}
		log.Fatalf("gen-manifest: %v", err)
	}

	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		log.Fatalf("gen-manifest: %v", err)
	}
	f, err := os.Create(dest)
	if err != nil {
		log.Fatalf("gen-manifest: %v", err)
	}
	w := bufio.NewWriter(f)
	if err := m.Write(w); err != nil {
		log.Fatalf("gen-manifest: write: %v", err)
	}
	if err := w.Flush(); err != nil {
		log.Fatalf("gen-manifest: flush: %v", err)
	}
	if err := f.Close(); err != nil {
		log.Fatalf("gen-manifest: close: %v", err)
	}

	fi, _ := os.Stat(dest)
	for _, folder := range []string{"sprite", "palette", "imf"} {
		fmt.Printf("  %-8s %7d\n", folder, counts[folder])
	}
	fmt.Printf("wrote %s: %d keys, %.2f MiB\n", dest, m.Len(), float64(fi.Size())/(1<<20))
}

// collectKeys walks the category folders and returns resource keys in the same
// form resource.Key builds them: "<folder>/<name>.<ext>", forward-slashed.
func collectKeys(resourcesDir string) ([]string, map[string]int, error) {
	var keys []string
	counts := map[string]int{}
	for folder, exts := range folders {
		root := filepath.Join(resourcesDir, "data", folder)
		if _, err := os.Stat(root); err != nil {
			// A tree extracted with a narrower --match legitimately lacks a
			// folder; that is not an error, it just contributes nothing.
			continue
		}
		err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return nil
			}
			if !hasExt(p, exts) {
				return nil
			}
			rel, err := filepath.Rel(root, p)
			if err != nil {
				return err
			}
			keys = append(keys, folder+"/"+filepath.ToSlash(rel))
			counts[folder]++
			return nil
		})
		if err != nil {
			return nil, nil, fmt.Errorf("walk %s: %w", root, err)
		}
	}
	return keys, counts, nil
}

// readKeys loads keys from a file, one per line, and keeps only those the
// Manager can actually address — the same filter collectKeys applies while
// walking. A bucket listing carries more than the renderer reads (maps, bgm,
// sounds, the static mirror), and admitting those would inflate the manifest
// with keys that can never be probed.
func readKeys(path string) ([]string, map[string]int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	var keys []string
	counts := map[string]int{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		k := strings.TrimSpace(sc.Text())
		if k == "" {
			continue
		}
		k = strings.TrimPrefix(filepath.ToSlash(k), "data/")
		folder, _, ok := strings.Cut(k, "/")
		if !ok {
			continue
		}
		exts, known := folders[folder]
		if !known || !hasExt(k, exts) {
			continue
		}
		keys = append(keys, k)
		counts[folder]++
	}
	return keys, counts, sc.Err()
}

func hasExt(p string, exts []string) bool {
	lower := strings.ToLower(p)
	for _, e := range exts {
		if strings.HasSuffix(lower, e) {
			return true
		}
	}
	return false
}
