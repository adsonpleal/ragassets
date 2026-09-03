// Package api holds the HTTP-facing contract the server and the Worker must
// honour identically: how a query string becomes a render request, and how that
// request becomes an ETag.
//
// It exists because those are the two places where a divergence would be
// invisible rather than loud. A Worker that parsed one parameter differently
// would quietly render a different sprite; one that hashed the query differently
// would invalidate every cached render in the world at cutover. Sharing the code
// makes both impossible instead of merely unlikely.
package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/ragassets/gateway/internal/render/engine"
	"github.com/ragassets/gateway/internal/render/raster"
	"github.com/ragassets/gateway/internal/render/rotype"
	"github.com/ragassets/gateway/internal/render/skin"
)

// Cache-Control policies. Renders, icons, maps, effects and BGM are addressed by
// content — a new build means a new URL or a new validator — so they may be
// pinned indefinitely. The /raw JSON tables are the exception: mutable at a
// stable URL, regenerated after a client update, so they get a short TTL plus
// mandatory revalidation and let the ETag do the real work.
const (
	CacheImmutable  = "public, max-age=31536000, immutable"
	CacheRevalidate = "public, max-age=300, must-revalidate"
)

func BuildRequest(q url.Values) (engine.Request, string, error) {
	var req engine.Request

	jobs := splitCSV(q.Get("job"))
	if len(jobs) == 0 {
		return req, "", errors.New("missing required 'job' parameter, e.g. /image?job=1002")
	}
	job, err := parseInt("job", jobs[0]) // one image per request; first job wins
	if err != nil {
		return req, "", err
	}
	req.Job = uint32(job)

	// Integer params with defaults.
	req.Head = 1
	req.BodyPalette = -1
	req.HeadPalette = -1
	req.EnableShadow = true
	req.HeadDir = rotype.All
	req.SkinTone = 1

	intInto := func(name string, dst *int) error {
		if q.Has(name) {
			n, err := parseInt(name, q.Get(name))
			if err != nil {
				return err
			}
			*dst = n
		}
		return nil
	}
	uintInto := func(name string, dst *uint32) error {
		if q.Has(name) {
			n, err := parseInt(name, q.Get(name))
			if err != nil {
				return err
			}
			*dst = uint32(n)
		}
		return nil
	}

	var action int
	for _, e := range []error{
		uintInto("head", &req.Head),
		uintInto("outfit", &req.Outfit),
		uintInto("garment", &req.Garment),
		uintInto("weapon", &req.Weapon),
		uintInto("shield", &req.Shield),
		intInto("action", &action),
		intInto("bodyPalette", &req.BodyPalette),
		intInto("headPalette", &req.HeadPalette),
	} {
		if e != nil {
			return req, "", e
		}
	}
	req.Action = uint(action)

	// headgear: comma-separated ids (the engine uses up to 3).
	if q.Has("headgear") {
		for _, part := range splitCSV(q.Get("headgear")) {
			n, err := parseInt("headgear", part)
			if err != nil {
				return req, "", err
			}
			req.Headgear = append(req.Headgear, uint32(n))
		}
	}

	// headgearBehind: comma-separated headgear ids that should render behind the
	// character (effect-type accessories such as auras/halos).
	if q.Has("headgearBehind") {
		for _, part := range splitCSV(q.Get("headgearBehind")) {
			n, err := parseInt("headgearBehind", part)
			if err != nil {
				return req, "", err
			}
			req.HeadgearBehind = append(req.HeadgearBehind, uint32(n))
		}
	}

	if q.Has("gender") {
		n, err := parseEnum("gender", q.Get("gender"), map[string]int{"female": 0, "male": 1}, []int{0, 1})
		if err != nil {
			return req, "", err
		}
		req.Gender = rotype.Gender(n)
	} else {
		req.Gender = rotype.Male
	}

	// headdir enum. NOTE: these match zrenderer's real HeadDirection ordinals
	// (straight=0, left=1, right=2, all=3) — the previous map swapped left/right.
	if q.Has("headdir") {
		n, err := parseEnum("headdir", q.Get("headdir"),
			map[string]int{"straight": 0, "left": 1, "right": 2, "all": 3}, []int{0, 1, 2, 3})
		if err != nil {
			return req, "", err
		}
		req.HeadDir = rotype.HeadDirection(n)
	}

	if q.Has("madogearType") {
		n, err := parseEnum("madogearType", q.Get("madogearType"),
			map[string]int{"robot": 0, "unused": 1, "suit": 2}, []int{0, 1, 2})
		if err != nil {
			return req, "", err
		}
		req.Madogear = rotype.MadogearType(n)
	}

	if q.Has("enableShadow") {
		b, err := parseBool("enableShadow", q.Get("enableShadow"))
		if err != nil {
			return req, "", err
		}
		req.EnableShadow = b
	}

	// Skin tone (fan-made; the game has no such option). A preset id or a custom
	// base colour, never both — silently preferring one would hide a client bug.
	if q.Has("skinTone") && q.Has("skinColor") {
		return req, "", errors.New("'skinTone' and 'skinColor' cannot be combined; pass one or the other")
	}
	if q.Has("skinTone") {
		allowed := make([]int, 0, skin.PresetCount)
		for i := 1; i <= skin.PresetCount; i++ {
			allowed = append(allowed, i)
		}
		n, err := parseEnum("skinTone", q.Get("skinTone"), map[string]int{"default": 1}, allowed)
		if err != nil {
			return req, "", err
		}
		req.SkinTone = n
	}
	if q.Has("skinColor") {
		c, err := parseHexColor("skinColor", q.Get("skinColor"))
		if err != nil {
			return req, "", err
		}
		req.SkinColor = &c
	}

	req.Canvas = q.Get("canvas")

	// Still-vs-animation rule.
	switch {
	case q.Has("frame"):
		n, err := parseInt("frame", q.Get("frame"))
		if err != nil {
			return req, "", err
		}
		req.Frame = n
	case q.Has("action"):
		req.Frame = -1 // animation
	default:
		req.Frame = 0 // single still
	}

	ext := ".png"
	if q.Has("outputFormat") {
		n, err := parseEnum("outputFormat", q.Get("outputFormat"),
			map[string]int{"png": 0, "zip": 1}, []int{0, 1})
		if err != nil {
			return req, "", err
		}
		if n == 1 {
			ext = ".zip"
		}
	}

	return req, ext, nil
}

// ETagFor is a stable hash of the (canonicalized) query parameters: keys and
// repeated values sorted, empty values dropped. Identical query params — in any
// order — produce the same ETag. A render is fully determined by its query, so
// this doubles as a content validator for conditional requests.
func ETagFor(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var sb strings.Builder
	for _, k := range keys {
		vals := append([]string(nil), q[k]...)
		sort.Strings(vals)
		for _, v := range vals {
			if v == "" {
				continue
			}
			sb.WriteString(k)
			sb.WriteByte('=')
			sb.WriteString(v)
			sb.WriteByte('\n')
		}
	}
	sum := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(sum[:])
}

func splitCSV(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func parseInt(name, s string) (int, error) {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0, fmt.Errorf("'%s' must be an integer, got %q", name, s)
	}
	return n, nil
}

func parseBool(name, s string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	}
	return false, fmt.Errorf("'%s' must be a boolean (true/false), got %q", name, s)
}

func parseEnum(name, s string, names map[string]int, allowed []int) (int, error) {
	s = strings.TrimSpace(s)
	if v, ok := names[strings.ToLower(s)]; ok {
		return v, nil
	}
	if n, err := strconv.Atoi(s); err == nil {
		for _, a := range allowed {
			if n == a {
				return n, nil
			}
		}
	}
	keys := make([]string, 0, len(names))
	for k := range names {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return 0, fmt.Errorf("'%s' must be one of %v or %v, got %q", name, keys, allowed, s)
}

func parseHexColor(name, s string) (raster.Color, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "#")
	if len(s) != 6 {
		return raster.Color{}, fmt.Errorf("'%s' must be a 6-digit hex colour like 'c9a07f', got %q", name, s)
	}
	v, err := strconv.ParseUint(s, 16, 32)
	if err != nil {
		return raster.Color{}, fmt.Errorf("'%s' must be a 6-digit hex colour like 'c9a07f', got %q", name, s)
	}
	return raster.Color{R: uint8(v >> 16), G: uint8(v >> 8), B: uint8(v), A: 0xFF}, nil
}

// ETagForBytes derives a strong validator from content rather than from mtime
// and size, which is what the filesystem server uses. R2 has no mtime, and
// hashing the bytes is stable across re-uploads of identical content — so a
// re-sync that rewrites an unchanged file does not invalidate anyone's cache,
// and clients revalidate exactly once at cutover.
func ETagForBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:16])
}

// RootHelp is the plain-text index served at "/". It lives here so the server
// and the Worker serve identical bytes rather than two copies that drift apart.
const RootHelp = "ragassets-gateway — renders and serves Ragnarok Online sprites, icons, maps, and BGM.\n\n" +
	"Try: /image?job=1002            (still image)\n" +
	"     /image?job=1002&action=0   (animation, APNG)\n" +
	"     /gif?job=1002&action=0     (same, as an animated GIF)\n" +
	"     /icons/item/501.png        (static item/collection/skill/job/ui images)\n" +
	"     /illust/card/4001.png      (a card's full-size artwork)\n" +
	"     /effects/index.json        (effect-only costume catalogue)\n" +
	"     /effects/c_spot_light/effect.json   (one effect's .str animation + textures)\n" +
	"     /effects/sprites/torch_01/sprite.json  (one sprite map-effect's per-frame img/delay/offset)\n" +
	"     /effect/str?file=stormgust  (a skill effect's parsed .str keyframe animation, as JSON)\n" +
	"     /effect/texture?file=stormgust/storm_ball  (one .str layer texture, colorkeyed PNG)\n" +
	"     /effect/sound?file=effect/ef_portal  (one sound effect, browser-playable WAV)\n" +
	"     /effect/sound/index.json   (names present in the extracted sound tree)\n" +
	"     /effect/skill-map          (skillId → effectId(s) lookup, ported from roBrowser)\n" +
	"     /effect/table              (effectId → effect parts lookup, ported from roBrowser)\n" +
	"     /maps/index.json           (world-map catalogue for the map simulator)\n" +
	"     /maps/prontera/manifest.json  (one map's geometry + shared asset manifest)\n" +
	"     /bgm/index.json            (per-map background-music catalogue)\n" +
	"     /bgm/210.mp3               (one background-music track)\n" +
	"     /raw/mobs.json             (a prebuilt JSON data table)\n\n" +
	"See the README for every supported parameter.\n"
