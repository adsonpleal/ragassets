package resource

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sort"
)

// A Manifest answers Existence for a whole resource tree without a filesystem.
//
// The renderer probes far more often than it reads: loadGarment alone can test a
// dozen candidate act/spr pairs before finding one, and those probes are what
// BuildPlan resolves a request with. Against a local disk that is a stat; against
// an object store it would be a network round trip each, before a single byte of
// sprite is fetched. Baking the answers is what removes that entirely.
//
// Representation: the FNV-1a 64-bit hash of every key, sorted, binary-searched.
// The measured tree is 188,199 files, so this is 1.44 MB — against a 128 MB
// isolate, and against the ~15-20 MB the same keys would cost as Go strings in a
// map. A gzipped path list is smaller on the wire (738 KB) but has to become
// those strings to be queryable, so it loses where it matters.
//
// The trade is false positives. A collision makes Has report a key that is not
// there, and one probe site treats that as fatal: resolveBody commits to an
// alternative outfit on a positive answer, and a failed load of the body sprite
// is a 500 rather than a fallback. The arithmetic says not to worry — with 188k
// keys in a 64-bit space, one probe of an absent key collides with probability
// ~1e-14, so at ~3e8 probes a month the expected rate is around one in forty
// thousand years — but it is a trade, not an absence of one, which is why the
// generator refuses to emit a manifest whose own keys collide.
type Manifest struct {
	hashes []uint64 // sorted ascending
}

const (
	manifestMagic   = "RAGEXST1"
	manifestHeadLen = len(manifestMagic) + 4
)

// hashKey is FNV-1a 64. Inlined rather than via hash/fnv to keep the hot path
// allocation-free and the format independent of that package's behaviour.
//
// Keys are hashed exactly as given, so matching is case-sensitive — the same
// semantics as a Linux filesystem and an object store, and deliberately not
// those of a case-insensitive developer machine. See the note on extraction
// preserving the client's casing in internal/effect/store.go.
func hashKey(key string) uint64 {
	const (
		offset64 = 14695981039346656037
		prime64  = 1099511628211
	)
	h := uint64(offset64)
	for i := 0; i < len(key); i++ {
		h ^= uint64(key[i])
		h *= prime64
	}
	return h
}

// BuildManifest hashes keys into a Manifest, reporting any pair of distinct keys
// that collide. Collisions are vanishingly unlikely but not impossible, and the
// one place to find out is here, where the offending keys are still in hand.
func BuildManifest(keys []string) (*Manifest, []string, error) {
	seen := make(map[uint64]string, len(keys))
	hashes := make([]uint64, 0, len(keys))
	var collisions []string
	for _, k := range keys {
		h := hashKey(k)
		if prev, dup := seen[h]; dup {
			if prev != k {
				collisions = append(collisions, fmt.Sprintf("%q and %q both hash to %#x", prev, k, h))
			}
			continue // duplicate key, or a collision already recorded
		}
		seen[h] = k
		hashes = append(hashes, h)
	}
	sort.Slice(hashes, func(i, j int) bool { return hashes[i] < hashes[j] })
	if len(collisions) > 0 {
		return nil, collisions, errors.New("manifest: key hash collisions")
	}
	return &Manifest{hashes: hashes}, nil, nil
}

// Write serialises the manifest: magic, a u32 count, then the sorted hashes.
func (m *Manifest) Write(w io.Writer) error {
	head := make([]byte, manifestHeadLen)
	copy(head, manifestMagic)
	binary.LittleEndian.PutUint32(head[len(manifestMagic):], uint32(len(m.hashes)))
	if _, err := w.Write(head); err != nil {
		return err
	}
	buf := make([]byte, 8*1024)
	for i := 0; i < len(m.hashes); {
		n := 0
		for n+8 <= len(buf) && i < len(m.hashes) {
			binary.LittleEndian.PutUint64(buf[n:], m.hashes[i])
			n += 8
			i++
		}
		if _, err := w.Write(buf[:n]); err != nil {
			return err
		}
	}
	return nil
}

// LoadManifest reads a manifest written by Write.
func LoadManifest(r io.Reader) (*Manifest, error) {
	head := make([]byte, manifestHeadLen)
	if _, err := io.ReadFull(r, head); err != nil {
		return nil, fmt.Errorf("manifest: read header: %w", err)
	}
	if string(head[:len(manifestMagic)]) != manifestMagic {
		return nil, fmt.Errorf("manifest: bad magic %q", head[:len(manifestMagic)])
	}
	count := binary.LittleEndian.Uint32(head[len(manifestMagic):])

	body := make([]byte, 8*int(count))
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, fmt.Errorf("manifest: read %d hashes: %w", count, err)
	}
	hashes := make([]uint64, count)
	for i := range hashes {
		hashes[i] = binary.LittleEndian.Uint64(body[8*i:])
	}
	// Sortedness is what the lookup relies on, and a file that lost it would
	// silently answer "no" for real keys, so check rather than trust.
	for i := 1; i < len(hashes); i++ {
		if hashes[i-1] >= hashes[i] {
			return nil, fmt.Errorf("manifest: hashes not strictly ascending at %d", i)
		}
	}
	return &Manifest{hashes: hashes}, nil
}

// Has reports whether the key was present in the tree the manifest was built
// from. It satisfies Existence.
func (m *Manifest) Has(key string) bool {
	h := hashKey(key)
	i := sort.Search(len(m.hashes), func(i int) bool { return m.hashes[i] >= h })
	return i < len(m.hashes) && m.hashes[i] == h
}

// Len reports how many keys the manifest covers.
func (m *Manifest) Len() int { return len(m.hashes) }
