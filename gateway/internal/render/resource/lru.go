package resource

import "container/list"

// lru is a tiny fixed-capacity LRU cache: a doubly-linked list of insertion order
// plus a map from key to list element. get/put are both O(1). Not safe for
// concurrent use — callers must serialize (Manager holds a single mutex).
type lru[V any] struct {
	cap int
	ll  *list.List
	m   map[string]*list.Element
}

type lruEntry[V any] struct {
	key string
	val V
}

func newLRU[V any](cap int) *lru[V] {
	return &lru[V]{
		cap: cap,
		ll:  list.New(),
		m:   make(map[string]*list.Element, cap+1),
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

// put inserts or updates key=val and evicts the LRU tail if over capacity.
func (c *lru[V]) put(key string, val V) {
	if el, ok := c.m[key]; ok {
		c.ll.MoveToFront(el)
		el.Value.(*lruEntry[V]).val = val
		return
	}
	el := c.ll.PushFront(&lruEntry[V]{key: key, val: val})
	c.m[key] = el
	if c.ll.Len() > c.cap {
		tail := c.ll.Back()
		if tail != nil {
			c.ll.Remove(tail)
			delete(c.m, tail.Value.(*lruEntry[V]).key)
		}
	}
}

func (c *lru[V]) len() int { return c.ll.Len() }
