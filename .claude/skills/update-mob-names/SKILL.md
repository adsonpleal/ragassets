---
name: update-mob-names
description: Refresh mobs.json (jobID → localized PT/EN/ES monster names) after a Ragnarok client/GRF update. Runs the tiered resolver, then spawns agents for the ambiguous residual. Use when the user says "update mob names", "new monsters in the client", "refresh mobs.json", "re-run the mob name pipeline", or after a client patch adds monsters.
---

# Update mob names

Maintains `mobs.json` (repo root) — `jobID → {en,pt,es,aegis,strId,source,confidence}`. `mobs.json` is the
**source of truth**; this loop only resolves the delta after a client update. Full design in
`tools/mobnames/README.md`. **Never hand-edit `mobs.json`** — go through the scripts so navi integrity is enforced.

## Steps

1. **Resolve the deterministic tiers** (navi → ordered-fill → grouped/shadow), incremental & navi-safe:
   ```
   node tools/mobnames/resolve.mjs
   ```
   Read the printed report. If `navi integrity broken` is non-zero it aborts — stop and investigate
   (usually a bad GRF_PATH or a corrupt extract). If `UNRESOLVED rows -> agents: 0`, skip to step 5 — the
   update was fully covered automatically (common for new spawnable mobs).

2. **(Optional) Warm the Divine Pride oracle** for the unused jobID pool (helps the agents on the tail).
   It is rate-limited (~stalls after ~2.8k ids) and resumable, so run it in the background and don't block on full completion:
   ```
   node tools/mobnames/dp.mjs
   ```

3. **Prepare agent tasks**:
   ```
   node tools/mobnames/prepare-agents.mjs
   ```
   Note the band count from its output (`agent-tasks/band1.txt … bandN.txt`, shared `agent-tasks/pool.txt`).

4. **Spawn one `general-purpose` agent per band** (in parallel, background). Give each this prompt, with
   `<N>` replaced by the band number:

   > Match Ragnarok monster name rows to jobIDs. Read `tools/mobnames/agent-tasks/band<N>.txt` (rows:
   > `strId | EN="…" | PT="…" | ES="…" | hint:[jobID:AEGIS, …]`) and the candidate pool
   > `tools/mobnames/agent-tasks/pool.txt` (`jobID N aegis=X dp="…"` — UNUSED jobIDs; `dp` is the Divine
   > Pride English name when known). For each row pick the best jobID from the pool by **aegis semantics +
   > dp name**, using variant rules (`_H`=hard, `_2`/`_3`=duplicates, `G_`/`MD_`/`EP18_`/`4JOB_` keep the
   > base monster's name; homunculi Lif/Amistr/Filir/Vanilmirth → `MER_*`). Same-name rows map to
   > consecutive same-base jobIDs in ascending order. Never assign one jobID to two rows. If nothing fits,
   > jobID=null. You MAY query Divine Pride for a specific jobID when stuck (rate-limited, sparingly):
   > `cd <repo> && bash -c 'set -a; . ./.env; set +a; curl -s "https://www.divine-pride.net/api/database/Monster/JOBID?apiKey=$DIVINE_PRIDE_API_KEY"'`.
   > Write ONLY a JSON array to `tools/mobnames/agent-tasks/band<N>.answer.json`:
   > `[{"strId":int,"jobID":int|null,"confidence":"high"|"med"|"low","reason":"short"}]`. Print a 1-line summary.

   Wait for all bands to finish (you're notified on completion).

5. **Merge + audit**:
   ```
   node tools/mobnames/merge-agents.mjs
   node tools/mobnames/report.mjs
   ```
   `merge-agents` only fills still-unclaimed rows, refuses jobID reuse, and aborts on any navi conflict.
   `report` must end with `navi integrity broken: 0` and the ground-truth line at `9/9` (or note any regressions).

6. **Report the delta** to the user: how many rows newly resolved by each tier, the new coverage %, and how
   many remain unresolved (usually NPC names / nameless variants). Offer the `med`/`low` rows as a review
   list if they want to validate (see the earlier `gen_review` approach). Commit `mobs.json` only if asked.
