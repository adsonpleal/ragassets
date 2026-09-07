// Worker entry point. Replaces the shim workers-assets-gen generates, for one
// reason: that one builds a fresh WebAssembly instance and a fresh Go runtime on
// every request.
//
// Measured on staging with the generated shim, /healthz — which does nothing but
// write "ok" — cost ~270 ms of server time, against ~50 ms for the whole EC2
// gateway including a render. Instantiating a 7 MB module and starting the Go
// runtime per request is most of that, and it also means:
//
//   - sync.Once re-runs, so the existence manifest is re-fetched from R2 on
//     EVERY request. At 1.44 MB and a Class B operation each, that alone would
//     dominate both latency and cost.
//   - the renderer's parse caches are discarded between requests, so every
//     render re-parses its sprites.
//
// So the instance is created once per isolate and reused. The Go side is built
// for this: workers.Serve() parks on a channel that never closes, and the
// handler runs as a goroutine per request, so concurrent requests interleave on
// the Go scheduler rather than racing.
//
// The catch, and the reason the generated shim does it the other way: the
// runtime context — {env, ctx, binding} — is captured when go.run() is called
// and read once by the Go side at init. Reusing the instance therefore pins it
// to the FIRST request's context. `env` holds the bindings and is not
// request-scoped, so R2 access stays valid; `ctx` (waitUntil,
// passThroughOnException) becomes stale, which is why nothing here may use it.
// If a waitUntil is ever needed, it has to be done on the JS side with the
// current request's ctx, not through Go.
import "./wasm_exec.js";
import { createRuntimeContext, loadModule } from "./runtime.mjs";
import { PATCH_INDEX, parsePatchList } from "./patchlist.mjs";

// The Go program does not stay alive indefinitely. workers.Serve() parks main on
// a channel, but Go's js/wasm runtime exits once its event loop has nothing
// pending — which happens whenever the isolate goes idle between requests. A
// request that then reaches the dead instance throws "Go program has already
// exited". Under sustained load this never fires, which is exactly why it has to
// be handled rather than assumed away: it shows up as intermittent 500s in quiet
// periods and looks like flakiness.
//
// So the instance is cached but treated as disposable. go.run()'s promise
// resolves when main returns, which drops the cached instance the moment it
// dies, and every dispatch re-checks the runtime's own exit flag first.
let mod;
let booting; // Promise<{go, binding, pending, seq}>, shared by every request arriving during boot

// Wedge detection.
//
// A Go runtime can stop making progress without exiting, and when it does this
// shim used to keep feeding it. Caught in the act by sampling /debug/r2's
// in-flight snapshot during a burst: one isolate was holding seven requests
// frozen at `cache-lookup` and `prefetched`, all of their ages advancing in
// lockstep, the oldest at 17,094,365 ms — four and three quarter hours. Another
// held one for 23 minutes. None of them ever completed. go.exited was false the
// whole time, because main had not returned; the runtime was simply not running
// any more.
//
// Every request routed to such an instance joins the pile. That is the failure
// behind the invocations the Workers runtime kills with "your Worker's code had
// hung and would never generate a response", and behind the empty-bodied 500s
// that reach clients: not one slow render, but an isolate that stopped and kept
// accepting work.
//
// Detection has to live here rather than in Go. Asking a wedged runtime whether
// it is wedged is asking a question that cannot come back — /debug/r2 only
// answered because the request landed on a different isolate. JS knows enough on
// its own: it dispatched the request and it knows the promise never settled.
//
// So each instance tracks its outstanding dispatches, and one older than
// WEDGED_MS condemns it. A render's median is 143 ms and its worst observed is
// ~1.3 s, so twelve seconds cannot be reached by anything healthy, while staying
// under the runtime's own hang detector — the aim is to stop feeding the corpse
// before the platform starts killing requests, not after.
//
// This is deliberately not the age-or-request-count recycling that was tried and
// reverted (see CHANGELOG). That retired healthy instances on a timer and left
// wedged ones in service, which is exactly backwards, and measured identical to
// no recycling at all in a matched A/B. The signal is the wedge, not the age.
const WEDGED_MS = 12_000;

// A condemned instance is dropped from the cache, never killed: a Go runtime
// mid-render has no interruption point, and the requests already stuck in it are
// beyond rescue either way. What this buys is that the NEXT request gets a live
// runtime instead of joining them.
function isWedged(inst) {
  const now = Date.now();
  for (const startedAt of inst.pending.values()) {
    if (now - startedAt >= WEDGED_MS) return true;
  }
  return false;
}

globalThis.tryCatch = (fn) => {
  try {
    return { result: fn() };
  } catch (e) {
    return { error: e };
  }
};

function boot(env, ctx) {
  if (booting) return booting;
  const thisBoot = (async () => {
    if (mod === undefined) mod = await loadModule();
    const binding = {};
    const go = new Go();
    let ready;
    const readyPromise = new Promise((resolve) => {
      ready = resolve;
    });
    const instance = new WebAssembly.Instance(mod, {
      ...go.importObject,
      workers: { ready: () => ready() },
    });
    // Resolves when Go's main returns, i.e. when this instance is no longer
    // usable. Dropping the cache there means the next request boots a fresh one
    // instead of calling into a corpse.
    go.run(instance, createRuntimeContext({ env, ctx, binding })).finally(() => {
      if (booting === thisBoot) booting = undefined;
    });
    await readyPromise;
    // go travels with the binding so a dispatch can ask the runtime whether it
    // is still alive, rather than inferring it from a thrown message. pending
    // records what has been handed to this instance and not come back, which is
    // what isWedged reads.
    return { go, binding, pending: new Map(), seq: 0 };
  })().catch((e) => {
    if (booting === thisBoot) booting = undefined;
    throw e;
  });
  booting = thisBoot;
  return booting;
}

async function fetch(req, env, ctx) {
  let inst = await boot(env, ctx);
  // wasm_exec.js sets go.exited synchronously as main returns, and JS here is
  // single-threaded, so testing it immediately before dispatch closes the window
  // between the instance dying and go.run()'s .finally clearing the cache. The
  // alternative — call into the corpse and match the thrown message — depends on
  // the wording of a string in a generated file that tools/build-worker.sh
  // re-emits from whatever Go toolchain is present.
  // Two ways an instance can be unusable, and they need different tests. A
  // runtime that returned from main sets go.exited; one that stopped making
  // progress sets nothing at all, and is only visible as dispatches that never
  // came back.
  if (inst.go.exited || isWedged(inst)) {
    booting = undefined;
    inst = await boot(env, ctx);
  }
  try {
    return await dispatch(inst, req);
  } catch (e) {
    // Backstop for any exit path that does not set the flag before throwing. A
    // second failure is a real error and belongs to the caller.
    if (!/already exited/.test(String(e && e.message))) throw e;
    booting = undefined;
    const fresh = await boot(env, ctx);
    return await dispatch(fresh, req);
  }
}

// dispatch hands one request to an instance while recording that it is
// outstanding. The finally is what makes isWedged meaningful: an entry that is
// never cleared is a request that never came back.
async function dispatch(inst, req) {
  const id = ++inst.seq;
  inst.pending.set(id, Date.now());
  try {
    return await inst.binding.handleRequest(req);
  } finally {
    inst.pending.delete(id);
  }
}

// ---------------------------------------------------------------------------
// The patch poll.
//
// Deliberately plain JavaScript rather than Go: it fetches one 70 KB file,
// compares a string, and maybe POSTs. Routing that through the wasm module would
// mean instantiating the Go runtime every ten minutes to do nothing, since the
// answer is "no change" essentially every time.
// ---------------------------------------------------------------------------

const STATE_ETAG = "patch_etag";
const STATE_SEQ = "last_seq";

async function scheduled(event, env, ctx) {
  const kv = env.UPDATE_STATE;
  const prevETag = kv ? await kv.get(STATE_ETAG) : null;
  const prevSeq = Number((kv ? await kv.get(STATE_SEQ) : 0) || 0);

  // cacheTtl: 0 is load-bearing. patch.txt is served with
  // Cache-Control: public, max-age=3600, so without this the Worker's own fetch
  // would happily answer from cache and a ten-minute poll would silently become
  // an hourly one.
  const res = await globalThis.fetch(PATCH_INDEX, {
    headers: prevETag ? { "If-None-Match": prevETag } : {},
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (res.status === 304) {
    console.log(`patch poll: 304, unchanged (seq ${prevSeq})`);
    return;
  }
  if (!res.ok) {
    console.log(`patch poll: HTTP ${res.status} — leaving state untouched`);
    return;
  }

  const etag = res.headers.get("etag");
  const list = parsePatchList(await res.text());
  const maxSeq = list.reduce((m, p) => Math.max(m, p.seq), 0);
  const fresh = list.filter((p) => p.seq > prevSeq);

  if (!fresh.length) {
    // The file changed but carries nothing newer — a retraction, or a rewrite.
    // Record the new validator so the next poll is a cheap 304 again.
    if (kv && etag) await kv.put(STATE_ETAG, etag);
    console.log(`patch poll: index changed but no new patches (seq ${maxSeq})`);
    return;
  }

  console.log(`patch poll: ${fresh.length} new patch(es), seq ${prevSeq} -> ${maxSeq}`);

  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    // Not configured yet: report and leave the state untouched, so the work is
    // still pending once it is.
    console.log("patch poll: GITHUB_TOKEN/GITHUB_REPO unset, not dispatching");
    return;
  }

  const dispatch = await globalThis.fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ragassets-patch-poll",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "client-patch",
        client_payload: {
          fromSeq: prevSeq,
          toSeq: maxSeq,
          files: fresh.slice(0, 100).map((p) => p.file),
        },
      }),
    },
  );

  if (!dispatch.ok) {
    // State is deliberately NOT advanced. A failed dispatch must leave the work
    // pending, or the patch is skipped forever: the next poll would see the same
    // index, match on seq, and do nothing.
    console.log(`patch poll: dispatch failed HTTP ${dispatch.status} — state unchanged, will retry`);
    return;
  }

  if (kv) {
    await kv.put(STATE_SEQ, String(maxSeq));
    if (etag) await kv.put(STATE_ETAG, etag);
  }
  console.log(`patch poll: dispatched, state advanced to seq ${maxSeq}`);
}

export default { fetch, scheduled };
