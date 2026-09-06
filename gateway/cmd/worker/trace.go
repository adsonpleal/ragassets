//go:build js && wasm

package main

import (
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Stage tracking for /image and /gif.
//
// This started as printf tracing, to answer a question that had no other way in:
// the Workers runtime was killing concurrent renders with "your Worker's code had
// hung and would never generate a response", and a hang leaves no response, no
// status and no stack. Printing each stage found it in one burst — a request
// whose last line was `planned` and which never reached `prefetched`, i.e. stuck
// inside Prefetch on a JS promise that never settled.
//
// What survives is the part worth keeping. Logging every stage of every request
// was right for a diagnostic and wrong as a fixture, but dropping it entirely
// would leave the same blind spot if this recurs. So stages are now recorded in
// memory and reported through /debug/r2 instead: a request that is stuck shows up
// as an in-flight entry whose stage stops advancing, which is the same signal at
// no cost per request. Only two things reach the log — a render that was shed,
// and one slow enough to be worth a line.
//
// A caution on the durations: Workers freezes the clock except while I/O is in
// flight, so these measure waiting, not CPU. That is the right instrument for a
// hang, which is a wait that never ends, and the wrong one for a slow render.
const slowRender = 3 * time.Second

var (
	traceSeq atomic.Int64
	traceMu  sync.Mutex
	inflight = map[int64]*tracer{}
)

type tracer struct {
	id    int64
	kind  string
	start time.Time
	stage string
}

func startTrace(kind string) *tracer {
	t := &tracer{id: traceSeq.Add(1), kind: kind, start: time.Now(), stage: "enter"}
	traceMu.Lock()
	inflight[t.id] = t
	traceMu.Unlock()
	return t
}

// mark records reaching a stage. Deliberately cheap: no formatting, no I/O.
func (t *tracer) mark(stage string) {
	traceMu.Lock()
	t.stage = stage
	traceMu.Unlock()
}

// finish retires the request, and says so only if it was slow enough to matter.
func (t *tracer) finish() {
	traceMu.Lock()
	delete(inflight, t.id)
	stage := t.stage
	traceMu.Unlock()
	if d := time.Since(t.start); d >= slowRender {
		fmt.Printf("slow %s %s/%d %s %dms\n", t.kind, isolateID, t.id, stage, d.Milliseconds())
	}
}

// InflightRender is one render still running, as reported by /debug/r2.
type InflightRender struct {
	ID    int64  `json:"id"`
	Kind  string `json:"kind"`
	Stage string `json:"stage"`
	AgeMs int64  `json:"ageMs"`
}

// inflightRenders snapshots what is currently running, oldest first. An entry
// that is old and whose stage never changes between two samples is a stall, and
// its stage names where.
func inflightRenders() []InflightRender {
	traceMu.Lock()
	out := make([]InflightRender, 0, len(inflight))
	for _, t := range inflight {
		out = append(out, InflightRender{
			ID: t.id, Kind: t.kind, Stage: t.stage,
			AgeMs: time.Since(t.start).Milliseconds(),
		})
	}
	traceMu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].AgeMs > out[j].AgeMs })
	return out
}
