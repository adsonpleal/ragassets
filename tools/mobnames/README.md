# Mob-name pipeline — jobID → localized name (PT / EN / ES)

Maintains [`mobs.json`](../../mobs.json) (repo root): the **source of truth** mapping every Ragnarok
monster `jobID → { en, pt, es, aegis, strId, source, confidence }` for the LATAM client.

A client/GRF update can add (or re-localize) monsters. This pipeline re-extracts the client, **keeps
everything already known**, and resolves only the new/changed rows — most of them automatically, by
certainty, falling back to agents for the genuinely ambiguous tail.

## The data
- **i18n CSV** `data/i18n/sc/<hash>.csv` (hash = index 0 of `sc.json`) → `strId(=100000+row) → {EN,PT,ES}`.
  The names; **no jobID**. This is the only place the localized names live.
- **navi_mob_br.lub** → `AEGIS → strId` token for every *spawnable* mob — the one static game file that
  links an identifier to a strId. Joined with **npcidentity.lub** (`AEGIS ↔ jobID`) it gives the exact
  anchors.
- Names are always taken from the CSV. rAthena / Divine Pride / replays are **oracles only** (to find &
  verify jobID↔row links), never the displayed name.

## Tiers (most certain → least)
| Tier | Source | Confidence | How |
|---|---|---|---|
| 1 | **navi token** | `exact` | `strId →(navi)→ AEGIS →(npcidentity)→ jobID`. Deterministic, game-file. |
| 2 | **ordered-fill** | `high` | exact-count gaps between anchors filled in ascending jobID order. |
| 3 | **grouped / shadow** | `med`/`low` | same-name rows ↔ same-aegis jobIDs in order; co-named variants share a name. |
| 4 | **agents** | `med`/`low` | aegis semantics + ordering rails + Divine Pride, for the displaced/ambiguous residual. |

Invariant enforced at every step: **no assignment may contradict a navi anchor** (the scripts abort if so).

## Run it (after a client update)
```bash
# 1. deterministic tiers — updates mobs.json, writes the residual for agents
node tools/mobnames/resolve.mjs

# 2. (optional) warm the Divine Pride oracle for the unused jobID pool (rate-limited, resumable)
node tools/mobnames/dp.mjs

# 3. agent stage — build task files, then run the agents (see the /update-mob-names skill)
node tools/mobnames/prepare-agents.mjs
#   ... spawn one agent per agent-tasks/band<N>.txt (the skill does this) ...
node tools/mobnames/merge-agents.mjs

# 4. audit
node tools/mobnames/report.mjs      # coverage, confidence mix, navi integrity, ground truth (exits 1 if broken)
```
If `resolve.mjs` reports `UNRESOLVED rows -> agents: 0`, you're done after step 1 — the update was fully
covered by navi/ordered-fill (the common case for new spawnable mobs). The **`/update-mob-names` skill**
runs the whole loop, including spawning and grading the agents.

`GRF_PATH` env overrides the client path (default `C:/Gravity/Ragnarok/data.grf`).

## Files
| File | Role |
|---|---|
| `lib.mjs` | GRF extraction (CSV/navi/npcidentity) + matching utils. `vendor/lua51.mjs` = Lua 5.1 decoder. |
| `resolve.mjs` | Incremental tiered deterministic resolver → `mobs.json` + `unresolved.json`. |
| `dp.mjs` | Divine Pride name oracle (cached/resumable). Key in git-ignored `.env`. |
| `prepare-agents.mjs` | `unresolved.json` → `agent-tasks/pool.txt` + `band<N>.txt`. |
| `merge-agents.mjs` | apply `agent-tasks/band<N>.answer.json` → `mobs.json` (gap-fill only, navi-safe). |
| `report.mjs` | coverage / confidence / navi-integrity / ground-truth audit. |

Caches and working files (`dp_cache.json`, `unresolved.json`, `agent-tasks/`) are git-ignored — only the
scripts and `mobs.json` are committed.

## Coverage reality
~97.6% of the **distinct localized names** the client ships (the rest are NPC names, not monsters). The
client has ~2,834 distinct names for ~4,426 jobIDs, so variants beyond that physically share a name or have
none — only the navi-token rows are derivable from a static file alone; everything else carries a
`confidence` label because it is inference validated against navi + Divine Pride.
