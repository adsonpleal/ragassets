// Byte-range arithmetic, kept pure and dependency-free so it can be tested
// without a ragassets checkout.
//
// Stage 4 reads individual GRF entries over HTTP and FTP range requests. Every
// request waits its turn behind a one-per-second-per-host limiter, so the
// request count — not the byte count — is what sets the wall clock: 1,500 entry
// reads is 25 minutes of pure waiting.
//
// Patches group a costume's files together, so entries we want tend to sit next
// to each other with small gaps between them. Reading across a gap costs the
// gap's bytes; not reading across it costs a whole round trip. Below the gap
// window the bytes are the cheaper of the two.

/** Merge spans separated by less than `gap`. Default: 256 KB. */
export const COALESCE_GAP = 256 * 1024;

/**
 * Group `{start, length, ...}` spans into the ranges to actually request.
 *
 * Returns `[{start, end, spans}]` with `end` inclusive, the way both HTTP's
 * `Range` header and `curl -r` want it. Each span is carried through untouched
 * so the caller can slice its own bytes back out of the response.
 */
export function coalesceSpans(spans, { gap = COALESCE_GAP } = {}) {
  const sorted = spans.filter((s) => s.length > 0).sort((a, b) => a.start - b.start);
  const ranges = [];
  for (const s of sorted) {
    const end = s.start + s.length - 1;
    const last = ranges[ranges.length - 1];
    // `last.end + 1` is the first byte not yet covered; the distance from there
    // to this span's start is the gap that would be read for nothing. Spans
    // that overlap or abut give a gap of zero or less and always merge.
    if (last && s.start - (last.end + 1) <= gap) {
      last.end = Math.max(last.end, end);
      last.spans.push(s);
    } else {
      ranges.push({ start: s.start, end, spans: [s] });
    }
  }
  return ranges;
}

/** What a set of ranges will transfer, against what the spans actually need. */
export function rangeCost(ranges) {
  let requested = 0;
  let useful = 0;
  for (const r of ranges) {
    requested += r.end - r.start + 1;
    for (const s of r.spans) useful += s.length;
  }
  return { requests: ranges.length, requested, useful, waste: requested - useful };
}

// A GRF table lists directories alongside files, distinguished only by this
// bit. A directory entry decodes to zero bytes, so writing it puts an empty
// FILE where a directory has to go — and the next real entry under it then
// fails with EEXIST. Filtering here, before any span is built, is cheaper than
// recognising the wreckage later.
export const GRF_FILE_BIT = 0x01;

/** Only the entries that are actually files. */
export function fileEntries(entries) {
  return entries.filter((e) => (e.flags & GRF_FILE_BIT) !== 0);
}
