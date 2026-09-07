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
// The catch the generated shim avoids by instantiating per request: the runtime
// context — {env, ctx, binding} — is passed once, when go.run() is called, so
// reusing the instance would pin every later request to the FIRST one's context.
//
// That is not a theoretical concern. It showed up as invocations the Workers
// runtime killed with "your Worker's code had hung and would never generate a
// response" — 38% of a burst right after a deploy, and about 3 a minute of
// organic traffic in steady state. A binding resolved from a finished
// invocation's env is being used to do I/O on behalf of a live one, which is
// precisely what the platform does not allow.
//
// So the context is refreshed in place on every request rather than left pinned.
// This works because of how the Go side reads it: wasm_exec's proxy resolves
// `globalThis.context` to this exact object, jsutil.RuntimeContext captures a
// reference to it once at init, and every lookup after that is a live property
// read (cfruntimecontext.GetRuntimeContextValue does context.Get(key) per call).
// Assigning new values onto the same object is therefore visible to Go
// immediately, with no re-instantiation and none of its cost.
//
// Refreshing here is only half of it. The Go side must also stop caching what it
// resolves *out* of env — see internal/render/resource/source_r2.go, where the R2
// bucket and the Cache handle are now obtained per operation instead of once per
// isolate. A fresh env that nothing re-reads would fix nothing.
//
// `ctx` (waitUntil, passThroughOnException) is refreshed too and is now current
// rather than stale, but nothing on the Go side uses it and nothing should start
// without checking that a request is actually in flight when it does.
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
let booting; // Promise<{go, binding}>, shared by every request arriving during boot

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
    // Kept, so each request can refresh it in place; see the note above.
    const runtime = createRuntimeContext({ env, ctx, binding });
    // Resolves when Go's main returns, i.e. when this instance is no longer
    // usable. Dropping the cache there means the next request boots a fresh one
    // instead of calling into a corpse.
    go.run(instance, runtime).finally(() => {
      if (booting === thisBoot) booting = undefined;
    });
    await readyPromise;
    // go travels with the binding so a dispatch can ask the runtime whether it
    // is still alive, rather than inferring it from a thrown message. runtime
    // travels with it so each request can point it at its own env and ctx.
    return { go, binding, runtime };
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
  if (inst.go.exited) {
    booting = undefined;
    inst = await boot(env, ctx);
  }
  // Point the shared runtime context at THIS request before handing over. The Go
  // side re-reads both on every binding lookup, so this is what keeps its I/O on
  // behalf of the live invocation rather than the one that happened to boot the
  // instance.
  inst.runtime.env = env;
  inst.runtime.ctx = ctx;

  try {
    return await inst.binding.handleRequest(req);
  } catch (e) {
    // Backstop for any exit path that does not set the flag before throwing. A
    // second failure is a real error and belongs to the caller.
    if (!/already exited/.test(String(e && e.message))) throw e;
    booting = undefined;
    const fresh = await boot(env, ctx);
    fresh.runtime.env = env;
    fresh.runtime.ctx = ctx;
    return await fresh.binding.handleRequest(req);
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
