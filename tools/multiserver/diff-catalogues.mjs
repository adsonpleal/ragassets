// Diff two clients' catalogues: are view ids portable between servers, and are
// sprite names?
//
// These are the two questions that decided the whole design, and they are worth
// being able to re-ask rather than trusting the answer recorded once:
//
//   1. Is a view id portable?  -> how many ids both clients define but with a
//      DIFFERENT sprite name. Any at all means `/image` cannot take a bare view
//      id from another server, which is why the catalogue publishes
//      `<view>:<sprite>` and the renderer is told the name.
//   2. Is a sprite name portable? -> how many names both define at a different
//      view id (harmless, and what makes the name the better key), and how many
//      are genuinely new on the other side.
//
// It also reports names used by more than one view id *within* one client,
// because that is the case where "key by name" would itself be ambiguous.
//
// Adopted from the app repo's tools/explore/, where it read loose three-column
// TSVs with no header. Here it reads this pipeline's own
// catalog/<origin>/{views,robes}.tsv through store.mjs, so the usual form takes
// two origin ids and no paths:
//
//   node tools/multiserver/diff-catalogues.mjs latam twro [--kind robe] [--list]
//   node tools/multiserver/diff-catalogues.mjs a.tsv b.tsv --label-a X --label-b Y
//
// Headgear and garment view ids are different numbers in different namespaces
// (LATAM's view 8 is a surgical mask as a headgear and Rudra's wings as a
// garment), so one run compares one namespace. --kind picks it.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ORIGINS } from "./origins.mjs";
import { paths, readRows } from "./store.mjs";

const FILES = { acc: "views.tsv", robe: "robes.tsv" };

/** An origin id, or a path to a TSV. Origin ids win: there is no `latam.tsv`. */
export function resolveSide(ref, kind = "acc") {
  if (ORIGINS[ref]) {
    const file = join(paths.catalogDir(ref), FILES[kind]);
    return { label: ORIGINS[ref].label, file };
  }
  return { label: ref, file: ref };
}

/**
 * Index one side's rows by view id and by sprite name — the two indexes the
 * comparison needs.
 *
 * Rows come from `readRows`, which is header-aware; the app-repo original split
 * lines positionally, and this pipeline writes `view sprite accessoryKey` (or
 * `view sprite spriteEng robeKey`) *with* a header line, which that would have
 * read as a row whose view id is NaN.
 */
export function indexRows(rows) {
  const byView = new Map();
  const byName = new Map();
  for (const r of rows) {
    const view = Number(r.view);
    if (!Number.isInteger(view)) continue;
    // robes.tsv carries the Korean name and an English one; either identifies
    // the sprite, and the Korean column is the one views.tsv also uses.
    const sprite = r.sprite || r.spriteEng || "";
    const row = { view, sprite, key: r.accessoryKey ?? r.robeKey ?? "" };
    byView.set(view, row);
    if (sprite) {
      if (!byName.has(sprite)) byName.set(sprite, []);
      byName.get(sprite).push(row);
    }
  }
  return { byView, byName };
}

export const loadSide = (file) => indexRows(readRows(file));

/** The whole comparison, as data — no printing, so it can be asserted on. */
export function diffCatalogues(a, b) {
  const sharedViews = [...a.byView.keys()].filter((v) => b.byView.has(v));
  // A view id one side defines with no sprite name at all is NOT a
  // disagreement about which sprite it is, and counting it as one is a bug the
  // app-repo original had: LATAM vs jRO came out at 3 accessory conflicts where
  // this repo has always recorded 2, and the third is view 880, which LATAM
  // calls `_1` and jRO's table leaves blank. Both facts are worth reporting;
  // they are not the same fact.
  const named = (v, side) => Boolean(side.byView.get(v).sprite);
  const bothNamed = sharedViews.filter((v) => named(v, a) && named(v, b));
  const viewConflicts = bothNamed.filter((v) => a.byView.get(v).sprite !== b.byView.get(v).sprite);
  const viewUnnamedOneSide = sharedViews.filter((v) => named(v, a) !== named(v, b));

  const sharedNames = [...a.byName.keys()].filter((n) => b.byName.has(n));
  const movedNames = sharedNames.filter((n) => a.byName.get(n)[0].view !== b.byName.get(n)[0].view);
  const onlyA = [...a.byName.keys()].filter((n) => !b.byName.has(n));
  const onlyB = [...b.byName.keys()].filter((n) => !a.byName.has(n));

  const dupes = (c) => [...c.byName.entries()].filter(([, rows]) => rows.length > 1);

  return {
    sizes: {
      a: { views: a.byView.size, names: a.byName.size },
      b: { views: b.byView.size, names: b.byName.size },
    },
    sharedViews,
    bothNamed,
    viewConflicts,
    viewUnnamedOneSide,
    sharedNames,
    movedNames,
    onlyA,
    onlyB,
    dupesA: dupes(a),
    dupesB: dupes(b),
  };
}

function report(d, a, b, A, B, list) {
  console.log(`${A}: ${d.sizes.a.views} view ids, ${d.sizes.a.names} distinct sprite names`);
  console.log(`${B}: ${d.sizes.b.views} view ids, ${d.sizes.b.names} distinct sprite names`);
  console.log("");

  console.log(`view ids defined by both: ${d.sharedViews.length}`);
  console.log(`  both name a sprite: ${d.bothNamed.length}`);
  console.log(`    same sprite name: ${d.bothNamed.length - d.viewConflicts.length}`);
  console.log(`    DIFFERENT sprite name: ${d.viewConflicts.length}`);
  console.log(`  only one side names one: ${d.viewUnnamedOneSide.length}`);
  if (d.viewConflicts.length && list) {
    for (const v of d.viewConflicts.slice(0, 40)) {
      console.log(`    ${v}: ${A}=${a.byView.get(v).sprite}   ${B}=${b.byView.get(v).sprite}`);
    }
    if (d.viewConflicts.length > 40) console.log(`    … ${d.viewConflicts.length - 40} more`);
  }
  if (d.viewUnnamedOneSide.length && list) {
    for (const v of d.viewUnnamedOneSide.slice(0, 20)) {
      const x = a.byView.get(v).sprite;
      console.log(`    ${v}: named only by ${x ? A : B} (${x || b.byView.get(v).sprite})`);
    }
  }
  console.log("");

  console.log(`sprite names in both: ${d.sharedNames.length}`);
  console.log(`  at the same view id: ${d.sharedNames.length - d.movedNames.length}`);
  console.log(`  at a different view id: ${d.movedNames.length}`);
  console.log(`only in ${A}: ${d.onlyA.length}`);
  console.log(`only in ${B}: ${d.onlyB.length}`);
  if (d.movedNames.length && list) {
    console.log(`  moved examples:`);
    for (const n of d.movedNames.slice(0, 20)) {
      console.log(`    ${n}: ${A}=${a.byName.get(n)[0].view} ${B}=${b.byName.get(n)[0].view}`);
    }
  }
  console.log("");
  if (list) {
    console.log(`--- only in ${B} (${d.onlyB.length}) ---`);
    for (const n of [...d.onlyB].sort()) console.log(`  ${b.byName.get(n)[0].view}\t${n}`);
    console.log(`--- only in ${A} (${d.onlyA.length}) ---`);
    for (const n of [...d.onlyA].sort()) console.log(`  ${a.byName.get(n)[0].view}\t${n}`);
  }

  for (const [label, dupes] of [[A, d.dupesA], [B, d.dupesB]]) {
    console.log(`${label}: ${dupes.length} sprite names used by more than one view id`);
    if (dupes.length && list) {
      for (const [n, rows] of dupes.slice(0, 15)) {
        console.log(`    ${n} -> ${rows.map((r) => r.view).join(", ")}`);
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (n, dflt) => {
    const i = argv.indexOf(n);
    return i < 0 ? dflt : argv[i + 1];
  };
  // Positionals are everything that is not a flag and not a flag's value.
  const VALUED = new Set(["--kind", "--label-a", "--label-b"]);
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (VALUED.has(argv[i])) i++;
      continue;
    }
    positional.push(argv[i]);
  }
  const [aRef, bRef] = positional;
  const kind = flag("--kind", "acc");
  if (!aRef || !bRef || !FILES[kind]) {
    console.error(
      [
        "usage: diff-catalogues.mjs <origin|a.tsv> <origin|b.tsv> [--kind acc|robe] [--list]",
        "       [--label-a X] [--label-b Y]",
        "",
        `  origins: ${Object.keys(ORIGINS).join(", ")}`,
        `  state:   ${paths.root}`,
      ].join("\n"),
    );
    process.exit(2);
  }
  const sideA = resolveSide(aRef, kind);
  const sideB = resolveSide(bRef, kind);
  for (const s of [sideA, sideB]) {
    if (!existsSync(s.file)) {
      console.error(`! no ${kind} catalogue at ${s.file} — run \`cli.mjs catalogue\` for it first`);
      process.exit(1);
    }
  }
  const A = flag("--label-a", sideA.label);
  const B = flag("--label-b", sideB.label);
  const a = loadSide(sideA.file);
  const b = loadSide(sideB.file);
  report(diffCatalogues(a, b), a, b, A, B, argv.includes("--list"));
}
