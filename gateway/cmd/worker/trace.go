//go:build js && wasm

package main

import (
	"fmt"
	"sync/atomic"
	"time"
)

// Stage tracing for /image and /gif.
//
// Why it exists: the Workers runtime was observed killing 23 of 60 concurrent
// renders with "your Worker's code had hung and would never generate a response".
// A hang produces no response, no status and no stack, so the only way to learn
// where it stalls is to say where it has got to. Each stage prints a line, and a
// request that hung is one whose id has a first line and no `done`; the last
// stage it printed is the one it died in.
//
// Every request logs, deliberately. Sampling would be the obvious economy and
// the wrong one: the failure is intermittent and not load-proportional (4
// concurrent gave 18 failures, 8 gave 0, 16 gave 28, 56 gave 0), so a sample
// that misses the bad burst tells us nothing. Volume is bounded by /image
// traffic, which the render cache has already cut sharply.
//
// This is a diagnostic, not a permanent fixture. Once the stall is located it
// should be cut back to the stage boundaries that turn out to matter.
//
// A caution on the numbers: Workers freezes the clock except while I/O is in
// flight, so these durations measure I/O and not CPU. A stage that shows 0 ms did
// not necessarily run quickly — it did not wait. That is exactly the right
// instrument here, because a hang is a wait that never ends.
var traceSeq atomic.Int64

type tracer struct {
	id    int64
	start time.Time
	last  time.Time
}

func startTrace(what string) *tracer {
	now := time.Now()
	t := &tracer{id: traceSeq.Add(1), start: now, last: now}
	fmt.Printf("trace %s/%d %s enter\n", isolateID, t.id, what)
	return t
}

// mark reports reaching a stage, with the wait since the previous one and since
// entry. Printed rather than buffered until the end: a request that hangs never
// reaches an end, and the whole point is to see how far it got.
func (t *tracer) mark(stage string) {
	now := time.Now()
	fmt.Printf("trace %s/%d %s +%dms total=%dms\n",
		isolateID, t.id, stage,
		now.Sub(t.last).Milliseconds(), now.Sub(t.start).Milliseconds())
	t.last = now
}
