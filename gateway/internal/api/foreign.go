package api

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// Foreign is the part of a request that selects a costume from another official
// server: which client's asset tree to read, and what the sprites are called in
// it.
//
// The names are carried in the request rather than looked up from the id
// because the id is not the costume — it is one client's index into its own
// name table. Asking this client for a foreign id either misses (and the
// renderer draws a bare head, a 200 that looks like a render) or hits a
// different hat (and the renderer draws that one, which looks right and is
// wrong). See resolve.SpriteNames.
// MaxOrigins caps how many trees one render may combine. A character wears at
// most three headgears and one garment, so four distinct clients is the most a
// legitimate request can need.
const MaxOrigins = 4

type Foreign struct {
	// Origins are the asset trees to read, in front of the default one and in
	// the order given, e.g. ["twrozero"]. Empty means the default LATAM tree
	// and no overrides — the ordinary path.
	//
	// More than one because a character can wear a hat from one server and a
	// garment from another, and nothing about that is unreasonable to ask for.
	Origins []string
	// Headgear and Garment map a view id to the sprite name to use for it.
	Headgear map[uint32]string
	Garment  map[uint32]string
}

// Empty reports whether this request names no foreign origin, which is the
// overwhelmingly common case and the one that must cost nothing.
func (f Foreign) Empty() bool { return len(f.Origins) == 0 }

// BuildForeign parses the origin and sprite-name overrides out of a query.
//
// It is separate from BuildRequest because it answers a different question:
// BuildRequest says what to draw, this says which client to draw it from. The
// two are combined by the handler, which is also the only place that knows
// which origins were actually mounted at boot.
func BuildForeign(q url.Values) (Foreign, error) {
	var f Foreign

	if q.Has("origin") {
		seen := make(map[string]bool)
		for _, part := range splitCSV(q.Get("origin")) {
			o, err := ParseOriginID(part)
			if err != nil {
				return f, err
			}
			// Duplicates would each get their own layer in the overlay and
			// change nothing but the cache key.
			if seen[o] {
				continue
			}
			seen[o] = true
			f.Origins = append(f.Origins, o)
		}
		if len(f.Origins) == 0 {
			return f, errors.New("'origin' is empty; omit it to render from the default client")
		}
		if len(f.Origins) > MaxOrigins {
			return f, fmt.Errorf("'origin' lists %d trees; at most %d may be combined (a character wears at most 3 headgears and 1 garment)", len(f.Origins), MaxOrigins)
		}
	}

	for _, spec := range []struct {
		param string
		into  *map[uint32]string
	}{
		{"headgearSprite", &f.Headgear},
		{"garmentSprite", &f.Garment},
	} {
		if !q.Has(spec.param) {
			continue
		}
		m, err := parseSpriteNames(spec.param, q.Get(spec.param))
		if err != nil {
			return f, err
		}
		*spec.into = m
	}

	// A sprite name without an origin would be read from the LATAM tree, where
	// that name is either absent or someone else's art. Refusing is the whole
	// point of this parameter existing: the alternative is a plausible picture
	// of the wrong hat.
	if len(f.Origins) == 0 && (len(f.Headgear) > 0 || len(f.Garment) > 0) {
		return f, errors.New("'headgearSprite'/'garmentSprite' need an 'origin' saying which client's asset tree the name belongs to")
	}
	return f, nil
}

// CostumeIcon is a request for the inventory picture of a costume, named the
// way the published catalogue names it: by sprite, not by item id.
//
// /icons/{item,collection}/<id>.png cannot answer this. Its key is a LATAM item
// id, and a foreign costume has none — it is a view id in another client's
// table, and the clients reuse each other's numbers. Its filename pattern is
// also ^[a-z0-9_]+\.png$, while these names are mostly Korean (_두건) or
// Chinese, so they could not be spelled in that route even with an id to hand.
//
// There is deliberately no origin in this request. The sprites are stored one
// tree per origin because a costume's .spr and .act must come from one client;
// an icon is a single standalone BMP with nothing to be consistent with, and
// asking each costume's own client for its icon finds 83.9% of them where
// asking every client finds 96.1%. See tools/multiserver/stage6-icons.mjs.
type CostumeIcon struct {
	// Kind is "item" (the ~24x24 inventory icon) or "collection" (~75x100).
	Kind string
	// Sprite is the costume's sprite name, lowercased, with the leading
	// underscore of an accessory name stripped — the form the extraction
	// writes its files under.
	Sprite string
}

// IconKinds are the two sizes the client ships, and the only two directories
// this route will read. Keep in sync with ICON_KINDS in stage6-icons.mjs.
var IconKinds = []string{"item", "collection"}

// BuildCostumeIcon parses /icons/costume's query.
//
// `kind` defaults to the inventory icon, which is what a grid of costumes
// wants; `collection` is the big one, asked for explicitly.
func BuildCostumeIcon(q url.Values) (CostumeIcon, error) {
	var ic CostumeIcon

	ic.Kind = "item"
	if raw := strings.TrimSpace(q.Get("kind")); raw != "" {
		ic.Kind = strings.ToLower(raw)
		if ic.Kind != "item" && ic.Kind != "collection" {
			return ic, fmt.Errorf("invalid 'kind' %q: expected one of %v", raw, IconKinds)
		}
	}

	if !q.Has("sprite") {
		return ic, errors.New("'sprite' is required, e.g. sprite=_c_chained_bear (the name the catalogue carries)")
	}
	name, err := cleanSpriteName("sprite", q.Get("sprite"))
	if err != nil {
		return ic, err
	}
	// The stored file name drops the accessory tables' leading underscore,
	// because that marker is not part of the resource name the BMP is called
	// after. Accepting the name either way is the point: a consumer passes the
	// catalogue's `sprite` through untouched and does not have to know that.
	ic.Sprite = strings.TrimLeft(name, "_")
	if ic.Sprite == "" {
		return ic, fmt.Errorf("invalid 'sprite' %q: a name of underscores names nothing", q.Get("sprite"))
	}
	return ic, nil
}

// ParseOriginID accepts the shape of an origin id and nothing else. Which ids
// exist is the handler's business — it knows what was mounted — but a value
// that could escape a directory must never reach it.
func ParseOriginID(s string) (string, error) {
	if s == "" {
		return "", errors.New("'origin' is empty; omit it to render from the default client")
	}
	if len(s) > 32 {
		return "", errors.New("'origin' is too long")
	}
	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return "", fmt.Errorf("invalid 'origin' %q: expected lowercase letters and digits, e.g. origin=twrozero", s)
		}
	}
	return s, nil
}

// parseSpriteNames reads a comma-separated list of `viewID:spriteName`.
//
// Pairs rather than a list positionally parallel to `headgear`: an off-by-one
// in a positional list draws the wrong hat silently, and this parameter exists
// to stop exactly that class of mistake.
func parseSpriteNames(param, raw string) (map[uint32]string, error) {
	out := make(map[uint32]string)
	for _, part := range splitCSV(raw) {
		id, name, ok := strings.Cut(part, ":")
		if !ok {
			return nil, fmt.Errorf("invalid '%s' entry %q: expected viewID:spriteName, e.g. %s=2904:_c_harword_doll_hat", param, part, param)
		}
		n, err := parseInt(param, id)
		if err != nil {
			return nil, err
		}
		clean, err := cleanSpriteName(param, name)
		if err != nil {
			return nil, err
		}
		if prev, dup := out[uint32(n)]; dup && prev != clean {
			return nil, fmt.Errorf("'%s' names view %d twice, as %q and %q", param, n, prev, clean)
		}
		out[uint32(n)] = clean
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("'%s' is empty", param)
	}
	return out, nil
}

// cleanSpriteName validates a name that is about to become part of a file path.
//
// Lowercased because that is the only case that exists in a mirror: every path
// under data/ is written lowercase, and the client's own name tables are
// lowercased to match. Accepting mixed case would work on a case-insensitive
// filesystem and 404 on the server, which is the worst way to find out.
func cleanSpriteName(param, name string) (string, error) {
	n := strings.ToLower(strings.TrimSpace(name))
	if n == "" {
		return "", fmt.Errorf("'%s' has an entry with an empty sprite name", param)
	}
	if len(n) > 128 {
		return "", fmt.Errorf("'%s' sprite name is too long", param)
	}
	// A name becomes a path segment, so a separator or a parent reference in it
	// would read outside the tree.
	if strings.ContainsAny(n, `/\`) || strings.Contains(n, "..") {
		return "", fmt.Errorf("invalid '%s' sprite name %q: a name is a single path segment, with no slashes or '..'", param, name)
	}
	for _, r := range n {
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("invalid '%s' sprite name %q: contains a control character", param, name)
		}
	}
	return n, nil
}
