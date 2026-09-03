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

let mod;
let booting; // Promise<binding>, shared by every request that arrives during boot

globalThis.tryCatch = (fn) => {
  try {
    return { result: fn() };
  } catch (e) {
    return { error: e };
  }
};

function boot(env, ctx) {
  if (booting) return booting;
  booting = (async () => {
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
    // Not awaited: workers.Serve() never returns, so this promise stays pending
    // for the life of the isolate. That is what keeps the instance alive.
    go.run(instance, createRuntimeContext({ env, ctx, binding }));
    await readyPromise;
    return binding;
  })().catch((e) => {
    // Let the next request retry rather than wedging the isolate on one failure.
    booting = undefined;
    throw e;
  });
  return booting;
}

async function fetch(req, env, ctx) {
  const binding = await boot(env, ctx);
  return binding.handleRequest(req);
}

export default { fetch };
