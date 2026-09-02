package resource

import "testing"

// The cache is byte-budgeted, so these tests give every entry size 1 and set the
// budget in "entries" where the distinction does not matter, and use real byte
// sizes where it does.

func TestLRUEvictsColdEntry(t *testing.T) {
	c := newLRU[int](2)
	c.put("a", 1, 1)
	c.put("b", 2, 1)
	c.put("c", 3, 1) // evicts "a"

	if _, ok := c.get("a"); ok {
		t.Error("a should have been evicted")
	}
	if v, ok := c.get("b"); !ok || v != 2 {
		t.Errorf("b = (%v, %v), want (2, true)", v, ok)
	}
	if v, ok := c.get("c"); !ok || v != 3 {
		t.Errorf("c = (%v, %v), want (3, true)", v, ok)
	}
	if got := c.len(); got != 2 {
		t.Errorf("len = %d, want 2", got)
	}
}

func TestLRUMovesToFrontOnGet(t *testing.T) {
	c := newLRU[int](2)
	c.put("a", 1, 1)
	c.put("b", 2, 1)
	// Touch "a" so "b" is now the LRU tail.
	if _, ok := c.get("a"); !ok {
		t.Fatal("a missing")
	}
	c.put("c", 3, 1) // should evict "b", not "a"

	if _, ok := c.get("b"); ok {
		t.Error("b should have been evicted (was LRU after touching a)")
	}
	if _, ok := c.get("a"); !ok {
		t.Error("a should still be present")
	}
}

func TestLRUUpdateReplacesValue(t *testing.T) {
	c := newLRU[int](2)
	c.put("a", 1, 1)
	c.put("a", 99, 1)
	if v, _ := c.get("a"); v != 99 {
		t.Errorf("a = %d, want 99", v)
	}
	if got := c.len(); got != 1 {
		t.Errorf("len = %d, want 1", got)
	}
	if got := c.bytes(); got != 1 {
		t.Errorf("bytes = %d, want 1 (update must not double-charge)", got)
	}
}

// TestLRUEvictsByBytes is the point of the byte budget: one large entry must
// displace several small ones, which a count-budgeted cache would not do.
func TestLRUEvictsByBytes(t *testing.T) {
	c := newLRU[string](100)
	c.put("small1", "a", 10)
	c.put("small2", "b", 10)
	c.put("small3", "c", 10)
	if got := c.bytes(); got != 30 {
		t.Fatalf("bytes = %d, want 30", got)
	}

	c.put("big", "B", 95) // must evict all three smalls to fit

	if got := c.bytes(); got > 100 {
		t.Errorf("bytes = %d, over budget 100", got)
	}
	for _, k := range []string{"small1", "small2", "small3"} {
		if _, ok := c.get(k); ok {
			t.Errorf("%s should have been evicted to make room", k)
		}
	}
	if _, ok := c.get("big"); !ok {
		t.Error("big should be resident")
	}
}

// TestLRUUpdateRecharges checks that replacing an entry with a differently sized
// one adjusts the running total rather than leaking the old charge.
func TestLRUUpdateRecharges(t *testing.T) {
	c := newLRU[string](100)
	c.put("k", "small", 10)
	c.put("k", "large", 60)
	if got := c.bytes(); got != 60 {
		t.Errorf("bytes = %d, want 60", got)
	}
	c.put("k", "small again", 5)
	if got := c.bytes(); got != 5 {
		t.Errorf("bytes = %d, want 5", got)
	}
}

func TestCacheSizeFlagsOversized(t *testing.T) {
	if _, oversized := cacheSize(make([]byte, 1024)); oversized {
		t.Error("1 KiB should not be flagged oversized")
	}
	n, oversized := cacheSize(make([]byte, maxEntryBytes+1))
	if !oversized {
		t.Errorf("%d bytes should be flagged oversized (cap %d)", n, maxEntryBytes)
	}
	if n != maxEntryBytes+1 {
		t.Errorf("size = %d, want %d", n, maxEntryBytes+1)
	}
}
