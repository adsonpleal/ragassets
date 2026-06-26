// Shared library for the mob-name pipeline: GRF extraction + decoding + matching utils.
// All client reads go through extract-grf.mjs so we stay robust to GRF format changes.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runChunkInto, LuaTable } from "./vendor/lua51.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const GRF = process.env.GRF_PATH || "C:/Gravity/Ragnarok/data.grf";
const EXTRACT = resolve(REPO, "extract-grf.mjs");

/** Dump one stored file from the GRF as a Buffer (stderr banner is discarded). */
export function grfDump(innerPath) {
  return execFileSync("node", [EXTRACT, "--dump", `${GRF}::${innerPath}`], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });
}

// ---------------------------------------------------------------------------
// i18n monster-name CSV  (strId = 100000 + rowIndex ; cols 2/7/9 = EN/PT/ES)
// ---------------------------------------------------------------------------
const b64 = s => (s ? Buffer.from(s, "base64").toString("utf8") : "");
const leInt = s => { if (!s) return null; const b = Buffer.from(s, "base64"); let v = 0; for (let i = b.length - 1; i >= 0; i--) v = v * 256 + b[i]; return v; };

/** Returns the monster name rows: [{ rowIndex, strId, en, pt, es }]. */
export function extractCsv() {
  const scJson = JSON.parse(grfDump("data/i18n/sc/sc.json").toString("utf8"));
  const monsterHash = scJson[0]; // monster container is index 0 of the sc list
  const raw = grfDump(`data/i18n/sc/${monsterHash}.csv`).toString("latin1");
  return raw.split(/\r?\n/).filter(l => l.length).map((line, i) => {
    const c = line.split(",");
    return { rowIndex: i, strId: leInt(c[0]), en: b64(c[2]), pt: b64(c[7]).trim(), es: b64(c[9]).trim() };
  });
}

// ---------------------------------------------------------------------------
// npcidentity.lub  ->  AEGIS <-> jobID
// ---------------------------------------------------------------------------
export function extractNpcIdentity() {
  const G = new LuaTable();
  runChunkInto(grfDump("data/luafiles514/lua files/datainfo/npcidentity.lub"), G);
  const jobtbl = G.get("jobtbl");
  const id2aegis = new Map(), aegis2id = new Map();
  for (const [k, id] of jobtbl.map) {
    const aegis = k.replace(/^JT_/, "");
    if (!id2aegis.has(id)) id2aegis.set(id, aegis);
    if (!aegis2id.has(aegis)) aegis2id.set(aegis, id);
  }
  return { id2aegis, aegis2id };
}

// ---------------------------------------------------------------------------
// navi_mob_br.lub  ->  AEGIS -> strId   (the one static game-file bridge)
// Each spawn row is { map, naviId, range, packed, "\x1c"+base64(strId)+"\x1c", AEGIS, level, packed }.
// Parsed straight from the bytecode constant pool via NEWTABLE/LOADK/SETLIST.
// ---------------------------------------------------------------------------
function tokenToStrId(s) {
  if (typeof s !== "string") return null;
  const m = s.replace(/\x1c/g, "");
  if (!/^[A-Za-z0-9+/]{3,6}={0,2}$/.test(m)) return null;
  let b; try { b = Buffer.from(m, "base64"); } catch { return null; }
  if (b.length < 2 || b.length > 4) return null;
  let v = 0; for (let i = b.length - 1; i >= 0; i--) v = v * 256 + b[i];
  return v;
}
export function extractNavi() {
  const v = grfDump("data/luafiles514/lua files/navigation/navi_mob_br.lub");
  const sizeofInt = v[7], sizeofSizeT = v[8];
  let pos = 12;
  const rU = n => { let x = 0; for (let i = 0; i < n; i++) x += v[pos + i] * 2 ** (8 * i); pos += n; return x; };
  const rD = () => { const x = v.readDoubleLE(pos); pos += 8; return x; };
  const rS = () => { const len = rU(sizeofSizeT); if (len === 0) return null; const s = v.toString("latin1", pos, pos + len - 1); pos += len; return s; };
  function proto() {
    rS(); pos += sizeofInt * 2; pos += 4;
    const cc = rU(sizeofInt); const code = []; for (let i = 0; i < cc; i++) { code.push(v.readUInt32LE(pos)); pos += 4; }
    const kc = rU(sizeofInt); const k = []; for (let i = 0; i < kc; i++) { const t = v[pos++]; if (t === 0) k.push(undefined); else if (t === 1) k.push(v[pos++] !== 0); else if (t === 3) k.push(rD()); else if (t === 4) k.push(rS()); else throw new Error("ktype " + t); }
    const pc = rU(sizeofInt); for (let i = 0; i < pc; i++) proto();
    const li = rU(sizeofInt); pos += li * sizeofInt; const lc = rU(sizeofInt); for (let i = 0; i < lc; i++) { rS(); pos += sizeofInt * 2; } const uc = rU(sizeofInt); for (let i = 0; i < uc; i++) rS();
    return { code, k };
  }
  const p = proto(), K = p.k, code = p.code, R = [], entries = [];
  for (let pcx = 0; pcx < code.length; pcx++) {
    const i = code[pcx]; const op = i & 0x3f; const a = (i >>> 6) & 0xff; const c = (i >>> 14) & 0x1ff; const bx = (i >>> 14) & 0x3ffff;
    if (op === 1) R[a] = K[bx];                 // LOADK
    else if (op === 10) R[a] = "__TBL__";        // NEWTABLE
    else if (op === 34) {                        // SETLIST
      let n = (i >>> 23) & 0x1ff; let block = c; if (block === 0) block = code[++pcx];
      const arr = []; for (let j = 1; j <= n; j++) arr.push(R[a + j]); entries.push(arr);
    }
  }
  const aegis2strId = new Map();
  for (const e of entries) {
    if (!Array.isArray(e)) continue;
    const ti = e.findIndex(x => typeof x === "string" && /\x1c/.test(x));
    if (ti < 0) continue;
    const strId = tokenToStrId(e[ti]); const aegis = e[ti + 1];
    if (strId == null || typeof aegis !== "string") continue;
    if (!aegis2strId.has(aegis)) aegis2strId.set(aegis, strId); // first/most-common wins (navi has 0 conflicts)
  }
  return aegis2strId;
}

// ---------------------------------------------------------------------------
// Matching utilities (shared by deterministic resolver + agent grading)
// ---------------------------------------------------------------------------
export const norm = s => (s == null ? "" : String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, ""));
export const tokens = s => new Set(String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter(Boolean));
export function fuzzy(a, b) { const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / Math.max(A.size, B.size); }
export const aegisKey = ag => norm(String(ag).replace(/^(G|MD|EP\d*|EM|EL|VR|A|E|I|B|V|TW|MM|MG|AS|P|C\d|M|S|W|D|QE|DR|4JOB)_+/i, ""));
