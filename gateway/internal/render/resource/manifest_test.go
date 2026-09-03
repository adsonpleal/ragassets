package resource

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func buildOrFail(t *testing.T, keys []string) *Manifest {
	t.Helper()
	m, collisions, err := BuildManifest(keys)
	if err != nil {
		t.Fatalf("BuildManifest: %v (%v)", err, collisions)
	}
	return m
}

func roundTrip(t *testing.T, m *Manifest) *Manifest {
	t.Helper()
	var buf bytes.Buffer
	if err := m.Write(&buf); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got, err := LoadManifest(&buf)
	if err != nil {
		t.Fatalf("LoadManifest: %v", err)
	}
	return got
}

func TestManifestRoundTrip(t *testing.T) {
	keys := []string{
		"sprite/인간족/몸통/남/검사_남.spr",
		"sprite/인간족/몸통/남/검사_남.act",
		"palette/머리/머리1_남_0.pal",
		"imf/검사_남.imf",
	}
	m := roundTrip(t, buildOrFail(t, keys))

	if m.Len() != len(keys) {
		t.Errorf("Len = %d, want %d", m.Len(), len(keys))
	}
	for _, k := range keys {
		if !m.Has(k) {
			t.Errorf("Has(%q) = false, want true", k)
		}
	}
	for _, k := range []string{
		"sprite/인간족/몸통/남/검사_여.spr", // real shape, absent
		"sprite/인간족/몸통/남/검사_남.pal", // right name, wrong extension
		"palette/머리/머리1_남_1.pal",
		"",
		"sprite/",
	} {
		if m.Has(k) {
			t.Errorf("Has(%q) = true, want false", k)
		}
	}
}

func TestManifestIsCaseSensitive(t *testing.T) {
	// Matching must follow Linux and object-store semantics, not a
	// case-insensitive developer machine — extraction preserves whatever casing
	// the client shipped, so a case-folding manifest would claim files exist that
	// prod cannot open.
	m := roundTrip(t, buildOrFail(t, []string{"sprite/Data/Foo.spr"}))
	if !m.Has("sprite/Data/Foo.spr") {
		t.Error("exact key should be present")
	}
	if m.Has("sprite/data/foo.spr") {
		t.Error("lowercased key should not match a mixed-case entry")
	}
}

func TestManifestDeduplicatesKeys(t *testing.T) {
	m := buildOrFail(t, []string{"a/x.spr", "a/x.spr", "a/y.spr"})
	if m.Len() != 2 {
		t.Errorf("Len = %d, want 2 (duplicate key counted once)", m.Len())
	}
}

func TestManifestEmpty(t *testing.T) {
	m := roundTrip(t, buildOrFail(t, nil))
	if m.Len() != 0 {
		t.Errorf("Len = %d, want 0", m.Len())
	}
	if m.Has("anything") {
		t.Error("empty manifest should answer false")
	}
}

func TestLoadManifestRejectsBadMagic(t *testing.T) {
	var buf bytes.Buffer
	buf.WriteString("NOTAMANI")
	buf.Write(make([]byte, 4))
	if _, err := LoadManifest(&buf); err == nil || !strings.Contains(err.Error(), "bad magic") {
		t.Errorf("err = %v, want a bad-magic error", err)
	}
}

func TestLoadManifestRejectsTruncatedBody(t *testing.T) {
	// A short read must fail rather than yield a manifest that quietly answers
	// "no" for everything past the cut.
	m := buildOrFail(t, []string{"a/x.spr", "a/y.spr", "a/z.spr"})
	var buf bytes.Buffer
	if err := m.Write(&buf); err != nil {
		t.Fatal(err)
	}
	full := buf.Bytes()
	if _, err := LoadManifest(bytes.NewReader(full[:len(full)-4])); err == nil {
		t.Error("truncated manifest should fail to load")
	}
}

func TestLoadManifestRejectsUnsortedHashes(t *testing.T) {
	// The lookup is a binary search, so an unsorted file would answer "no" for
	// keys that are present. Detect it at load rather than serve wrong renders.
	m := buildOrFail(t, []string{"a/x.spr", "a/y.spr", "a/z.spr"})
	var buf bytes.Buffer
	if err := m.Write(&buf); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	head := manifestHeadLen
	// Swap the first two hashes to break the ordering.
	var tmp [8]byte
	copy(tmp[:], b[head:head+8])
	copy(b[head:head+8], b[head+8:head+16])
	copy(b[head+8:head+16], tmp[:])
	if _, err := LoadManifest(bytes.NewReader(b)); err == nil ||
		!strings.Contains(err.Error(), "ascending") {
		t.Errorf("err = %v, want an ordering error", err)
	}
}

// TestManifestMatchesFilesystem is the acceptance test: over the real extracted
// tree, the manifest must answer exactly what a stat answers. It is the whole
// premise of replacing one with the other.
func TestManifestMatchesFilesystem(t *testing.T) {
	root := resourcesRoot(t)

	var keys []string
	for folder, exts := range map[string][]string{
		"sprite":  {".spr", ".act"},
		"palette": {".pal"},
		"imf":     {".imf"},
	} {
		dir := filepath.Join(root, "data", folder)
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			lower := strings.ToLower(p)
			for _, e := range exts {
				if strings.HasSuffix(lower, e) {
					rel, relErr := filepath.Rel(dir, p)
					if relErr != nil {
						return relErr
					}
					keys = append(keys, folder+"/"+filepath.ToSlash(rel))
					return nil
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", dir, err)
		}
	}
	if len(keys) == 0 {
		t.Skip("no resource files present")
	}

	m := roundTrip(t, buildOrFail(t, keys))
	fsx := FSExistence{Root: root}

	// Every real key: present in both.
	for _, k := range keys {
		if !m.Has(k) {
			t.Fatalf("manifest missing %q", k)
		}
	}

	// Absent keys: false in both. Derived from real ones so they exercise the
	// same directories and encodings rather than trivially-wrong strings.
	var checked int
	for i, k := range keys {
		if i%997 != 0 { // sample: a stat per key over 188k files is slow
			continue
		}
		for _, absent := range []string{k + ".nope", k + "x", strings.ToUpper(k)} {
			if absent == k {
				continue
			}
			gotM, gotFS := m.Has(absent), fsx.Has(absent)
			// A case-insensitive dev filesystem legitimately disagrees on the
			// uppercased variant; the manifest follows prod, so only compare
			// where the filesystem says no.
			if !gotFS && gotM {
				t.Errorf("manifest says %q exists, filesystem says no", absent)
			}
			checked++
		}
	}
	t.Logf("%d keys covered, %d absent-key probes cross-checked", len(keys), checked)
}
