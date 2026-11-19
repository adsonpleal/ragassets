// Stage 3 — decide what is actually missing, before downloading one sprite.
//
// Joins every catalogued client against two facts about our own instance:
//
//   * what the consumer lists   (the app's costumes.json — 1,261 items / 1,192
//     views — copied under $MULTISERVER_DIR/app/, because it describes the app
//     and not this client)
//   * what LATAM actually draws (the render probe: a view id the resolver does
//     not know returns 200 with the bare body, so renderability can only be
//     decided by comparing bytes against a no-headgear baseline)
//
// Both are optional and both change the answer, so a run without them says so
// rather than reporting that every view in every client is missing.
//
// and writes one row per view id in the union, with a `need` column. Nothing is
// filtered out of the file: a stage that quietly drops rows is a stage you
// cannot audit. `need=yes` is the extraction target.
//
// Names come from whichever client has one, in a fixed preference order —
// English first, because a Brazilian player reads `Medium Wave Hair` better
// than 中波浪髮 or ミディアムウェーブ. The origin that supplied it is recorded, so
// the UI can say so.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ORIGINS } from "./origins.mjs";
import { paths, readRows, writeRows } from "./store.mjs";

// iRO is English, twRO Traditional Chinese, jRO Japanese, kRO Korean.
const NAME_ORDER = ["latam", "iro", "twro", "twrozero", "jro", "kro", "krozero"];

// Keys are "<kind>:<view>" throughout, because a headgear view id and a garment
// view id are different numbers in different namespaces: LATAM's view 8 is a
// surgical mask as a headgear and Rudra's wings as a garment.
export const keyOf = (kind, view) => `${kind}:${Number(view)}`;

function readCatalogue(originId) {
  const viewsFile = join(paths.catalogDir(originId), "views.tsv");
  const robesFile = join(paths.catalogDir(originId), "robes.tsv");
  if (!existsSync(viewsFile) && !existsSync(robesFile)) return null;
  const views = new Map();
  if (existsSync(viewsFile)) {
    for (const r of readRows(viewsFile)) views.set(keyOf("acc", r.view), r.sprite);
  }
  if (existsSync(robesFile)) {
    for (const r of readRows(robesFile)) views.set(keyOf("robe", r.view), r.sprite || r.spriteEng);
  }
  const names = new Map();
  // Every key that got an item, named or not: an item id with no display name is
  // still a handle on the costume, and the aegis table can name it in English.
  const items = new Map();
  const costumesFile = join(paths.catalogDir(originId), "costumes.tsv");
  if (existsSync(costumesFile)) {
    for (const r of readRows(costumesFile)) {
      const key = keyOf(r.kind || "acc", r.view);
      if (r.item && !items.has(key)) items.set(key, Number(r.item));
      // Catalogues written before the namespace split carry no `kind` column;
      // those rows are accessory rows.
      if (r.name) {
        names.set(keyOf(r.kind || "acc", r.view), {
          name: r.name,
          item: r.item,
          costume: r.costume ?? "",
        });
      }
    }
  }
  // item id -> AegisName, the English server-side identifier. Not a display
  // name, but the only English string available for a costume whose only name is
  // Chinese or Japanese, which is most of what the foreign clients contribute.
  const aegis = new Map();
  const aegisFile = join(paths.catalogDir(originId), "aegis.tsv");
  if (existsSync(aegisFile)) {
    for (const r of readRows(aegisFile)) aegis.set(Number(r.item), r.aegis);
  }
  return { views, names, items, aegis };
}

function readRenderProbe(file) {
  const out = new Map();
  if (!file || !existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [view, , result] = line.split("\t");
    const v = Number(view);
    // The probe drove /image?headgear=<view>, so every row is an accessory view.
    if (Number.isInteger(v) && result) out.set(keyOf("acc", v), result);
  }
  return out;
}

function readAppViews(file) {
  const out = new Set();
  if (!file || !existsSync(file)) return out;
  const json = JSON.parse(readFileSync(file, "utf8"));
  const items = Array.isArray(json) ? json : (json.items ?? []);
  for (const it of items) {
    if (!Number.isInteger(it.view) || !it.view) continue;
    // The app's own slots say which namespace the item's view id belongs to.
    out.add(keyOf((it.slots ?? []).includes("garment") ? "robe" : "acc", it.view));
  }
  return out;
}

export function buildShortlist({
  renderable = paths.renderProbe(),
  app = paths.appCostumes(),
} = {}) {
  const catalogues = new Map();
  for (const id of Object.keys(ORIGINS)) {
    const c = readCatalogue(id);
    if (c) catalogues.set(id, c);
  }
  if (!catalogues.size) throw new Error("no catalogues on disk — run stage 2 first");

  const probe = readRenderProbe(renderable);
  const appViews = readAppViews(app);

  const union = new Set();
  for (const c of catalogues.values()) for (const v of c.views.keys()) union.add(v);

  const rows = [];
  let need = 0;
  let latamDraws = 0;
  const bandNeed = new Map();
  // Why each view is or is not needed. The split matters: "blank" is a view our
  // own client names but our mirror draws nothing for (art not shipped here, or
  // a deliberately blank sprite — the hat-effect costumes all have one), while
  // "absent" is a view our client does not define at all, i.e. a genuine
  // foreign exclusive.
  const byStatus = new Map();

  const keys = [...union].sort((a, b) => {
    const [ka, va] = a.split(":");
    const [kb, vb] = b.split(":");
    return (ka === "acc" ? 0 : 1) - (kb === "acc" ? 0 : 1) || Number(va) - Number(vb);
  });

  for (const key of keys) {
    const [kind, viewStr] = key.split(":");
    const view = Number(viewStr);
    const origins = [];
    let sprite = "";
    for (const [id, c] of catalogues) {
      if (!c.views.has(key)) continue;
      origins.push(id);
      const s = c.views.get(key);
      // The LATAM spelling wins when there is one, because our own mirror is
      // what renders it; otherwise the first client that names it.
      if (s && (!sprite || id === "latam")) sprite = s;
    }

    const inApp = appViews.has(key);
    const probed = probe.get(key);
    const latamHasView = catalogues.get("latam")?.views.has(key) ?? false;
    let latam;
    if (inApp) latam = "listed";
    else if (probed === "drew") latam = "draws";
    else if (probed === "blank") latam = "blank";
    else latam = latamHasView ? "unprobed" : "absent";
    if (latam === "draws") latamDraws++;
    byStatus.set(latam, (byStatus.get(latam) ?? 0) + 1);

    const needIt = !inApp && latam !== "draws";
    if (needIt) {
      need++;
      const band = `${kind} ${Math.floor(view / 500) * 500}`;
      bandNeed.set(band, (bandNeed.get(band) ?? 0) + 1);
    }

    let name = "";
    let nameOrigin = "";
    for (const id of NAME_ORDER) {
      const hit = catalogues.get(id)?.names.get(key);
      if (hit?.name) {
        name = hit.name;
        nameOrigin = id;
        break;
      }
    }

    // The English identifier for whatever item any client linked to this view.
    // Item ids are global, so the aegis table of one client names an item linked
    // by another.
    let aegis = "";
    for (const c of catalogues.values()) {
      const item = c.items.get(key);
      if (item === undefined) continue;
      for (const c2 of catalogues.values()) {
        const hit = c2.aegis.get(item);
        if (hit) {
          aegis = hit;
          break;
        }
      }
      if (aegis) break;
    }

    // Does any client call this a costume? A view can be real, named and
    // drawable and still be ordinary equipment the app leaves out on purpose
    // (garment view 2 is the Adventurer's Backpack). "" means no client that
    // has this view ships the flag at all.
    let costume = "";
    for (const c of catalogues.values()) {
      const flag = c.names.get(key)?.costume;
      if (flag === "yes") {
        costume = "yes";
        break;
      }
      if (flag === "no") costume = "no";
    }

    rows.push([
      kind,
      view,
      sprite,
      origins.join(","),
      latam,
      inApp ? "yes" : "no",
      needIt ? "yes" : "no",
      name,
      nameOrigin,
      aegis,
      costume,
    ]);
  }

  writeRows(
    paths.shortlist(),
    [
      "kind",
      "view",
      "sprite",
      "origins",
      "latam",
      "inApp",
      "need",
      "name",
      "nameOrigin",
      "aegis",
      "costume",
    ],
    rows,
  );

  // Band keys are "<kind> <low>", so they sort by kind first and then number.
  const bands = [...bandNeed.entries()]
    .sort((a, b) => {
      const [ka, la] = a[0].split(" ");
      const [kb, lb] = b[0].split(" ");
      return ka.localeCompare(kb) || Number(la) - Number(lb);
    })
    .map(([band, n]) => {
      const [kind, low] = band.split(" ");
      return `need ${kind} ${low}-${Number(low) + 499}: ${n}`;
    });

  const countKind = (k) => rows.filter((r) => r[0] === k).length;
  const needKind = (k) => rows.filter((r) => r[0] === k && r[6] === "yes").length;
  const needRows = rows.filter((r) => r[6] === "yes");
  return {
    origins: [...catalogues.keys()],
    // Which of the consumer's two inputs were actually there. Without them
    // every view looks missing, which is a very different file from a real
    // shortlist and must not be mistaken for one.
    missingInputs: [
      existsSync(app) ? null : `app catalogue (${app})`,
      existsSync(renderable) ? null : `render probe (${renderable})`,
    ].filter(Boolean),
    unionViews: union.size,
    kinds: { acc: countKind("acc"), robe: countKind("robe") },
    needByKind: { acc: needKind("acc"), robe: needKind("robe") },
    inApp: appViews.size,
    latamDraws,
    need,
    rows: rows.length,
    named: rows.filter((r) => r[7]).length,
    byStatus: [...byStatus.entries()].sort((a, b) => b[1] - a[1]),
    needCostume: {
      yes: needRows.filter((r) => r[10] === "yes").length,
      no: needRows.filter((r) => r[10] === "no").length,
      unknown: needRows.filter((r) => !r[10]).length,
      named: needRows.filter((r) => r[7]).length,
      aegis: needRows.filter((r) => r[9]).length,
      nothing: needRows.filter((r) => !r[7] && !r[9]).length,
    },
    bands,
  };
}
