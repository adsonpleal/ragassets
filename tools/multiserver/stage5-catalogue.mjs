// Stage 5 — the catalogue a consumer can actually use.
//
// Everything before this stage is addressed by the pipeline's own keys: a
// shortlist row, a plan step, a path inside somebody's patch. This stage turns
// that into one list of costumes that are *present on disk and renderable*, with
// the `origin` dimension the feature needs for its badge and its filter.
//
// Two decisions are baked in here, both measured rather than assumed.
//
// **One tree per origin, not a merged one.** Of 68,197 distinct paths across the
// seven trees only 2,792 appear in more than one, and 286 of those have
// different content between origins — 282 `.act` (animation offsets) and 4
// `.spr` (the artwork itself), concentrated in 4 costumes. So merging would
// corrupt those 4 and save almost nothing, since the overlap is 4% of the paths.
// Each costume therefore carries the origin whose tree holds its files.
//
// **Where it comes from and who has it are two different questions.** `origin`
// is the tree whose files render the costume -- one tree, because the
// extraction downloaded each costume from exactly one client. `origins` is
// every official server whose own archives ship the sprite, which is what the
// filter means by "the costumes iRO has". The two differ a lot, because the
// extraction pulled each costume from whichever client was cheapest to fetch
// it from: filtering on `origin` showed a costume under one server and hid it
// from every other server that has it just as much.
//
// **The view id is not a global key.** The gateway resolves a headgear id to a
// sprite name through a table baked from the LATAM client; a foreign view id may
// be absent from that table, or map to a different name there (views 2007 and
// 2696 do). So every costume here carries its sprite name explicitly, and a
// consumer resolves by name, never by replaying a foreign view id through the
// LATAM table.
//
// A costume is listed only when every file the plan assigned to it exists. A
// headgear missing one sex, or a garment missing its root sprite, does not draw,
// and a catalogue that promises it would be a catalogue of 404s.
//
// **Two sources, not one.** Everything above is about a costume whose art this
// pipeline downloaded into a mirror. There is a second kind, and for a long time
// this stage could not see it at all: a view id **our own instance already
// draws**, which the consumer simply does not list. Stage 3 finds them — they
// are its `latam=draws` rows — and then stage 4 deliberately leaves them out of
// the plan, because there is nothing to fetch: the artwork is in our own
// resources already. Having nothing to fetch meant having no plan row, and this
// stage reads the plan, so a costume that needs no download was the one costume
// it could never publish.
//
// That is 1,249 views, against 663 in the mirror. 1,099 of them reach this
// catalogue — the other 150 have no sprite name in any client's table, and the
// sprite name is what the icon route is keyed by — and 788 of those carry a
// costume flag, a name and a slot. They carry `local: true` and
// `origin: "latam"`: the consumer renders them by view id through the ordinary
// route, with no `origin`/`sprite` override, because the view id means the right
// thing in our own table — that is what "our instance draws it" measured. A
// consumer that does not want them can filter on the flag, and a consumer that
// already parks `origin: "latam"` rows (the app does) keeps working untouched.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizePath } from "../../extract-grf.mjs";
import { clientNamesFromDisk, normResource } from "./clientnames.mjs";
import { ORIGINS } from "./origins.mjs";
import { ACC_DIR, ROBE_DIR, SEX_PREFIX, normalizePath, robeTargets } from "./pathshapes.mjs";
import { paths, readRows } from "./store.mjs";

/**
 * Which servers ship this costume, read from each client's own archives.
 *
 * The first version of this asked the view tables instead, and they lie by
 * being too generous: Gravity ships one global accessory table, so a view id
 * is present in nearly every client whether or not that client has the art.
 * It put 591 of the 592 costumes behind the iRO chip and 592 behind twRO
 * Zero's, which tells a player nothing.
 *
 * The path index does not have that problem. It is one row per file per
 * archive, built per origin while indexing, so asking it whether twRO Zero
 * ships `남__c_clb_ss_ll.spr` is asking twRO Zero's patches. The sprite file
 * name is also a stronger identity than the view id: the file either is that
 * artwork or is not, with no table in between.
 *
 * The rule matches `costumeDraws`, so "this server has it" means "this server
 * could render it": both sexes for a headgear, any sprite in the folder for a
 * garment. An archive that had no readable file table is invisible here, so
 * this undercounts rather than inventing.
 */
export function originsFromPaths(costumes, pathsByOrigin) {
  const accWant = new Map(); // normalized .spr path -> "kind:view|sex"
  const robeWant = new Map(); // normalized folder prefix -> Set of "kind:view"
  for (const c of costumes) {
    const key = `${c.kind}:${c.view}`;
    if (!c.sprite) continue;
    if (c.kind === "robe") {
      for (const prefix of robeTargets(c.sprite)) {
        if (!robeWant.has(prefix)) robeWant.set(prefix, new Set());
        robeWant.get(prefix).add(key);
      }
    } else {
      const low = c.sprite.toLowerCase();
      for (const sex of SEX_PREFIX) accWant.set(`${ACC_DIR}${sex}/${sex}${low}.spr`, `${key}|${sex}`);
    }
  }

  const found = new Map(); // origin -> Set of "kind:view|sex" and "kind:view"
  for (const [origin, paths] of pathsByOrigin) {
    const hits = new Set();
    for (const raw of paths) {
      const path = normalizePath(raw);
      if (!path.endsWith(".spr")) continue;
      // The asset tree is rooted differently in different archives (`data\...`
      // in most, deeper in a few), so both lookups are keyed from the folder
      // that names the namespace rather than from the start of the path.
      const accAt = path.indexOf(ACC_DIR);
      if (accAt >= 0) {
        const acc = accWant.get(path.slice(accAt));
        if (acc) hits.add(acc);
        continue;
      }
      // A garment is a folder, so match on the folder and not the file: the
      // sprites inside it are named per sex, per action, per anything.
      const at = path.indexOf(ROBE_DIR);
      if (at < 0) continue;
      const end = path.indexOf("/", at + ROBE_DIR.length);
      if (end < 0) continue;
      for (const key of robeWant.get(path.slice(at, end + 1)) ?? []) hits.add(key);
    }
    found.set(origin, hits);
  }

  const out = new Map();
  for (const c of costumes) {
    const key = `${c.kind}:${c.view}`;
    const origins = [];
    for (const [origin, hits] of found) {
      const has =
        c.kind === "robe"
          ? hits.has(key)
          : SEX_PREFIX.every((sex) => hits.has(`${key}|${sex}`));
      if (has) origins.push(origin);
    }
    out.set(key, origins);
  }
  return out;
}

/** `origins` with the tree's own origin guaranteed present: a costume
 *  extracted from iRO is a costume iRO has, whatever an index says.
 *
 *  Sorted, so the order does not depend on which file was read first -- it is
 *  read out loud in a tooltip ("Visual de iRO, kRO Zero e twRO"), and by luck
 *  the ids sort into the order a reader expects. */
export function withOrigin(origins, origin) {
  return [...new Set([...origins, origin])].sort();
}

/** Every origin's path index, as origin -> the paths inside its archives.
 *  LATAM is skipped: this catalogue is only about what LATAM does not have. */
export function readPathIndex(origins = Object.keys(ORIGINS).filter((o) => o !== "latam")) {
  const out = new Map();
  for (const id of origins) {
    const file = paths.pathsFile(id);
    if (!existsSync(file)) continue;
    out.set(
      id,
      readFileSync(file, "utf8")
        .split("\n")
        .slice(1)
        .map((line) => line.split("\t")[2])
        .filter(Boolean),
    );
  }
  return out;
}

/** Group the plan's rows into the files each costume needs. */
export function planByCostume(rows) {
  const out = new Map();
  for (const r of rows) {
    const key = `${r.kind}:${Number(r.view)}`;
    if (!out.has(key)) {
      out.set(key, { kind: r.kind, view: Number(r.view), origin: r.origin, files: [] });
    }
    out.get(key).files.push(r.path);
  }
  return out;
}

/**
 * The origin a costume carries when its art is ours rather than a mirror's.
 *
 * It is a real origin id and not a sentinel on purpose: these views come from
 * the LATAM client, which is the server the app simulates, and `origins` /
 * `ORIGINS` already know how to label it. The `local` flag is what says the
 * bytes come from our own resources and not from `mirror/latam`.
 */
export const LOCAL_ORIGIN = "latam";

/**
 * The costumes our own instance already draws, keyed like the plan's.
 *
 * `latam=draws` is stage 3's verdict from the render probe: asked with a bare
 * `headgear=<view>` and no sprite override, our gateway drew something other
 * than a naked character. So the art is in our resources and the view id
 * resolves there — the two things a consumer needs, and neither of them a
 * download.
 *
 * A row with no sprite name is skipped: the name is what the icon route is
 * keyed by, and a costume nothing can name a file for is not publishable.
 */
export function localDraws(shortlist) {
  const out = new Map();
  for (const r of shortlist) {
    if (r.latam !== "draws" || !r.sprite) continue;
    const view = Number(r.view);
    if (!Number.isInteger(view) || !view) continue;
    out.set(`${r.kind}:${view}`, {
      kind: r.kind,
      view,
      origin: LOCAL_ORIGIN,
      files: [],
      local: true,
    });
  }
  return out;
}

/** "kind:view" -> the shortlist's own columns. */
export function shortlistByCostume(rows) {
  const out = new Map();
  for (const r of rows) out.set(`${r.kind}:${Number(r.view)}`, r);
  return out;
}

/**
 * "<origin>/<kind>:<view>" — how the blank sweep names a costume, since a view
 * id means nothing without the client it came from.
 *
 * The two sides spell the kind differently (this pipeline says acc/robe, the
 * consumer says headgear/garment), so the key accepts either.
 */
const blankKind = (k) => (k === "robe" || k === "garment" ? "robe" : "acc");
export const blankKey = (c) =>
  `${c.origin}/${blankKind(c.viewKind ?? c.kind)}:${Number(c.view)}`;

/** "kind:view" -> the slot list. */
export function slotsByCostume(rows) {
  const out = new Map();
  for (const r of rows) {
    out.set(`${r.kind}:${Number(r.view)}`, r.slots ? r.slots.split(",") : []);
  }
  return out;
}

/**
 * Is this costume renderable on disk?
 *
 * The question is about the **tree**, not about the plan, for two reasons that
 * both bit on this mirror.
 *
 * `--prune-robes` deliberately deletes the adventurer-backpack sprites Gravity
 * leaves in every robe folder it copies, so after pruning a perfectly good
 * garment is missing files the plan listed — 9 LATAM garments lost 1,119 files
 * between them here, and "every planned path exists" dropped all 9.
 *
 * And a plan is a delivery order, not an inventory: a re-plan can assign a
 * costume's `.act` files to one archive while its `.spr` already sits in the
 * tree from an earlier run, so a costume's planned file list need not contain
 * everything it needs, or even a `.spr` at all.
 *
 * So ask the tree what each kind needs in order to draw:
 *
 *   acc    both sex `.spr` files. Nothing prunes headgear.
 *   robe   at least one `.spr` anywhere in the garment's folder. Pruning only
 *          ever removes leftovers, and a folder it empties ships no artwork at
 *          all — which is exactly what ragassets says about the two it empties
 *          here (`c_snow_powder`, `모험가배낭`): their real visual is a `.str`
 *          world effect, handled by `--effects`, not a sprite.
 */
export function costumeDraws(costume, sprite, probe) {
  if (!sprite) return false;
  if (costume.kind === "robe") return probe.robeHasSprite(costume.origin, sprite);
  return probe.headgearPair(costume.origin, sprite);
}

/** The filesystem questions `costumeDraws` asks, isolated so tests can fake them. */
export function treeProbe({ readdirSync, existsSync: exists }) {
  const anySpr = (dir) => {
    let found = false;
    const walk = (d) => {
      if (found) return;
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (found) return;
        if (e.isDirectory()) walk(join(d, e.name));
        else if (/[.]spr$/i.test(e.name)) found = true;
      }
    };
    walk(dir);
    return found;
  };
  return {
    robeHasSprite(origin, sprite) {
      const bare = sprite.replace(/^_/, "");
      return anySpr(join(paths.mirrorDir(origin), "data", "sprite", "로브", bare.toLowerCase()));
    },
    headgearPair(origin, sprite) {
      const root = join(paths.mirrorDir(origin), "data", "sprite", "악세사리");
      return ["남", "여"].every((sex) =>
        exists(join(root, sex, `${sex}${sprite.toLowerCase()}.spr`)),
      );
    },
  };
}

/**
 * Build the catalogue.
 *
 * `present` is injected so the join can be tested without a 3 GB mirror on
 * disk. It has to agree exactly with the transformation the fetcher used when
 * it wrote the mirror, so `catalogueFromDisk` builds it from the fetcher's own
 * `sanitizePath` rather than this module reimplementing it; a caller that
 * passes neither counts nothing as present.
 */
export function buildCatalogue({
  plan,
  shortlist,
  slots,
  probe = treeProbe({ readdirSync, existsSync }),
  present = () => false,
  pathIndex = new Map(),
  blank = [],
  // sprite -> { origin: name }, from every client's own item and name tables.
  // Empty by default so a caller that does not want the join — or a test —
  // builds the catalogue it always built.
  clientNames = new Map(),
  // The second source described at the top of this file. On by default: a view
  // our own instance draws is a costume we can publish, and leaving it out was
  // the gap, not a policy. `--no-local` on the CLI is for auditing the
  // difference, not for normal runs.
  includeLocal = true,
} = {}) {
  const planned = planByCostume(plan);
  const short = shortlistByCostume(shortlist);
  // A planned costume wins over a local one for the same key. They are normally
  // disjoint — stage 4 does not plan what we already draw — but the LATAM tree
  // is itself a source, so a view our gateway cannot draw can still be fetched
  // from LATAM's own patches, and that row describes real files on disk.
  const local = includeLocal ? localDraws(shortlist) : new Map();
  for (const key of planned.keys()) local.delete(key);
  const byCostume = new Map([...planned, ...local]);
  // Which servers ship each costume. Asked once for the whole catalogue,
  // because it costs one pass over every origin's path index.
  const holders = originsFromPaths(
    [...byCostume.values()].map((c) => ({ ...c, sprite: short.get(`${c.kind}:${c.view}`)?.sprite })),
    pathIndex,
  );
  const slotOf = slotsByCostume(slots);
  // Costumes measured to render identically to a character wearing nothing —
  // the sprite is a placeholder for a .str effect the client hangs off it, or
  // the client shipped it broken. They are still here, with a flag: the
  // catalogue says what is on disk and renderable, and "renders nothing a
  // player can see" is a different fact that a consumer decides what to do
  // with. find-blank-visuals.mjs measures it; see blank-visuals.json.
  const isBlank = new Set(blank.map(blankKey));

  const costumes = [];
  const skipped = { incomplete: 0, unknownToShortlist: 0 };
  for (const [key, c] of byCostume) {
    const s = short.get(key);
    if (!s) {
      // A plan row with no shortlist row would mean the two were built from
      // different runs; counting it is better than emitting a nameless costume.
      skipped.unknownToShortlist++;
      continue;
    }
    // The sprite name comes from the shortlist, so this check needs it. A local
    // row skips it: there is no mirror tree to ask, and the question it answers
    // — does this draw? — is what the render probe already measured.
    if (!c.local && !costumeDraws(c, s.sprite, probe)) {
      skipped.incomplete++;
      continue;
    }
    costumes.push({
      kind: c.kind,
      view: c.view,
      sprite: s.sprite,
      // The tree the files come from, and so the one a render asks for.
      origin: c.origin,
      // Every server that has it -- what the badge and the filter read.
      origins: withOrigin(holders.get(key) ?? [], c.origin),
      // Which client named it, which is not always the client the art came
      // from: an item id is global, so twRO can name a costume iRO supplies.
      name: s.name || null,
      nameOrigin: s.name ? s.nameOrigin : null,
      // Every client's own name for this costume, so a consumer can pick by
      // language instead of inheriting the choice `name` already made. Display
      // ready — the underscore convention of the .txt tables is undone — but
      // marker intact: `(服飾)`, `[衣装]`, `Costume:` and `[Visual]` are the
      // clients' own words for "costume version", and for 465 rows that marker
      // is the only thing separating the costume from the base item of the same
      // name, so stripping it upstream would be lossy.
      //
      // Absent, never empty: a client with no table (kRO Zero has neither) is
      // not a client with no name, and an empty object would claim otherwise.
      // `ids` is each client's real item id for this costume — the only key an
      // item database can be linked by, since the app's own id is synthetic and
      // exists in no client's table. Wider than `names`, because a client can
      // know an item without naming it, and where both are present they are the
      // same item: the id published is the one the name was read from.
      ...(() => {
        const row = clientNames.get(normResource(s.sprite));
        if (!row) return {};
        const out = {};
        if (row.names && Object.keys(row.names).length) out.names = row.names;
        if (row.ids && Object.keys(row.ids).length) out.ids = row.ids;
        return out;
      })(),
      // The English identifier, the only English any client ships. It is a
      // translation base, not a display name.
      aegis: s.aegis || null,
      slots: slotOf.get(key) ?? [],
      // Does any client flag this as a costume? Published because the two
      // sources differ in what they sweep up: the mirror only ever held what
      // stage 4 chose to fetch, while a `latam=draws` row can be an ordinary
      // headgear our own client happens to define — `acc:11` is the Biretta,
      // and a consumer showing it as a costume would be wrong. Absent when no
      // client that has the view ships the flag at all, which is not the same
      // as a client saying no.
      ...(s.costume === "yes" ? { costume: true } : s.costume === "no" ? { costume: false } : {}),
      // Present only when true, so the ordinary row stays small.
      ...(isBlank.has(blankKey(c)) ? { blank: true } : {}),
      // The art is in our own resources, not under `mirror/<origin>`: render it
      // by view id, with no origin or sprite override. See the file header.
      ...(c.local ? { local: true } : {}),
      // What is on disk, which after pruning is not what the plan listed. A
      // local row planned nothing, so it is 0 and `local` is what to read.
      files: c.files.filter((p) => present(c.origin, p)).length,
    });
  }

  costumes.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.view - b.view || a.origin.localeCompare(b.origin),
  );

  const perOrigin = {};
  const perSlot = {};
  let named = 0;
  let withAegis = 0;
  let blankCount = 0;
  // The second source, counted apart: it is the difference between "costumes we
  // extracted" and "costumes we can show", and conflating the two is how the
  // 1,249 stayed invisible for so long.
  let localCount = 0;
  let localPublishable = 0;
  let withNames = 0;
  // How many costumes each client can name, which is not how many it has art
  // for: iRO supplies the art for 231 and names 99.
  const namesPerOrigin = {};
  let withIds = 0;
  let idsAgree = 0;
  let idsDisagree = 0;
  const idsPerOrigin = {};
  for (const c of costumes) {
    perOrigin[c.origin] = (perOrigin[c.origin] ?? 0) + 1;
    for (const s of c.slots.length ? c.slots : ["?"]) perSlot[s] = (perSlot[s] ?? 0) + 1;
    if (c.name) named++;
    if (c.aegis) withAegis++;
    if (c.blank) blankCount++;
    if (c.local) {
      localCount++;
      // What a consumer can actually put in a grid: flagged a costume by some
      // client, named, and placed somewhere on the character.
      if (c.costume && c.name && c.slots.length) localPublishable++;
    }
    if (c.names) {
      withNames++;
      for (const o of Object.keys(c.names)) namesPerOrigin[o] = (namesPerOrigin[o] ?? 0) + 1;
    }
    if (c.ids) {
      withIds++;
      for (const o of Object.keys(c.ids)) idsPerOrigin[o] = (idsPerOrigin[o] ?? 0) + 1;
      // Whether the clients that know this costume call it the same number.
      // They descend from one item_db, so they mostly do; where they do not,
      // a consumer cannot link once per costume and has to pick a server.
      const distinct = new Set(Object.values(c.ids));
      if (Object.keys(c.ids).length > 1) {
        if (distinct.size === 1) idsAgree++;
        else idsDisagree++;
      }
    }
  }

  return {
    costumes,
    stats: {
      total: costumes.length,
      named,
      withAegis,
      withNames,
      namesPerOrigin,
      withIds,
      idsPerOrigin,
      idsAgree,
      idsDisagree,
      blank: blankCount,
      local: localCount,
      localPublishable,
      perOrigin,
      perSlot,
      skipped,
    },
  };
}

/** The JSON a consumer reads. */
export function catalogueDocument({ costumes, stats }, { generatedAt } = {}) {
  // Every server any costume here belongs to, not only the trees we pulled
  // from: the labels are what a consumer titles its filter chips with, and the
  // chips are built from `origins`.
  const used = [...new Set(costumes.flatMap((c) => c.origins ?? [c.origin]))].sort();
  return {
    version: 1,
    generatedAt: generatedAt ?? new Date().toISOString().slice(0, 10),
    // Spelled out so a consumer can label a badge without knowing this
    // pipeline. `assets` is where that origin's *mirror* is, and it stays true
    // for LATAM — 71 costumes were fetched from LATAM's own patches. A row with
    // `local: true` is the exception and says so on the row: its bytes are in
    // our own resources, so it is rendered by view id and reads no mirror.
    origins: Object.fromEntries(
      used.map((id) => [id, { label: ORIGINS[id]?.label ?? id, assets: `mirror/${id}` }]),
    ),
    counts: {
      total: stats.total,
      named: stats.named,
      withAegis: stats.withAegis,
      withNames: stats.withNames,
      namesPerOrigin: stats.namesPerOrigin,
      withIds: stats.withIds,
      idsPerOrigin: stats.idsPerOrigin,
      blank: stats.blank,
      // How many of these need no mirror at all. A consumer deciding whether to
      // show them wants the number before it reads 1,099 rows to find out.
      local: stats.local,
      perOrigin: stats.perOrigin,
      perSlot: stats.perSlot,
    },
    costumes,
  };
}

/**
 * The committed result of the blank sweep, which lives in this repository
 * rather than in the state root: it is a measurement of what the gateway
 * renders, it took 822 renders to establish, and the reason each costume is on
 * it should be readable in a diff.
 */
export function readBlankVisuals(file = new URL("./blank-visuals.json", import.meta.url)) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).blank ?? [];
  } catch {
    return [];
  }
}

/** Read the pipeline's files from disk and return the document. */
export function catalogueFromDisk(opts = {}) {
  const built = buildCatalogue({
    plan: readRows(paths.plan()),
    shortlist: readRows(paths.shortlist()),
    slots: readRows(paths.slots()),
    blank: readBlankVisuals(),
    pathIndex: readPathIndex(),
    clientNames: clientNamesFromDisk(),
    present: (origin, path) => {
      const safe = sanitizePath(path);
      return safe ? existsSync(join(paths.mirrorDir(origin), safe)) : false;
    },
    ...opts,
  });
  return { doc: catalogueDocument(built, opts), stats: built.stats };
}
