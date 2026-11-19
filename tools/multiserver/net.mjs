// Polite, resumable HTTP(S)/FTP reads for the patch servers.
//
// Three things every caller here needs and none of them should reimplement:
//
//   * one request per second per host, because these are somebody else's CDNs
//     and this tool walks ~9,400 archives across six of them;
//   * range reads, which is the whole trick that makes indexing cheap — a GRF
//     keeps its file table at the END and the offset is in the first 46 bytes,
//     so two small reads describe a whole patch;
//   * FTP, because iRO serves its archives over FTP only (HTTP 404s on every
//     path tried). curl does FTP `REST` correctly and shelling out to it beats
//     writing an FTP client, so FTP reads go through curl and HTTP reads go
//     through fetch.

import { execFile } from "node:child_process";
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const UA = process.env.MULTISERVER_UA ?? "ragassets-multiserver/1.0";

// Minimum gap between two requests to the same host, milliseconds.
const MIN_INTERVAL = Number(process.env.MULTISERVER_INTERVAL_MS ?? 1000);

const lastHit = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Wait until this host's turn. Serialises per host, not globally. */
async function takeTurn(url) {
  const host = hostOf(url);
  for (;;) {
    const now = Date.now();
    const next = (lastHit.get(host) ?? 0) + MIN_INTERVAL;
    if (now >= next) {
      lastHit.set(host, now);
      return;
    }
    // Claim the slot before sleeping so two callers can't both decide they are
    // first; re-check after, in case another claimed it while we waited.
    await sleep(next - now);
  }
}

export class HttpError extends Error {
  constructor(status, url, range) {
    super(`${status} for ${url}${range ? ` [${range}]` : ""}`);
    this.status = status;
    this.url = url;
  }
}

const isFtp = (url) => url.startsWith("ftp://");

// 403 and 404 are answers, not failures: a wrong path prefix on these CDNs says
// 403, and retrying either one just wastes somebody's bandwidth.
const RETRYABLE = (status) => status === 0 || status === 429 || status >= 500;

async function withRetry(label, attempt, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      const status = err instanceof HttpError ? err.status : 0;
      if (!RETRYABLE(status)) throw err;
      if (i === tries - 1) break;
      await sleep(1000 * 2 ** i);
    }
  }
  throw new Error(`${label} failed after ${tries} tries: ${lastErr?.message}`);
}

/**
 * Read bytes [start, end] (inclusive, HTTP semantics). Omit `end` for "to the
 * end of the file". Returns a Buffer.
 */
export async function readRange(url, start, end) {
  const range = end === undefined ? `${start}-` : `${start}-${end}`;
  return withRetry(`range ${range} ${url}`, async () => {
    await takeTurn(url);
    if (isFtp(url)) return curlRange(url, range);
    const res = await fetch(url, { headers: { "User-Agent": UA, Range: `bytes=${range}` } });
    if (res.status !== 206 && res.status !== 200) throw new HttpError(res.status, url, range);
    return Buffer.from(await res.arrayBuffer());
  });
}

/** FTP range read via curl -r. curl writes to stdout; we take it as a Buffer. */
async function curlRange(url, range) {
  try {
    const { stdout } = await execFileAsync(
      "curl",
      ["-sS", "-m", "60", "-A", UA, "-r", range, url],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
    );
    if (!stdout.length) throw new HttpError(0, url, range);
    return stdout;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(0, url, range);
  }
}

export async function fetchText(url) {
  return withRetry(`text ${url}`, async () => {
    await takeTurn(url);
    if (isFtp(url)) {
      const { stdout } = await execFileAsync("curl", ["-sS", "-m", "120", "-A", UA, url], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout.toString("utf8");
    }
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new HttpError(res.status, url);
    return res.text();
  });
}

/**
 * Download a whole file to `dest`, skipping the request if it is already there
 * with a non-zero size. Writes to `<dest>.part` first so an interrupted run
 * never leaves a truncated archive that looks complete.
 */
export async function download(url, dest, { force = false } = {}) {
  if (!force) {
    try {
      const st = statSync(dest);
      if (st.size > 0) return { cached: true, bytes: st.size };
    } catch {
      /* not there yet */
    }
  }
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  rmSync(part, { force: true });
  const bytes = await withRetry(`download ${url}`, async () => {
    await takeTurn(url);
    if (isFtp(url)) {
      await execFileAsync("curl", ["-sS", "-m", "900", "-A", UA, "-o", part, url], {
        maxBuffer: 1024 * 1024,
      });
      return statSync(part).size;
    }
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new HttpError(res.status, url);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    return statSync(part).size;
  });
  if (!bytes) {
    rmSync(part, { force: true });
    throw new Error(`empty download: ${url}`);
  }
  renameSync(part, dest);
  return { cached: false, bytes };
}

/** Decode a client text table with that server's own encoding. */
export function decodeTable(buf, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

