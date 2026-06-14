# Changelog

All notable changes to this project are documented here. The project deploys
continuously (no version tags), so entries are grouped by date.

## 2026-06-14

### Added
- **`GET /gif`** — a sibling of `/image` that accepts every `/image` query
  parameter (same still-vs-animation rule, cache headers, and `ETag`/`304`
  support) but converts the rendered PNG/APNG to a **GIF**. An `action` yields an
  animated, infinitely-looping GIF; a `frame` (or neither) yields a still GIF.
  `outputFormat=zip` is rejected (`400`) since the response is a single image.
  Intended for clients that can't display APNG (chat embeds, link-preview
  crawlers, older tooling).

### Changed
- The gateway now does in-process **APNG→GIF conversion** (`gateway/gif.go`) —
  the only image processing it performs. It composites APNG frames onto a full
  canvas (honoring per-frame offset/blend/dispose ops) and quantizes each frame
  to its own ≤256-color palette with a reserved transparent index. GIF
  transparency is a single palette index, so antialiased sprite edges harden;
  prefer `/image` (APNG) for crisp edges.
- Added two small pure-Go dependencies used only by `/gif`: `github.com/kettek/apng`
  (APNG decode) and `github.com/ericpauley/go-quantize` (color quantization).
