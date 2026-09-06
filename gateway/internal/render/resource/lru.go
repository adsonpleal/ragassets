package resource

import "container/list"

// lru is a byte-budgeted LRU cache: a doubly-linked list in recency order plus a
// map from key to list element. get/put are both O(1). Not safe for concurrent
// use — callers must serialize (Manager holds a single mutex).
//
// The budget is bytes rather than entries because the sprite library's size
// distribution has a brutal tail. .spr files average ~41 KB, but
// data/sprite/몬스터/firepit.spr alone is 19.5 MB and several other monsters clear
// 10 MB. A count-budgeted cache sized against the average will cheerfully retain
// twenty of those — hundreds of megabytes — while its entry count still reads as
// nowhere near the limit. Charging real bytes is the only bound that holds.
type lru[V any] struct {
	maxBytes  int64
	usedBytes int64
	ll        *list.List
	m         map[string]*list.Element
}

type lruEntry[V any] struct {
	key  string
	val  V
	size int64
}

func newLRU[V any](maxBytes int64) *lru[V] {
	return &lru[V]{
		maxBytes: maxBytes,
		ll:       list.New(),
		m:        map[string]*list.Element{},
	}
}

func (c *lru[V]) get(key string) (V, bool) {
	if el, ok := c.m[key]; ok {
		c.ll.MoveToFront(el)
		return el.Value.(*lruEntry[V]).val, true
	}
	var zero V
	return zero, false
}

// peek reports whether key is held, without promoting it. get would be wrong
// here: an existence probe is not a use, and letting one reorder recency would
// let a caller that only ever asks "is this cached?" keep entries alive that
// nothing actually reads.
func (c *lru[V]) peek(key string) bool {
	_, ok := c.m[key]
	return ok
}

// put inserts or updates key=val, charging size bytes against the budget, then
// evicts from the tail until back inside it.
func (c *lru[V]) put(key string, val V, size int64) {
	if el, ok := c.m[key]; ok {
		e := el.Value.(*lruEntry[V])
		c.usedBytes += size - e.size
		e.val, e.size = val, size
		c.ll.MoveToFront(el)
		c.evict()
		return
	}
	c.m[key] = c.ll.PushFront(&lruEntry[V]{key: key, val: val, size: size})
	c.usedBytes += size
	c.evict()
}

func (c *lru[V]) evict() {
	for c.usedBytes > c.maxBytes {
		tail := c.ll.Back()
		if tail == nil {
			return
		}
		e := c.ll.Remove(tail).(*lruEntry[V])
		delete(c.m, e.key)
		c.usedBytes -= e.size
	}
}

func (c *lru[V]) len() int { return c.ll.Len() }

// bytes reports the current charged size, for tests and instrumentation.
func (c *lru[V]) bytes() int64 { return c.usedBytes }
