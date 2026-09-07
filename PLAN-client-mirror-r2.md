# Plan: move the client mirror to R2 so patches can rebuild the derived stores

> **This file is a work order, not documentation. Delete it in the final commit —
> see step 7.** Nothing here should survive into the repository's permanent docs;
> anything worth keeping belongs in `README.md` or in a comment next to the code
> it explains.

## Why

`update-assets.yml` today extracts a patch run on a GitHub runner and uploads only
four paths: `data/sprite`, `data/palette`, `data/imf`, `data/texture/effect`. The
workflow says plainly why it stops there:

> *the DERIVED stores — icons, illust, raw, maps, bgm, sounds — are not rebuilt
> here: they need a merged view of the whole client (see `openTree` in
> `extract-grf.mjs`) […] Until the client mirror exists, a patch that adds an item
> updates its sprite here but not its icon.*

That is a correctness gap, not a nicety: a patch that adds an item ships its sprite
and leaves `/icon` returning 404 for it until someone re-extracts by hand.

The blocker was never the runner's CPU or RAM — it was that a runner is stateless
and a merged client is ~9 GB. **Put the merged client in R2 and the blocker is
gone.** The runner pulls it, applies the new patches onto it, rebuilds everything
including the derived stores, and pushes it back.

`extract-grf.mjs` already supports this: `--grf` accepts *a directory laid out by
path* as well as an archive, and the README records that `--effects` was run both
ways over the real client with byte-identical output across 3,100 files.

## What exists today

The production box holds a complete merged client, built up over time by hand:

```
ubuntu@ec2-18-231-251-11.sa-east-1.compute.amazonaws.com
key: C:\Users\adson\.ssh\Adson-new.pem
```

```
~/ragassets/resources          16 GB total
  data/                         9.1 GB   ← the merged client tree; THIS is the mirror
  maps/                         5.9 GB   ┐
  bgm/                          325 MB   │
  icons/                        235 MB   ├ derived — rebuilt from data/, not stored
  sounds/                       195 MB   │
  illust/                       110 MB   │
  effects/                       53 MB   │
  raw/                           13 MB   ┘
```

Only `data/` needs to live in R2. Everything else is output.

## Design

```
R2 ragassets/mirror/client-<epoch>.tar.zst   the merged client tree (~9 GB)
R2 ragassets/mirror/current                  text file: the tarball name in use

runner:
  1. free disk (see step 3)
  2. pull mirror/current -> pull that tarball -> extract to ./client-mirror
  3. apply-patches.mjs --out patchfiles --from-seq N
  4. overlay patchfiles onto client-mirror   (patches carry whole files)
  5. extract-grf.mjs --icons/--illust/--effects/--maps/--bgm/--sounds/--raw
     --grf client-mirror
  6. rclone the servable + derived output to r2:ragassets
  7. re-tar client-mirror, upload as a NEW name, then flip mirror/current
```

Flipping `current` **after** the new tarball is fully uploaded is the commit point.
A run that dies midway leaves an orphan tarball and the previous `current` intact.
Keep the last 3 tarballs; prune older ones at the end of a successful run. At
$0.015/GB-month that is roughly $0.40 for the safety net.

## Steps

### 1. Seed the mirror from the box (one-time, manual)

Do this before touching the workflow. `data/` is the merged client; nothing else
goes in.

```bash
ssh -i "C:\Users\adson\.ssh\Adson-new.pem" ubuntu@ec2-18-231-251-11.sa-east-1.compute.amazonaws.com
cd ~/ragassets/resources
nice -n 10 tar -I 'zstd -3 -T2' -cf ~/client-mirror.tar.zst data
ls -lh ~/client-mirror.tar.zst
```

Be polite on that box — it is shared, has 1.9 GB of RAM, and is running the
gateway plus three other services. `nice` and a low zstd level are not optional.

Upload with the same rclone remote the workflow already defines (`r2:`), naming it
by epoch, then write `current`:

```bash
rclone copyto ~/client-mirror.tar.zst r2:ragassets/mirror/client-<epoch>.tar.zst --s3-no-check-bucket
printf 'client-<epoch>.tar.zst' | rclone rcat r2:ragassets/mirror/current --s3-no-check-bucket
rm ~/client-mirror.tar.zst
```

### 2. Verify the mirror is usable before wiring it into CI

Pull it somewhere with disk, extract, and run one derived mode against it. If this
does not produce the same icons as production, stop — the mirror is wrong and
nothing downstream matters.

```bash
node extract-grf.mjs --icons /tmp/icons-check --grf ./client-mirror
```

Compare a sample against `~/ragassets/resources/icons`. They should be identical.

### 3. Give the runner enough disk

Peak usage is roughly: 8 GB tarball + 9 GB extracted mirror + 7 GB derived output
≈ **24 GB**. Runners have 72 GB total but only ~19–22 GB free by default (GitHub
guarantees 14 GB), so the job must reclaim space first:

```yaml
- uses: jlumbroso/free-disk-space@main
  with:
    tool-cache: true
    android: true
    dotnet: true
    haskell: true
    large-packages: false   # slow, and not needed to clear enough
```

That returns ~31 GB in about 3 minutes, leaving ~63 GB. Delete the tarball right
after extracting it to claw back another 8 GB.

### 4. Rework `update-assets.yml`

Keep everything that already works — the `repository_dispatch` trigger, the
`from_seq` resolution, the dry-run input, the `WRANGLER_ENV` resolution, the R2
env block, the epoch stamping, the manifest rebuild. The change is confined to
what happens between "resolve the sequence" and "upload".

- Add the disk-freeing step first.
- Pull and extract the mirror.
- Keep `apply-patches.mjs --out patchfiles --from-seq …` exactly as it is.
- Overlay `patchfiles/` onto `client-mirror/` (patches carry whole files, so a
  plain recursive copy with overwrite is the correct semantics — this is the same
  reasoning the existing "Download and unpack" step comment already records).
- Run the derived modes against `client-mirror`. Start with `--icons`, `--illust`
  and `--effects`; add `--maps`, `--bgm`, `--sounds`, `--raw` once the first three
  are proven, because `maps` alone is 5.9 GB and will dominate the runtime.
- Upload the servable paths as today, plus the derived stores.
- Re-tar and flip `current` as the last step, and only on success.

`--dry-run` must still upload nothing and must not flip `current`.

Note `MAX_PATCHES = 60` in `tools/apply-patches.mjs`. At roughly 1.5 patches/day
and a fortnightly cadence a run applies ~21, so the guard is fine — but a long gap
or a burst at a maintenance could exceed it. If that happens the fix is `--max`,
not raising the constant, so the guard keeps meaning something.

### 5. Prove it on a real patch run

Trigger `workflow_dispatch` with `dry_run: true` and a `from_seq` a few sequences
behind the head. Confirm from the log that:

- the mirror extracted and the patch overlay touched the files you expect;
- the derived modes produced a plausible file count (compare against the counts in
  `~/ragassets/resources/icons` etc. on the box);
- nothing was uploaded and `current` did not move.

Then run it for real and check that `/icon` resolves for an item added by that
patch — that item is the whole point of the exercise.

### 6. Optional: find out whether the mirror is needed at all

Rebuild a client tree from patches only (`apply-patches.mjs` from seq 1 into an
empty directory) and diff it against `resources/data` from the box. That tells you
exactly which files exist *solely* in the base client and never appear in the patch
chain — the sibling `latam-database-extractor` documents that such files exist
(`admin/pcidentity.lub` among them), but not whether any of them are things this
project serves.

If none of the missing files are ones ragassets serves, the R2 mirror can be
dropped entirely and the job becomes pure stateless compute at exactly $0. Worth
knowing; not worth blocking on.

### 7. Delete this file

Delete `PLAN-client-mirror-r2.md` in the final commit. If something in it turned
out to be load-bearing knowledge, move that sentence into `README.md` or into a
comment beside the code first — this repo's habit is to explain *why* next to the
thing, and that habit is worth more than a plan file nobody will reread.

## Costs and constraints

- Runner compute stays **$0** — this is a public repository.
- R2 holds ~9 GB plus two older generations: **~$0.20–0.40/month**. R2 egress is
  free, so pulling the mirror on every run costs nothing.
- Job time will grow by roughly 15–25 minutes for the mirror round-trip. The job
  limit is 6 hours; `--maps` is the only step likely to be slow.
- Do not add `pull_request` to the triggers. The existing comment says why: this
  repo is public and the job holds R2 and Cloudflare credentials.
