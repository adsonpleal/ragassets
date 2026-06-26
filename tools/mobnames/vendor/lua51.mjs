// Minimal Lua 5.1 bytecode VM — just enough to execute the Ragnarok client's
// data-table chunks (System/iteminfo_new.lub, skillinfolist, etc.). These files
// are pure table constructors assigned to globals: no loops, branches, or
// arithmetic, so we only implement the opcodes they actually use and throw on
// anything unexpected. Run a chunk and read the resulting globals.
//
// String constants are kept as latin1 (1:1 byte<->codepoint) so the caller can
// re-decode the original bytes with the right charset (client data mixes CP1252
// Portuguese with EUC-KR Korean). See decodeClientString().

import { readFileSync } from "node:fs";

// Lua 5.1 opcode numbers (lopcodes.h order).
const OP = {
  MOVE: 0, LOADK: 1, LOADBOOL: 2, LOADNIL: 3, GETUPVAL: 4, GETGLOBAL: 5,
  GETTABLE: 6, SETGLOBAL: 7, SETUPVAL: 8, SETTABLE: 9, NEWTABLE: 10, SELF: 11,
  ADD: 12, SUB: 13, MUL: 14, DIV: 15, MOD: 16, POW: 17, UNM: 18, NOT: 19,
  LEN: 20, CONCAT: 21, JMP: 22, EQ: 23, LT: 24, LE: 25, TEST: 26, TESTSET: 27,
  CALL: 28, TAILCALL: 29, RETURN: 30, FORLOOP: 31, FORPREP: 32, TFORLOOP: 33,
  SETLIST: 34, CLOSE: 35, CLOSURE: 36, VARARG: 37,
};
const FIELDS_PER_FLUSH = 50;
const BITRK = 1 << 8;

export class LuaTable {
  constructor() {
    this.map = new Map();
  }
  set(k, v) {
    if (v === undefined || v === null) this.map.delete(k);
    else this.map.set(k, v);
  }
  get(k) {
    return this.map.get(k);
  }
}

// ---------------------------------------------------------------------------
// Chunk loader (proto tree)
// ---------------------------------------------------------------------------

function loadChunk(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf[0] !== 0x1b || buf[1] !== 0x4c || buf[2] !== 0x75 || buf[3] !== 0x61)
    throw new Error("not a Lua chunk");
  if (buf[4] !== 0x51) throw new Error(`unsupported Lua version 0x${buf[4].toString(16)}`);
  const c = {
    buf,
    pos: 12,
    sizeofInt: buf[7],
    sizeofSizeT: buf[8],
    sizeofInstr: buf[9],
    sizeofNumber: buf[10],
  };
  if (c.sizeofInstr !== 4) throw new Error("only 4-byte instructions supported");
  return readProto(c);
}

function readUInt(c, n) {
  let val = 0;
  for (let i = 0; i < n; i++) val += c.buf[c.pos + i] * 2 ** (8 * i);
  c.pos += n;
  return val;
}

function readString(c) {
  const len = readUInt(c, c.sizeofSizeT);
  if (len === 0) return null;
  const start = c.pos;
  c.pos += len;
  return c.buf.toString("latin1", start, start + len - 1); // drop trailing \0
}

function readProto(c) {
  readString(c); // source name
  c.pos += c.sizeofInt; // line defined
  c.pos += c.sizeofInt; // last line defined
  c.pos += 4; // nups, numparams, is_vararg, maxstacksize

  const sizecode = readUInt(c, c.sizeofInt);
  const code = new Array(sizecode);
  for (let i = 0; i < sizecode; i++) {
    code[i] = c.buf.readUInt32LE(c.pos);
    c.pos += 4;
  }

  const sizek = readUInt(c, c.sizeofInt);
  const k = new Array(sizek);
  for (let i = 0; i < sizek; i++) {
    const type = c.buf[c.pos++];
    if (type === 0) k[i] = undefined;
    else if (type === 1) k[i] = c.buf[c.pos++] !== 0;
    else if (type === 3) {
      k[i] = c.buf.readDoubleLE(c.pos);
      c.pos += 8;
    } else if (type === 4) k[i] = readString(c);
    else throw new Error(`unknown constant type ${type}`);
  }

  const sizep = readUInt(c, c.sizeofInt);
  const protos = new Array(sizep);
  for (let i = 0; i < sizep; i++) protos[i] = readProto(c);

  // debug blocks — skip
  const lineInfo = readUInt(c, c.sizeofInt);
  c.pos += lineInfo * c.sizeofInt;
  const locals = readUInt(c, c.sizeofInt);
  for (let i = 0; i < locals; i++) {
    readString(c);
    c.pos += c.sizeofInt * 2;
  }
  const upvals = readUInt(c, c.sizeofInt);
  for (let i = 0; i < upvals; i++) readString(c);

  return { code, k, protos };
}

// ---------------------------------------------------------------------------
// Interpreter — executes a single proto over a shared globals table.
// ---------------------------------------------------------------------------

function execute(proto, globals) {
  const R = [];
  const K = proto.k;
  const rk = (x) => (x & BITRK ? K[x & (BITRK - 1)] : R[x]);
  let pc = 0;
  while (pc < proto.code.length) {
    const i = proto.code[pc++];
    const op = i & 0x3f;
    const a = (i >>> 6) & 0xff;
    const c = (i >>> 14) & 0x1ff;
    const b = (i >>> 23) & 0x1ff;
    const bx = (i >>> 14) & 0x3ffff;

    switch (op) {
      case OP.MOVE: R[a] = R[b]; break;
      case OP.LOADK: R[a] = K[bx]; break;
      case OP.LOADBOOL: R[a] = b !== 0; if (c) pc++; break;
      case OP.LOADNIL: for (let r = a; r <= b; r++) R[r] = undefined; break;
      case OP.GETGLOBAL: R[a] = globals.get(K[bx]); break;
      case OP.SETGLOBAL: globals.set(K[bx], R[a]); break;
      case OP.NEWTABLE: R[a] = new LuaTable(); break;
      case OP.GETTABLE: {
        const t = R[b];
        R[a] = t instanceof LuaTable ? t.get(rk(c)) : undefined;
        break;
      }
      case OP.SETTABLE: {
        const t = R[a];
        if (t instanceof LuaTable) t.set(rk(b), rk(c));
        break;
      }
      case OP.SETLIST: {
        let n = b;
        let block = c;
        if (block === 0) block = proto.code[pc++]; // real C in next word
        if (n === 0) throw new Error("SETLIST with B=0 (vararg) not supported");
        const base = (block - 1) * FIELDS_PER_FLUSH;
        const t = R[a];
        for (let j = 1; j <= n; j++) t.set(base + j, R[a + j]);
        break;
      }
      case OP.CLOSURE: {
        // Represent nested closures as their proto; calling is a no-op below.
        R[a] = { __proto_index: bx, proto: proto.protos[bx] };
        // CLOSURE is followed by `nups` pseudo-instructions (MOVE/GETUPVAL);
        // skip them so we don't misread them as real ops.
        // We don't track nups here, but data chunks have no upvalue captures
        // on these closures, so there is nothing to skip in practice.
        break;
      }
      case OP.CALL: break; // ignore calls — data chunks build tables, not effects
      case OP.TAILCALL: break;
      case OP.RETURN: return; // end of chunk
      case OP.JMP: break; // no real branching in data chunks
      default:
        throw new Error(`unimplemented opcode ${op} at pc ${pc - 1}`);
    }
  }
}

// Run a Lua 5.1 chunk over an existing globals table (so dependent chunks can
// share state, e.g. skillid.lub defines SKID before skillinfolist references it).
export function runChunkInto(bytes, globals) {
  execute(loadChunk(bytes), globals);
  return globals;
}

// Load and run a Lua 5.1 chunk; returns its globals table.
export function runChunk(bytes) {
  return runChunkInto(bytes, new LuaTable());
}

export function runFile(path) {
  return runChunk(new Uint8Array(readFileSync(path)));
}

// Client strings are CP1252 (Portuguese) or EUC-KR (Korean, untranslated). The
// VM keeps them as latin1, so recover the bytes and pick the charset: prefer a
// clean EUC-KR decode that yields Hangul, else fall back to Windows-1252.
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const EUCKR = new TextDecoder("euc-kr", { fatal: true });
const CP1252 = new TextDecoder("windows-1252");
export function decodeClientString(latin1) {
  if (latin1 == null) return null;
  const bytes = Buffer.from(latin1, "latin1");
  if (!bytes.some((x) => x >= 0x80)) return latin1; // pure ASCII
  // The patched iteminfo_new.lub is UTF-8; a strict decode succeeds only for
  // genuine UTF-8 and cleanly covers both Portuguese and Korean. Legacy strings
  // fall back: EUC-KR for pure-Hangul names, else CP1252.
  try {
    return UTF8.decode(bytes);
  } catch {
    /* not UTF-8 */
  }
  if (!/[A-Za-z]/.test(latin1)) {
    try {
      return EUCKR.decode(bytes);
    } catch {
      /* fall through to CP1252 */
    }
  }
  return CP1252.decode(bytes);
}
