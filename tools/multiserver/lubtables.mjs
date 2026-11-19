// The client tables this pipeline reads, and how.
//
// **There are two view-id namespaces, not one.** A headgear's view id indexes
// the accessory tables; a garment's indexes the robe tables; and the same small
// number means a different costume in each. LATAM's view 8 is "Máscara de
// Segurança" as a headgear and "Asas da Fênix" as a garment. An item's own
// ClassNum is its view id *within its namespace*, and a weapon's ClassNum is a
// third space again (ClassNum 2 = sword), so reading ClassNum without deciding
// the namespace first attaches weapon names to low headgear ids — which is
// exactly the bug this file's split fixes.
//
// Six files per client answer everything the catalogue needs:
//
//   datainfo/AccessoryId.lub            ACCESSORY_IDs.ACCESSORY_<X> -> view id
//   datainfo/AccName.lub                AccNameTable[view id]       -> "_<X>"
//   datainfo/SpriteRobeId.lub           SPRITE_ROBE_IDs.ROBE_<X>    -> view id
//   datainfo/SpriteRobeName.lub         RobeNameTable[view id]      -> the Korean
//                                       sprite folder (which IS the garment
//                                       item's resource name), and
//                                       RobeNameTable_Eng the ASCII spelling
//   idnum2itemresnametable.txt          item id -> sprite resource name
//   idnum2itemdisplaynametable.txt      item id -> display name, in that
//                                                  server's own language
//
// The two `.lub` are precompiled Lua 5.1 with sizeof(size_t) = 4, which a
// 64-bit interpreter refuses to load — which is why ragassets needs a 32-bit
// armhf Lua under qemu to rebake its resolver tables. It does not need one to
// *read* these, because extract-grf.mjs carries its own Lua 5.1 undumper and
// VM: running AccessoryId.lub and AccName.lub into one globals table and
// reading `AccNameTable` out of it is exactly what buildViewResolver does
// there, so that is what happens here too.
//
// This replaced a standalone bytecode reader this pipeline used to carry (a
// second undumper plus a SETTABLE/GETTABLE walker, 424 lines) when it lived in
// the app's repository and could not import ragassets as a module. Checked
// before deleting it, on all seven clients' tables: the VM reproduces every row
// of every accessory, robe and aegis table, 19,949 accessory rows and 2,234
// garment rows, with one difference — "_캡" for accessory view 14, which the VM
// path read as "_ĸ" because decodeClientString tries UTF-8 first and C4 B8 is
// valid UTF-8 by accident. That is what decodeTableString is for; see its
// comment in extract-grf.mjs.

import { readFileSync } from "node:fs";
import { LuaTable, decodeTableString, runChunkInto } from "../../extract-grf.mjs";
import { decodeTable } from "./net.mjs";

/** Run one or more chunks into one globals table, the way a client does. */
function runTables(...files) {
  const globals = new LuaTable();
  for (const file of files) runChunkInto(readFileSync(file), globals);
  return globals;
}

/** A `{[number] = "string"}` table as a Map. "" is kept: see joinAccessories. */
function byNumber(tbl) {
  const out = new Map();
  if (!(tbl instanceof LuaTable)) return out;
  for (const [k, v] of tbl.map) {
    if (typeof k === "number" && k > 0 && typeof v === "string") {
      out.set(Math.round(k), decodeTableString(v));
    }
  }
  return out;
}

/**
 * A `{KEY = <number>}` table as a Map — AccessoryId, SpriteRobeId, ItemDBNameTbl.
 *
 * The key is decoded, not taken as it comes: the VM keeps every string as
 * latin1, and while an ACCESSORY_ constant is pure ASCII, an AegisName is not
 * always — iRO's item 31123 is `C_Ｇhostring_Tall_Hat` with a fullwidth Ｇ.
 */
function byName(tbl) {
  const out = new Map();
  if (!(tbl instanceof LuaTable)) return out;
  for (const [k, v] of tbl.map) {
    if (typeof k === "string" && typeof v === "number") {
      out.set(decodeTableString(k), Math.round(v));
    }
  }
  return out;
}

/**
 * The global a table really lives under.
 *
 * All seven clients today spell these the same way, so the exact names below
 * hit every time. The fallback is there because the chunk is the authority and
 * a renamed global should degrade to "the biggest table of the right shape"
 * rather than to an empty catalogue that looks like a client with no costumes.
 */
function pickGlobal(globals, name, { fallback = () => true } = {}) {
  const exact = globals.get(name);
  if (exact instanceof LuaTable) return byNumber(exact);
  let best = new Map();
  for (const [key, value] of globals.map) {
    if (typeof key !== "string" || !(value instanceof LuaTable)) continue;
    if (!fallback(key)) continue;
    const rows = byNumber(value);
    if (rows.size > best.size) best = rows;
  }
  // Loud, the way namedTable in extract-grf.mjs is loud about the same thing:
  // "the biggest table" is a safety net and not the plan, and a miss means a
  // client renamed a global, which is worth reading in a run log.
  console.error(`! ${name} not defined by the chunk — using its largest table (${best.size} rows)`);
  return best;
}

/** A global that is the `_Eng` spelling of a table, and one that is not. */
const isEng = (name) => /_eng$/i.test(name);

/**
 * Join AccessoryId.lub and AccName.lub into rows sorted by view id.
 *
 * `sprite` is null when AccName has no entry at all and "" when it has a blank
 * one — different things: the blank is a costume the client deliberately draws
 * nothing for (every hat-effect costume has one).
 */
export function joinAccessories(idPath, namePath) {
  const globals = runTables(idPath, namePath);
  const ids = byName(globals.get("ACCESSORY_IDs"));
  const names = pickGlobal(globals, "AccNameTable");
  const rows = [];
  for (const [key, view] of ids) {
    rows.push({ key, view, sprite: names.has(view) ? names.get(view) : null });
  }
  rows.sort((a, b) => a.view - b.view);
  return {
    rows,
    stats: {
      ids: ids.size,
      names: names.size,
      withSprite: rows.filter((r) => r.sprite).length,
      blank: rows.filter((r) => r.sprite === "").length,
      missingName: rows.filter((r) => r.sprite === null).length,
    },
  };
}

/**
 * The garment namespace: one row per robe view id.
 *
 * `sprite` is the Korean folder name under `data/sprite/로브/`, and it is also
 * the garment item's own `identifiedResourceName` — which is the only thing
 * that links an item to a garment view id, since the ASCII name matches
 * neither. Both spellings exist as real folders in a live client, so both are
 * kept and stage 4 tries each.
 */
export function joinRobes(idPath, namePath) {
  const globals = runTables(idPath, namePath);
  const ids = byName(globals.get("SPRITE_ROBE_IDs") ?? globals.get("ROBE_IDs"));
  const eng = pickGlobal(globals, "RobeNameTable_Eng", { fallback: isEng });
  const sprite = pickGlobal(globals, "RobeNameTable", { fallback: (n) => !isEng(n) });
  const rows = [];
  for (const [key, view] of ids) {
    rows.push({
      key,
      view,
      sprite: sprite.get(view) ?? null,
      spriteEng: eng.get(view) ?? null,
    });
  }
  rows.sort((a, b) => a.view - b.view);
  return {
    rows,
    stats: {
      ids: ids.size,
      names: sprite.size,
      namesEng: eng.size,
      withSprite: rows.filter((r) => r.sprite).length,
      missingName: rows.filter((r) => r.sprite === null).length,
    },
  };
}

/**
 * item id -> AegisName, from `Lua Files/ItemDBNameTbl.lub`.
 *
 * All seven origins ship this one, with the same English identifiers, because
 * an AegisName is the server-side canonical name: `Wings_Of_Fallen_Angel`,
 * `C_Chained_Bear`. It is not a display name and does not belong in the UI, but
 * it is the best thing to hand a translator when the only display name a
 * costume has is Chinese or Japanese — and item ids are global, so the name
 * found here applies to an item linked by any other client.
 */
export function readAegisNames(path) {
  const globals = runTables(path);
  const out = new Map();
  for (const [aegis, id] of byName(globals.get("ItemDBNameTbl"))) {
    // Several names can point at one id; the first wins, as everywhere else.
    if (!out.has(id)) out.set(id, aegis);
  }
  return out;
}

/**
 * Read one of the client's `#`-delimited item tables.
 *
 * The format is two fields per record, each terminated by `#`:
 *
 *     501#Red Potion#
 *
 * `#` (0x23) is never a trail byte in Shift-JIS, Big5 or EUC-KR, so splitting
 * on it is safe in every client's encoding.
 */
function readPairs(buf, decodeWhole) {
  const text = decodeWhole(buf);
  const out = new Map();
  const fields = text.split("#");
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const id = Number(fields[i].trim());
    if (!Number.isInteger(id) || id <= 0) continue;
    const value = fields[i + 1].trim();
    if (value) out.set(id, value);
  }
  return out;
}

/**
 * item id -> sprite resource name.
 *
 * These are **not** in the server's display language. A resource name is a path
 * inside the GRF, so every client ships the original Korean (or ASCII) bytes —
 * jRO's table holds `빨간포션` for Red Potion while its *display* table holds
 * `赤ポーション`. Decoding this one as Shift-JIS produces half-width katakana
 * mojibake that matches no sprite, which is exactly the bug this split fixes.
 */
export function readResourceTable(path) {
  // latin1 keeps bytes 1:1 so decodeTableString can pick the real charset per
  // value — EUC-KR first, because a resource name is a GRF path and never UTF-8.
  const raw = readPairs(readFileSync(path), (buf) => buf.toString("latin1"));
  const out = new Map();
  for (const [id, value] of raw) out.set(id, decodeTableString(value) ?? value);
  return out;
}

/** item id -> display name, in that server's own language. */
export function readDisplayNameTable(path, encoding) {
  return readPairs(readFileSync(path), (buf) => decodeTable(buf, encoding));
}
