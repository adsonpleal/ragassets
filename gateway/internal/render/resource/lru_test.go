package resource

import "testing"

func TestLRUEvictsColdEntry(t *testing.T) {
	c := newLRU[int](2)
	c.put("a", 1)
	c.put("b", 2)
	c.put("c", 3) // evicts "a"

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
	c.put("a", 1)
	c.put("b", 2)
	// Touch "a" so "b" is now the LRU tail.
	if _, ok := c.get("a"); !ok {
		t.Fatal("a missing")
	}
	c.put("c", 3) // should evict "b", not "a"

	if _, ok := c.get("b"); ok {
		t.Error("b should have been evicted (was LRU after touching a)")
	}
	if _, ok := c.get("a"); !ok {
		t.Error("a should still be present")
	}
}

func TestLRUUpdateReplacesValue(t *testing.T) {
	c := newLRU[int](2)
	c.put("a", 1)
	c.put("a", 99)
	if v, _ := c.get("a"); v != 99 {
		t.Errorf("a = %d, want 99", v)
	}
	if got := c.len(); got != 1 {
		t.Errorf("len = %d, want 1", got)
	}
}
