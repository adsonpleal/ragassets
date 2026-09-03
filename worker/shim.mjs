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

// The Go program does not stay alive indefinitely. workers.Serve() parks main on
// a channel, but Go's js/wasm runtime exits once its event loop has nothing
// pending — which happens whenever the isolate goes idle between requests. A
// request that then reaches the dead instance throws "Go program has already
// exited". Under sustained load this never fires, which is exactly why it has to
// be handled rather than assumed away: it shows up as intermittent 500s in quiet
// periods and looks like flakiness.
//
// So the instance is cached but treated as disposable. go.run()'s promise
// resolves when main returns, which is used to drop the cached instance the
// moment it dies; a request that races that window retries once on a fresh one.
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
    return binding;
  })().catch((e) => {
    if (booting === thisBoot) booting = undefined;
    throw e;
  });
  booting = thisBoot;
  return booting;
}

async function fetch(req, env, ctx) {
  try {
    const binding = await boot(env, ctx);
    return await binding.handleRequest(req);
  } catch (e) {
    // One retry, for the window between the instance dying and the exit handler
    // clearing it. A second failure is a real error and belongs to the caller.
    if (!/already exited/.test(String(e && e.message))) throw e;
    booting = undefined;
    const binding = await boot(env, ctx);
    return await binding.handleRequest(req);
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

const PATCH_INDEX = "https://ro1patch.gnjoylatam.com/LIVE/patchinfo/patch.txt";
const STATE_ETAG = "patch_etag";
const STATE_SEQ = "last_seq";

// parsePatchList reads the index: "<seq> <filename>" per line. A tab-indented
// line prefixed with // is a patch that was pulled after release — the official
// patcher skips those and so do we, though the files often still exist on the
// CDN.
function parsePatchList(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*\/\//.test(raw)) continue;
    const m = raw.match(/^\s*(\d+)[\s\t]+(\S+)\s*$/);
    if (m) out.push({ seq: Number(m[1]), file: m[2] });
  }
  return out;
}

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
