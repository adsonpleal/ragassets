#!/usr/bin/env node
// Multi-server visual extraction — one CLI over the stages.
//
//   node tools/multiserver/cli.mjs status
//   node tools/multiserver/cli.mjs index       [--origin all] [--limit N]
//   node tools/multiserver/cli.mjs catalogue   [--origin all] [--no-rgz-probe]
//   node tools/multiserver/cli.mjs renderable  [--origin latam] [--job N] [--limit N] [--kind acc|robe|both]
//   node tools/multiserver/cli.mjs shortlist   [--renderable <tsv>] [--app <json>]
//   node tools/multiserver/cli.mjs plan        [--origin all] [--tiers core]
//   node tools/multiserver/cli.mjs fetch       [--origin <id>] [--limit N]
//   node tools/multiserver/cli.mjs publishable [--out <dir>]
//   node tools/multiserver/cli.mjs icons       [--origin all] [--plan-only] [--limit N]
//   node tools/multiserver/cli.mjs icons       --from-plan [--out <dir>]
//   node tools/multiserver/cli.mjs assets      [--origin all] [--limit N] [--dry-run]
//
// --origin takes `all`, `foreign` (everything but LATAM) or a comma list of ids.
// --limit caps how many archives a run touches, which is how you smoke-test a
// stage without walking a whole patch history.
//
// Everything is resumable: stage 1 keeps a ledger, stage 2 and 4 reuse the
// archive cache, and the fetchers skip what is already mirrored. Interrupt any
// of them and run it again.
//
// Env: MULTISERVER_DIR (state root, default ~/ro-multiserver)
//      MULTISERVER_INTERVAL_MS (per-host politeness gap, default 1000)

import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ORIGINS, selectOrigins } from "./origins.mjs";
import { paths, readRows, writeRows } from "./store.mjs";
import { indexOrigin } from "./stage1-index.mjs";
import { catalogueOrigin, catalogueExists } from "./stage2-catalogue.mjs";
import { seedOrigin } from "./seed.mjs";
import { buildShortlist } from "./stage3-shortlist.mjs";
import { DEFAULT_BASE, probeRenderable } from "./renderprobe.mjs";
import { buildSlotIndex, readSlotIndex } from "./slotindex.mjs";
import { planFetch } from "./stage4-plan.mjs";
import { fetchPlan } from "./stage4-fetch.mjs";
import { catalogueFromDisk } from "./stage5-catalogue.mjs";
import { buildIconTree, catalogueCostumes, planIcons } from "./stage6-icons.mjs";
import { fetchAssets } from "./stage4-assets.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i < 0 ? dflt : argv[i + 1];
};
const has = (name) => argv.includes(name);

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function usage(code = 2) {
  console.error(
    [
      "usage: cli.mjs <status|index|catalogue|seed|renderable|shortlist|slots|plan|fetch|publishable|icons|assets> [options]",
      "",
      "  --origin all|foreign|<id,id>   default all",
      "  --limit N                      cap archives touched this run",
      "  --from <dir> [--force]         seed: where the *-accessories.tsv live",
      "  --oldest-first                 walk the index forward instead of newest-first",
      "  --include-pulled               also read patches the index marks // pulled",
      "  --job N                        renderable: class to render on (default 4054)",
      "  --kind acc|robe|both           renderable: which sprite table to probe (default both)",
      "                                 (--limit applies per table, so a sample covers both)",
      "  --base <url>                   renderable: which gateway to probe",
      "  --renderable <tsv>             stage 3: the LATAM render probe output",
      "  --app <json>                   stage 3: the app's own costume catalogue",
      "  --dry-run                      stage 4: resolve archives, download nothing",
      "  --tiers core|core,effect       plan: costumes only, or their auras too",
      "  --no-slot-order                plan: keep patch order instead of slot order",
      "  --force                        fetch: re-read files already mirrored",
      "  --out <dir>                    publishable: also write the catalogue there",
      "                                 icons: where the PNG tree goes",
      "  --plan-only                    icons: write icons-plan.tsv, fetch nothing",
      "  --from-plan                    icons: fetch an existing plan; no index needed",
      "",
      `  origins: ${Object.keys(ORIGINS).join(", ")}`,
      `  state:   ${paths.root}`,
    ].join("\n"),
  );
  process.exit(code);
}

async function cmdStatus() {
  console.log(`state root: ${paths.root}\n`);
  const head = ["origin", "archives", "ok", "blocked", "rgz", "err", "paths", "catalogue"].join("\t");
  console.log(head);
  for (const o of Object.values(ORIGINS)) {
    const ledger = readRows(paths.archives(o.id));
    const count = (s) => ledger.filter((r) => r.status === s).length;
    let pathLines = 0;
    const pf = paths.pathsFile(o.id);
    if (existsSync(pf)) pathLines = statSync(pf).size;
    const cat = join(paths.catalogDir(o.id), "views.tsv");
    const catViews = existsSync(cat) ? readRows(cat).length : 0;
    console.log(
      [
        o.id,
        ledger.length,
        count("ok"),
        count("blocked"),
        count("rgz"),
        count("error"),
        pathLines ? mb(pathLines) : "-",
        catViews ? `${catViews} views` : "-",
      ].join("\t"),
    );
  }
  const sl = paths.shortlist();
  if (existsSync(sl)) console.log(`\nshortlist: ${readRows(sl).length} rows (${sl})`);
}

async function cmdIndex() {
  const origins = selectOrigins(flag("--origin", "all"));
  const limit = Number(flag("--limit", 0)) || Infinity;
  for (const o of origins) {
    console.error(`\n=== ${o.label} (${o.id})`);
    console.error(`    index ${o.index}`);
    let lastLog = 0;
    const stats = await indexOrigin(o, {
      limit,
      newestFirst: !has("--oldest-first"),
      includePulled: has("--include-pulled"),
      onProgress: (s, entry, info) => {
        if (info.error) console.error(`    ! ${entry.seq} ${entry.file}: ${info.error}`);
        else if (info.status === "blocked") console.error(`    - ${entry.seq} ${entry.file}: blocked`);
        if (s.scanned - lastLog >= 25) {
          lastLog = s.scanned;
          console.error(
            `    … ${s.scanned} scanned, ${s.entries} paths, ${mb(s.tableBytes)} read, ` +
              `${s.blocked} blocked, ${s.errors} errors`,
          );
        }
      },
    });
    console.error(
      `    done: ${stats.inIndex} in index, ${stats.known} already known, ${stats.scanned} scanned ` +
        `(${stats.indexed} ok, ${stats.blocked} blocked, ${stats.rgz} rgz, ${stats.errors} errors), ` +
        `${stats.entries} paths, ${mb(stats.tableBytes)} of tables read`,
    );
  }
}

async function cmdCatalogue() {
  const origins = selectOrigins(flag("--origin", "all"));
  for (const o of origins) {
    console.error(`\n=== ${o.label} (${o.id})`);
    try {
      const r = await catalogueOrigin(o, {
        probeRgz: !has("--no-rgz-probe"),
        rgzLimit: Number(flag("--rgz-limit", 12)),
        onProgress: (p) => {
          if (p.rgz) {
            const z = p.rgz;
            if (z.why) {
              console.error(`    probing .rgz — ${z.why}`);
              return;
            }
            console.error(
              z.error
                ? `    rgz ${z.archive}: ${z.error}`
                : `    rgz ${z.archive} (${mb(z.bytes)}, ${z.files} file(s))${z.hit ? " <- HIT" : ""}`,
            );
            return;
          }
          console.error(
            `    ${p.cached ? "cached" : "fetched"} ${p.archive} (${mb(p.bytes)}) for ${p.keys.join(", ")}`,
          );
        },
      });
      for (const l of r.located) {
        const why = l.blocked
          ? " — BLOCKED, nothing readable for this table"
          : l.newerBlocked
            ? ` — newer copy skipped: ${l.newerBlocked} is blocked`
            : "";
        console.error(`    seq ${l.seq}  ${l.key} <- ${l.archive}${why}`);
      }
      console.error(
        `    views: ${r.views.count}` +
          (r.views.count
            ? ` (sprite ${r.views.withSprite}, blank ${r.views.blank}, missing ${r.views.missingName})`
            : ` — ${r.views.note}`),
      );
      console.error(
        `    items: ${r.items.resources} resources, ${r.items.names} display names` +
          ` (${r.items.source}` +
          (r.items.iteminfo ? `, ${r.items.iteminfo.withView} with a view id` : "") +
          (r.items.legacy.filledGaps ? `, +${r.items.legacy.filledGaps} from .txt` : "") +
          ")",
      );
      console.error(
        `    robes: ${r.robes.count}` + (r.robes.count ? "" : ` — ${r.robes.note}`),
      );
      for (const [kind, j] of Object.entries(r.join)) {
        console.error(
          `    join ${kind.padEnd(4)} ${j.withItem}/${j.views} views matched an item, ${j.withName} got a name`,
        );
      }
      const c = r.classNum;
      console.error(
        `    ClassNum cross-check: ${c.agree} agree, ${c.disagree} disagree, ` +
          `${c.noClassNum} item(s) carried none, ${c.unplaced} had one but fit neither namespace`,
      );
    } catch (err) {
      console.error(`    ! ${err.message}`);
    }
  }
}

async function cmdSeed() {
  const origins = selectOrigins(flag("--origin", "all"));
  const dir = flag("--from", "docs/data");
  for (const o of origins) {
    if (catalogueExists(o.id) && !has("--force")) {
      console.error(`${o.id}: already catalogued (use --force to replace)`);
      continue;
    }
    const r = seedOrigin(o.id, join(dir, `${o.id}-accessories.tsv`));
    console.error(r ? `${o.id}: seeded ${r.views} views from ${r.from}` : `${o.id}: nothing to seed`);
  }
}

// Produces the file stage 3 reads next. It lived in the app repo until
// 2026-11-20, which meant that re-running it after a resolver rebake -- a
// ragassets maintenance operation -- needed a checkout of the consumer.
async function cmdRenderable() {
  const originId = flag("--origin", "latam");
  // Both namespaces, because they are both things the resolver either knows or
  // does not. Driving only `headgear=` left every garment view unprobed and
  // stage 3 with no opinion about any of them — see renderprobe.mjs.
  const want = flag("--kind", "both");
  const TABLES = { acc: "views.tsv", robe: "robes.tsv" };
  const kinds = want === "both" ? Object.keys(TABLES) : [want];
  for (const k of kinds) {
    if (!TABLES[k]) throw new Error(`unknown --kind ${k} — one of acc, robe, both`);
  }
  const limit = Number(flag("--limit", 0)) || Infinity;
  const views = [];
  for (const kind of kinds) {
    const file = join(paths.catalogDir(originId), TABLES[kind]);
    if (!existsSync(file)) {
      throw new Error(
        `no ${TABLES[kind]} for ${originId} at ${file} — run: cli.mjs catalogue --origin ${originId}`,
      );
    }
    views.push(
      ...readRows(file)
        .filter((r) => Number.isInteger(Number(r.view)))
        .slice(0, limit)
        .map((r) => ({ kind, view: Number(r.view), sprite: r.sprite })),
    );
  }
  const base = flag("--base", DEFAULT_BASE);
  const job = Number(flag("--job", 4054));
  console.error(`${views.length} view(s) de ${originId} (${kinds.join(", ")}) contra ${base}, job ${job}`);
  const r = await probeRenderable(views, { base, job, log: (m) => console.error(m) });
  writeRows(
    paths.renderProbe(),
    ["kind", "view", "sprite", "result", "pose", "bytes"],
    r.rows.map((x) => [x.kind, x.view, x.sprite, x.result, x.pose, x.bytes]),
  );
  console.error(
    `${r.counts.drew} desenham, ${r.counts.blank} em branco, ${r.counts.error} com erro ` +
      `(${views.length + r.extra} renderizações, até ${r.poses} poses por view)`,
  );
  for (const kind of kinds) {
    const k = r.byKind[kind];
    console.error(`    ${kind}: ${k.drew} desenham, ${k.blank} em branco, ${k.error} com erro`);
  }
  // The share is what is worth watching across resolver rebakes: it only moves
  // when the resolver's own table changes.
  const decided = r.counts.drew + r.counts.blank;
  if (decided) {
    console.error(`    renderizáveis: ${((r.counts.drew / decided) * 100).toFixed(1)}%`);
  }
  console.error(`    sonda: ${paths.renderProbe()}`);
}

async function cmdShortlist() {
  const r = buildShortlist({
    renderable: flag("--renderable", paths.renderProbe()),
    app: flag("--app", paths.appCostumes()),
  });
  // Both inputs describe the consumer, not this client, so a run without them
  // marks every view as needed — which is a believable-looking file and wrong.
  for (const what of r.missingInputs) {
    console.error(`! no ${what} — every view will read as needed; see paths.appDir()`);
  }
  console.error(
    `catalogued origins: ${r.origins.join(", ")}\n` +
      `union: ${r.unionViews} view ids (${r.kinds.acc} headgear, ${r.kinds.robe} garment)\n` +
      `in the app: ${r.inApp}\n` +
      `LATAM renders (probed): ${r.latamDraws}\n` +
      `need: ${r.need} — ${r.needByKind.acc} headgear, ${r.needByKind.robe} garment (named: ${r.named})\n` +
      `shortlist: ${r.rows} rows -> ${paths.shortlist()}`,
  );
  console.error(
    `  of the ${r.need} needed: ${r.needCostume.named} named, ` +
      `${r.needCostume.yes} flagged costume, ${r.needCostume.no} ordinary equipment, ` +
      `${r.needCostume.unknown} no flag shipped; ` +
      `${r.needCostume.aegis} have an English AegisName, ${r.needCostume.nothing} have no string at all`,
  );
  for (const [status, n] of r.byStatus) console.error(`  ${status}: ${n}`);
  for (const line of r.bands) console.error(`  ${line}`);
}

async function cmdSlots() {
  const origins = selectOrigins(flag("--origin", "all"));
  const r = buildSlotIndex(origins.map((o) => o.id));
  console.error(
    `${r.views} (kind,view) com slot, de ${r.withEquip} itens com posição ` +
      `em ${r.items} itens lidos`,
  );
  console.error(`    fontes: ${r.sources.join(", ")}`);
  console.error(`    por slot: ${JSON.stringify(r.perSlot)}`);
  // A view named by two clients that disagree on its slot is worth seeing, not
  // resolving quietly: it means one of the two tables is stale.
  if (r.conflicts) console.error(`    ${r.conflicts} discordância(s) entre itens`);
  // Items whose position names one sprite table while the art sits in the
  // other — the `viewKind` case, from this side of the join. See `tableFor`.
  if (r.retabled) console.error(`    ${r.retabled} item(ns) com arte na outra tabela`);
  console.error(`    índice: ${paths.slots()}`);
}

async function cmdPlan() {
  const origins = selectOrigins(flag("--origin", "all"));
  const tiers = flag("--tiers", "core,effect").split(",");
  const r = await planFetch({
    origins,
    tiers,
    slotOf: has("--no-slot-order") ? null : readSlotIndex(),
    includeEquipment: has("--include-equipment"),
    onProgress: (p) => console.error(`    ${p.msg}`),
  });
  console.error(
    `\n${r.covered}/${r.wanted} views coberta(s) por ${r.archives} patch(es), ` +
      `${r.files} arquivo(s), ${mb(r.bytes)} descomprimidos`,
  );
  // The per-tier split is the decision: the auras are real content but an order
  // of magnitude more bytes than the costumes they sit on.
  for (const [tier, bytes] of Object.entries(r.perTier).sort((a, b) => b[1] - a[1])) {
    console.error(`    ${tier.padEnd(7)} ${mb(bytes)}`);
  }
  if (r.perSlot) {
    const bySlot = Object.entries(r.perSlot)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${mb(v)}`)
      .join(", ");
    console.error(`    por slot: ${bySlot}`);
  }
  console.error(`    patches por origem: ${JSON.stringify(r.perOrigin)}`);
  if (r.unreachable) {
    console.error(
      `    ${r.unreachable} view(s) em patch nenhum — só no data.grf do instalador`,
    );
  }
  console.error(`    plano: ${paths.plan()}`);
}

async function cmdFetch() {
  const origin = flag("--origin", "");
  const r = await fetchPlan({
    origin: origin && origin !== "all" ? origin : undefined,
    limit: Number(flag("--limit", 0)) || Infinity,
    dryRun: has("--dry-run"),
    force: has("--force"),
    onProgress: (p) => console.error(`    ${p.msg}`),
  });
  console.error(
    `
${r.written} arquivo(s) escrito(s) de ${r.archives} patch(es) em ` +
      `${r.requests} requisição(ões), ${mb(r.bytes)} transferidos`,
  );
  if (r.skipped) console.error(`    ${r.skipped} já estavam no espelho`);
  if (r.missing) console.error(`    ${r.missing} não estavam na tabela do patch`);
  if (r.blocked) console.error(`    ${r.blocked} patch(es) bloqueado(s) (v0x300)`);
  if (r.failed) console.error(`    ${r.failed} arquivo(s) que não deu para escrever`);
  // Each origin mirrors into its own tree, so name the root rather than
  // inventing a single directory the run may not have written to.
  console.error(`    espelho: ${join(paths.root, "mirror")}`);
}

async function cmdPublishable() {
  // --no-local drops the costumes our own instance already draws, which need no
  // mirror. It is for auditing the difference against an older catalogue, not
  // for a normal run.
  const { doc, stats } = catalogueFromDisk({ includeLocal: !has("--no-local") });
  const written = [paths.catalogue()];
  // --out is how the catalogue gets published: point it at the gateway's raw
  // store (RAW_DIR, resources/raw on the box) and it is served at
  // /raw/foreign-costumes.json like any other prebuilt table, with no gateway
  // change at all. Without it the file stays in the state root.
  const out = flag("--out", "");
  if (out) written.push(join(out, "foreign-costumes.json"));
  for (const file of written) writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.error(
    `${stats.total} fantasia(s) no catálogo, ${stats.named} nomeada(s), ` +
      `${stats.withAegis} com identificador inglês`,
  );
  // The two sources, said apart: what the mirror holds, and what our own
  // instance already draws and nobody had published.
  console.error(
    `    ${stats.total - stats.local} do espelho, ${stats.local} da nossa própria árvore ` +
      `(${stats.localPublishable} dessas com flag de fantasia, nome e posição)`,
  );
  console.error(
    `    ${stats.withNames} com nomes por cliente: ${JSON.stringify(stats.namesPerOrigin)}`,
  );
  console.error(
    `    ${stats.withIds} com id real de item: ${JSON.stringify(stats.idsPerOrigin)}`,
  );
  console.error(
    `    ids entre clientes: ${stats.idsAgree} concordam, ${stats.idsDisagree} divergem`,
  );
  console.error(`    por origem: ${JSON.stringify(stats.perOrigin)}`);
  console.error(`    por slot:   ${JSON.stringify(stats.perSlot)}`);
  // An incomplete costume is left out on purpose: it would be a 404 with a name.
  if (stats.skipped.incomplete) {
    console.error(`    ${stats.skipped.incomplete} fora por arquivo faltando`);
  }
  if (stats.skipped.unknownToShortlist) {
    console.error(
      `    ${stats.skipped.unknownToShortlist} fora por não estar na shortlist ` +
        `(plano e shortlist de corridas diferentes?)`,
    );
  }
  if (stats.blank) console.error(`    ${stats.blank} marcada(s) como em branco (blank-visuals.json)`);
  for (const file of written) console.error(`    catálogo: ${file}`);
}

async function cmdIcons() {
  // Planning and fetching need very different things, and splitting them is
  // what makes this store reproducible somewhere other than the machine that
  // planned it. The scan reads every origin's path index — hundreds of MB of
  // ledgers, built over days — plus the published catalogue. The fetch reads
  // `icons-plan.tsv` and the public patch servers, and nothing else. So the
  // origin box, which has neither the index nor the catalogue, can still
  // rebuild the whole tree from a 150 KB plan file: copy it in, --from-plan.
  if (has("--from-plan")) {
    if (!existsSync(paths.iconPlan())) {
      throw new Error(
        `--from-plan: no plan at ${paths.iconPlan()} — copy one in, or drop the flag to scan for one`,
      );
    }
    const rows = readRows(paths.iconPlan());
    const archives = new Set(rows.map((r) => `${r.origin}|${r.archive}`));
    console.error(
      `\nplano existente: ${rows.length} ícone(s) em ${archives.size} patch(es), sem replanejar`,
    );
    console.error(`    plano: ${paths.iconPlan()}`);
  } else {
    const origins = selectOrigins(flag("--origin", "all"));
    const costumes = catalogueCostumes();
    const plan = await planIcons({
      origins,
      costumes,
      onProgress: (p) => console.error(`    ${p.msg}`),
    });
    console.error(
      `
${plan.covered}/${plan.wanted} ícone(s) em ${plan.archives} patch(es), ` +
        `${mb(plan.bytes)} descomprimidos`,
    );
    console.error(`    patches por origem: ${JSON.stringify(plan.perOrigin)}`);
    // A sprite no client ships an icon for is a 404 on purpose: the consumer
    // falls back to a rendered thumbnail, which is the costume rather than a
    // placeholder claiming to be it.
    if (plan.missing.length) {
      console.error(`    ${plan.missing.length} sem ícone em nenhum cliente (404 de propósito)`);
    }
    console.error(`    plano: ${paths.iconPlan()}`);
  }
  if (has("--plan-only")) return;

  const fetched = await fetchPlan({
    file: paths.iconPlan(),
    limit: Number(flag("--limit", 0)) || Infinity,
    force: has("--force"),
    onProgress: (p) => console.error(`    ${p.msg}`),
  });
  console.error(
    `
${fetched.written} BMP(s) de ${fetched.archives} patch(es) em ` +
      `${fetched.requests} requisição(ões), ${mb(fetched.bytes)} transferidos` +
      (fetched.skipped ? `, ${fetched.skipped} já no espelho` : ""),
  );

  const out = flag("--out", paths.iconsDir());
  const tree = buildIconTree({ out });
  console.error(
    `${tree.sprites} sprite(s) com ícone: ${JSON.stringify(tree.counts)}`,
  );
  console.error(`    por origem: ${JSON.stringify(tree.perOrigin)}`);
  if (tree.fails.absent) console.error(`    ${tree.fails.absent} planejado(s) e ainda fora do espelho`);
  if (tree.fails.convert) console.error(`    ${tree.fails.convert} BMP(s) que não deu para converter`);
  console.error(`    ícones: ${tree.out}`);
}

async function cmdAssets() {
  const origins = selectOrigins(flag("--origin", "foreign"));
  const limit = Number(flag("--limit", 0)) || Infinity;
  for (const o of origins) {
    console.error(`\n=== ${o.label} (${o.id})`);
    const r = await fetchAssets(o, {
      limit,
      dryRun: has("--dry-run"),
      includeEquipment: has("--include-equipment"),
      onProgress: (p) => console.error(`    ${p.msg}`),
    });
    console.error(
      `    ${r.wanted} sprites wanted, ${r.resolved} resolved in ${r.archives} archive(s), ` +
        `${r.downloaded} downloaded (${mb(r.bytes)}), ${r.extracted} file(s) written, ` +
        `${r.unresolved} not found in the index`,
    );
  }
}

const commands = {
  status: cmdStatus,
  index: cmdIndex,
  catalogue: cmdCatalogue,
  seed: cmdSeed,
  renderable: cmdRenderable,
  shortlist: cmdShortlist,
  slots: cmdSlots,
  plan: cmdPlan,
  fetch: cmdFetch,
  publishable: cmdPublishable,
  icons: cmdIcons,
  assets: cmdAssets,
};

if (!cmd || !commands[cmd] || has("--help") || has("-h")) usage(cmd ? 0 : 2);
await commands[cmd]();
