#!/usr/bin/env node
// Apply the committed Cloudflare configuration to the zone.
//
// The dashboard is not version control. Every cache rule and zone setting this
// origin depends on used to live only in a web UI, discoverable by clicking —
// which meant the README carried a prose copy that could drift from reality with
// nobody noticing. This makes cloudflare/*.json the source of truth instead.
//
// Idempotent by construction, with no state file. Cache rules go through the
// Rulesets phase entrypoint, which is a declarative PUT: the request body is the
// complete ruleset and replaces whatever is there. A rule deleted from the JSON
// is deleted from Cloudflare on the next apply. Zone settings are individually
// PATCHed and are already declarative.
//
// Usage:
//   node tools/apply-cloudflare.mjs --dry-run   # print the plan; no credentials needed
//   node tools/apply-cloudflare.mjs --diff      # show live vs committed, read-only
//   node tools/apply-cloudflare.mjs             # apply
//
// Environment (apply and --diff only):
//   CF_API_TOKEN  scoped to this zone: Cache Rules:Edit, Zone Settings:Edit,
//                 Config Rules:Edit. NOT a Global API Key — that key can do
//                 anything to every zone on the account.
//   CF_ZONE_ID    the zone id, from the dashboard overview.
//
// Exit codes: 0 applied or nothing to do, 1 a request failed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "cloudflare");
const API = "https://api.cloudflare.com/client/v4";
const PHASE = "http_request_cache_settings";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const DIFF = args.has("--diff");
for (const a of args) {
  if (!["--dry-run", "--diff"].includes(a)) {
    console.error(`unknown flag ${a}`);
    process.exit(1);
  }
}

// Strip the $comment / $why keys. They are documentation for whoever edits these
// files next, and the API rejects unknown fields.
function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).filter(([k]) => !k.startsWith("$")).map(([k, x]) => [k, strip(x)]),
    );
  }
  return v;
}

const load = (name) => JSON.parse(readFileSync(join(DIR, name), "utf8"));
const rulesDoc = load("cache-rules.json");
const zoneDoc = load("zone-settings.json");
const rules = strip(rulesDoc.rules);

function requireEnv() {
  const token = process.env.CF_API_TOKEN;
  const zone = process.env.CF_ZONE_ID;
  if (!token || !zone) {
    console.error("CF_API_TOKEN and CF_ZONE_ID are required (use --dry-run without them)");
    process.exit(1);
  }
  return { token, zone };
}

async function cf(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* a non-JSON body is reported through !res.ok below */
  }
  return { ok: res.ok && json?.success !== false, status: res.status, json };
}

// A failure is only useful if it says which call failed and what Cloudflare
// objected to; the API returns structured errors and dropping them turns a
// five-second fix into a debugging session.
function explain(label, r) {
  const errs = (r.json?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
  return `${label}: HTTP ${r.status}${errs ? ` — ${errs}` : ""}`;
}

function summarise(rs) {
  return rs.map((r) => {
    const p = r.action_parameters ?? {};
    const how = p.cache === false ? "bypass" : `cache, edge=${p.edge_ttl?.mode}, browser=${p.browser_ttl?.mode}`;
    return `    - ${r.description}\n        ${how}`;
  }).join("\n");
}

async function main() {
  if (DRY) {
    console.log(`cache rules (${rules.length}) — phase ${PHASE}:`);
    console.log(summarise(rules));
    console.log("\nzone settings:");
    for (const [k, v] of Object.entries(zoneDoc.settings)) console.log(`    - ${k} = ${JSON.stringify(v.value)}`);
    console.log(`    - tiered_caching = ${JSON.stringify(zoneDoc.tiered_caching.value)}`);
    console.log("\nevery rule is scoped to a single host:");
    const unscoped = rules.filter((r) => !r.expression.includes("http.host"));
    console.log(unscoped.length ? `    NO — ${unscoped.length} rule(s) missing http.host` : "    yes");
    if (unscoped.length) process.exit(1);
    return;
  }

  const { token, zone } = requireEnv();

  // Refuse to touch a zone whose rules are not ours to replace. The PUT is
  // wholesale, so applying against the wrong zone id would delete that zone's
  // cache rules outright — worth one extra GET to make impossible.
  const live = await cf(token, "GET", `/zones/${zone}/rulesets/phases/${PHASE}/entrypoint`);
  const liveRules = live.json?.result?.rules ?? [];
  const foreign = liveRules.filter((r) => !(r.description ?? "").startsWith("ragassets:"));
  if (foreign.length) {
    console.error(`refusing to apply: ${foreign.length} existing rule(s) in this phase are not managed here:`);
    for (const r of foreign) console.error(`    - ${r.description || "(no description)"}`);
    console.error("Adopt them into cloudflare/cache-rules.json or delete them by hand first.");
    process.exit(1);
  }

  if (DIFF) {
    console.log(`live rules (${liveRules.length}):`);
    console.log(liveRules.length ? summarise(liveRules) : "    (none)");
    console.log(`\ncommitted rules (${rules.length}):`);
    console.log(summarise(rules));
    return;
  }

  const put = await cf(token, "PUT", `/zones/${zone}/rulesets/phases/${PHASE}/entrypoint`, { rules });
  if (!put.ok) {
    console.error(explain("cache rules", put));
    process.exit(1);
  }
  console.log(`cache rules: applied ${rules.length}`);

  let failed = 0;
  for (const [name, spec] of Object.entries(zoneDoc.settings)) {
    const r = await cf(token, "PATCH", `/zones/${zone}/settings/${name}`, { value: spec.value });
    if (r.ok) {
      console.log(`setting ${name} = ${JSON.stringify(spec.value)}`);
    } else if (r.status === 403 || r.status === 404) {
      // Not entitled on this plan. Skipping beats failing an unrelated deploy.
      console.log(`setting ${name}: unavailable on this plan, skipped (${r.status})`);
    } else {
      console.error(explain(`setting ${name}`, r));
      failed++;
    }
  }

  const tc = await cf(token, "PATCH", `/zones/${zone}/argo/tiered_caching`, {
    value: zoneDoc.tiered_caching.value,
  });
  if (tc.ok) console.log(`tiered_caching = ${JSON.stringify(zoneDoc.tiered_caching.value)}`);
  else if (tc.status === 403 || tc.status === 404) console.log(`tiered_caching: unavailable on this plan, skipped (${tc.status})`);
  else {
    console.error(explain("tiered_caching", tc));
    failed++;
  }

  if (failed) process.exit(1);
  console.log("done");
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
