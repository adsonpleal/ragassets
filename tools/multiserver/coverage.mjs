// The rule that decides whether to spend bandwidth probing .rgz patches.
//
// Kept here, pure and dependency-free, because it is the one place in the
// pipeline that chooses to download tens of MB from somebody else's CDN, and a
// rule like that should be readable and testable on its own.
//
// "Are the old .txt tables missing?" is the wrong question. Three of the six
// origins ship .txt files that do not answer it:
//
//   twRO   277 copies of idnum2itemresnametable.txt and NO display-name table,
//          so the pair names nothing at all.
//   kRO    both tables, but an ancient pair: 7,170 items, naming 553 of 2,734
//          views. (Its current item data is inside the blocked v0x300 archives.)
//   jRO    both tables, current enough to name 2,184 views — and probing it
//          cost 41 MB over 12 patches for nothing.
//
// The right question is whether what we already have explains the client we are
// looking at: how many of the views this client defines can be given a name.

/** The share of this client's views that the legacy .txt pair can name. */
export function legacyNameCoverage({ viewRows, legacyRes, legacyNames, threshold = 0.5 }) {
  // A view is nameable from the .txt pair when some item's resource name is its
  // sprite (the client's convention: sprite `_고글` <- item `고글`) *and* that
  // item has a display name. A resource table with no display table beside it
  // therefore counts as zero, which is exactly twRO's case.
  const namedSprites = new Set();
  for (const [id, res] of legacyRes) {
    if (legacyNames.has(id)) namedSprites.add(`_${res}`.toLowerCase());
  }
  let withSprite = 0;
  let named = 0;
  for (const r of viewRows) {
    if (!r.sprite) continue;
    withSprite++;
    if (namedSprites.has(r.sprite.toLowerCase())) named++;
  }
  const ratio = withSprite ? named / withSprite : 0;
  return {
    withSprite,
    named,
    ratio,
    // No views at all means no evidence either way; probing is still the only
    // way to learn anything, so treat it as thin.
    thin: ratio < threshold,
    label: `${named}/${withSprite} views`,
  };
}
