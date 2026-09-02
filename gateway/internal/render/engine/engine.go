package engine

import (
	"fmt"

	"github.com/ragassets/gateway/internal/render/geom"
	"github.com/ragassets/gateway/internal/render/raster"
	"github.com/ragassets/gateway/internal/render/resolve"
	"github.com/ragassets/gateway/internal/render/resource"
	"github.com/ragassets/gateway/internal/render/roformat"
	"github.com/ragassets/gateway/internal/render/rotype"
	"github.com/ragassets/gateway/internal/render/skin"
	"github.com/ragassets/gateway/internal/render/sprite"
)

// Request is a single render request (one job). Frame < 0 means "all frames"
// (animation). BodyPalette/HeadPalette < 0 mean "no palette override".
type Request struct {
	Job      uint32
	Gender   rotype.Gender
	Head     uint32
	Outfit   uint32
	Headgear []uint32
	// HeadgearBehind lists headgear ids that should render behind the character
	// (effect-type accessories such as auras/halos).
	HeadgearBehind []uint32
	Garment        uint32
	Weapon         uint32
	Shield         uint32
	Action         uint
	Frame          int
	BodyPalette    int
	HeadPalette    int
	HeadDir        rotype.HeadDirection
	Madogear       rotype.MadogearType
	EnableShadow   bool
	Canvas         string

	// SkinTone selects a generated skin-tone ramp (1..skin.PresetCount); 1 is the
	// untouched original. SkinColor, when non-nil, supersedes it with a ramp
	// generated from a custom colour. Both are ignored for Doram and non-player
	// jobs. Ragnarok Online has no skin-tone feature — this is fan-made.
	SkinTone  int
	SkinColor *raster.Color
}

// Result is the rendered output: one or more frames plus the action's frame
// interval (used for APNG timing).
type Result struct {
	Frames     []raster.RawImage
	IntervalMs float32
}

// Engine renders RO sprites in-process. It is safe for concurrent use (the
// resource Manager caches immutable parsed assets; per-request state is local).
type Engine struct {
	mgr    *resource.Manager
	ex     resource.Existence
	res    *resolve.Resolver
	tables resolve.Tables
}

// New builds an Engine reading assets from resourceRoot (the directory holding
// "data/") and resolving client IDs via tables (use resolve.NopTables{} for none).
func New(resourceRoot string, tables resolve.Tables) *Engine {
	return NewWithSource(
		resource.FSSource{Root: resourceRoot},
		resource.FSExistence{Root: resourceRoot},
		tables,
	)
}

// NewWithSource builds an Engine over an arbitrary resource Source and Existence.
// The filesystem case is just New; this is what a build serving from an object
// store uses, handing in a prefetched MapSource per render.
func NewWithSource(src resource.Source, ex resource.Existence, tables resolve.Tables) *Engine {
	if tables == nil {
		tables = resolve.NopTables{}
	}
	return &Engine{
		mgr:    resource.NewManagerWithSource(src, ex, resource.DefaultSprCacheBytes, resource.DefaultActCacheBytes),
		ex:     ex,
		res:    resolve.New(tables),
		tables: tables,
	}
}

// Plan resolves what a request needs without reading anything, so a caller can
// fetch those keys before calling RenderPlanned.
func (e *Engine) Plan(req Request) Plan {
	return BuildPlan(req, e.res, e.ex)
}

// Render produces the frames for a request.
// Render produces the frames for a request, resolving the plan itself. This is
// the direct path — it probes for existence as it goes, which is what you want
// against a local disk.
func (e *Engine) Render(req Request) (*Result, error) {
	return e.RenderPlanned(req, e.Plan(req))
}

// RenderPlanned renders a request against a pre-resolved Plan, so it never probes
// for a file's existence and never decides which candidate to use — those choices
// were made in BuildPlan. Every read goes through the Manager's Source, which a
// caller can have prefilled.
//
// Render and RenderPlanned are the same code path: Render just builds the plan
// first. That is deliberate — a second rendering path would be a second thing to
// keep pixel-identical, and the golden tests only guard one.
func (e *Engine) RenderPlanned(req Request, p Plan) (*Result, error) {
	canvas, ok := ParseCanvas(req.Canvas)
	if !ok {
		return nil, fmt.Errorf("invalid canvas %q", req.Canvas)
	}

	jobID := req.Job
	requestFrame := req.Frame

	var sprites []*sprite.Sprite
	var bodyImf *roformat.Imf
	var interval float32
	var err error

	if resolve.IsPlayer(jobID) {
		sprites, interval, err = e.processPlayer(req, p, &requestFrame)
		if err != nil {
			return nil, err
		}
		bodyImf = e.imfForJob(jobID, req.Gender, req.Madogear)
	} else {
		sprites, interval, err = e.processNonPlayer(req, &requestFrame)
		if err != nil {
			return nil, err
		}
	}
	if len(sprites) == 0 {
		return nil, fmt.Errorf("nothing to render for job %d", jobID)
	}

	if shouldDrawShadowFor(req.EnableShadow, jobID, req.Action) {
		if sh := e.shadowSprite(jobID); sh != nil {
			sprites = append(sprites, sh)
		}
	}

	sortDg := e.sortDelegate(sprites, req, bodyImf)

	frame := -1
	if requestFrame >= 0 {
		frame = requestFrame
	}
	frames := drawPlayer(sprites, req.Action, frame, sortDg, canvas)
	if len(frames) == 0 {
		return nil, fmt.Errorf("render produced no frames for job %d", jobID)
	}

	if resolve.IsBaby(jobID) {
		frames = raster.ApplyBabyScaling(frames, 0.75)
	}

	return &Result{Frames: frames, IntervalMs: interval}, nil
}

func containsU32(s []uint32, v uint32) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// getSprite loads ACT+SPR for a resolved name and wraps them in a Sprite.
func (e *Engine) getSprite(actName, sprName string, typ sprite.Type) (*sprite.Sprite, error) {
	act, err := e.mgr.Act(actName)
	if err != nil {
		return nil, err
	}
	spr, err := e.mgr.Spr(sprName)
	if err != nil {
		return nil, err
	}
	return sprite.New(act, spr, typ), nil
}

// processPlayer assembles the body, head, weapon(+slash), shield, headgears,
// garment and palettes for a player job. It does NOT collapse animations to a
// single frame for fixed head directions (the engine pins the head per-frame in
// drawPlayer instead).
func (e *Engine) processPlayer(req Request, p Plan, requestFrame *int) ([]*sprite.Sprite, float32, error) {
	jobID := req.Job
	g := req.Gender

	// Body — resolved in BuildPlan, along with whether the alternative outfit won.
	bodyName, useOutfit := p.Body, p.UseOutfit
	if bodyName == "" {
		return nil, 0, fmt.Errorf("could not resolve body sprite for job %d", jobID)
	}
	body, err := e.getSprite(bodyName, bodyName, sprite.TypePlayerBody)
	if err != nil {
		return nil, 0, fmt.Errorf("loading body %q: %w", bodyName, err)
	}

	interval := body.Act.Interval(int(req.Action))
	if body.Act.NumberOfFrames(int(req.Action)) <= 1 {
		// Single-frame actions (freeze/dead) must render their only frame.
		*requestFrame = 0
	}

	sprites := []*sprite.Sprite{body}

	// Head.
	var head *sprite.Sprite
	headName := e.res.PlayerHeadSprite(jobID, req.Head, g)
	if headName != "" {
		if h, err := e.getSprite(headName, headName, sprite.TypePlayerHead); err == nil {
			h.Parent = body
			h.HeadDir = req.HeadDir
			head = h
			sprites = append(sprites, h)
		}
	}

	// Weapon (+ slash). Madogear has only a weapon slash.
	if (req.Weapon > 0 || resolve.IsMadogear(jobID)) && jobID != resolve.NoJobID {
		if wpName := e.res.WeaponSprite(jobID, req.Weapon, g, req.Madogear); wpName != "" {
			if !resolve.IsMadogear(jobID) {
				if w, err := e.getSprite(wpName, wpName, sprite.TypeWeapon); err == nil {
					w.TypeOrder = 0
					sprites = append(sprites, w)
				}
			}
			if w, err := e.getSprite(wpName+"_검광", wpName+"_검광", sprite.TypeWeapon); err == nil {
				w.TypeOrder = 1
				sprites = append(sprites, w)
			}
		}
	}

	// Shield.
	if req.Shield > 0 && jobID != resolve.NoJobID {
		if shName := e.res.ShieldSprite(jobID, req.Shield, g); shName != "" {
			if sh, err := e.getSprite(shName, shName, sprite.TypeShield); err == nil {
				sprites = append(sprites, sh)
			}
		}
	}

	// Headgears (up to 3), parented to the body.
	if head != nil {
		for h := 0; h < len(req.Headgear) && h < 3; h++ {
			id := req.Headgear[h]
			if id == 0 {
				continue
			}
			hgName := e.res.HeadgearSprite(id, g)
			if hgName == "" {
				continue
			}
			// Loaded before the accessory itself, and independently of it: a
			// hat-effect costume's accessory sprite is blank by design, so its
			// visual would be lost if a failure to load that blank sprite skipped
			// the effect too.
			if fx := e.loadHatEffect(p.HatEffect[h]); fx != nil {
				fx.TypeOrder = h
				sprites = append(sprites, fx)
			}
			hg, err := e.getSprite(hgName, hgName, sprite.TypeAccessory)
			if err != nil {
				continue
			}
			hg.TypeOrder = h
			hg.Parent = body
			hg.HeadDir = req.HeadDir
			hg.AccessoryID = id
			// Behind is computed per direction in sortDelegate (TB_Layer_Priority).
			if resolve.IsDoram(jobID) {
				if x, y, ok := e.tables.DoramOffset(id, int(req.Action%8), g.Int()); ok {
					hg.OffsetAdjust = geom.Vec3{X: float32(x), Y: float32(y)}
				}
			}
			sprites = append(sprites, hg)
		}
	}

	// Garment (robe). Not parented (zrenderer note: garments aren't attached).
	if req.Garment > 0 && jobID != resolve.NoJobID && !resolve.IsMadogear(jobID) {
		if gm := e.loadGarment(p.Garment); gm != nil {
			sprites = append(sprites, gm)
		}
	}

	// Palettes. Skin runs after the dye so a requested tone wins: many body dye
	// palettes tint the skin ramp themselves, and the tone must override that.
	e.applyPalettes(req, body, head, useOutfit)
	applySkin(req, body, bodyName, head, headName)

	return sprites, interval, nil
}

// hatEffectYOffset raises a hat effect above the character's origin, the
// client's own offset for the one it ships (hatEffectTable → EffectTable id
// 1130, yOffset -50). RO screen pixels, +y down.
const hatEffectYOffset = -50

// loadHatEffect loads the looping sprite a hat-effect costume plays at the
// character's head, or nil when the headgear has no such sprite (almost always).
// Unlike an accessory it is not parented to the body: the client plays it as an
// effect at the character's position rather than pinning it to the body's
// per-frame attach point, so it keeps its own frame timeline and takes a fixed
// vertical offset instead.
//
// name is the sprite BuildPlan resolved for this headgear slot, or "" when it has
// none — the existence check happened there.
func (e *Engine) loadHatEffect(name string) *sprite.Sprite {
	if name == "" {
		return nil
	}
	fx, err := e.getSprite(name, name, sprite.TypeHatEffect)
	if err != nil {
		return nil
	}
	fx.OffsetAdjust = geom.Vec3{Y: hatEffectYOffset}
	return fx
}

// loadGarment loads the first of the planned candidate act/spr pairs that
// actually parses (different garment costumes use different folder layouts, and
// some pair a per-job act with a shared image bank). Falls back to zrenderer's
// split act/spr probing when no candidate is usable. Returns nil if unavailable.
//
// The existence filtering happened in BuildPlan; the fall-through on a *parse*
// failure stays here, because it depends on the bytes.
func (e *Engine) loadGarment(gp GarmentPlan) *sprite.Sprite {
	for _, c := range gp.Candidates {
		if g, err := e.getSprite(c.Act, c.Spr, sprite.TypeGarment); err == nil {
			return g
		}
	}

	// Last resort: zrenderer's korean→english act path + shared-fallback spr (may
	// pair an act and spr from different folders). Kept so garments that lack a
	// same-folder pair still render as they did before.
	if gp.FallbackAct == "" || gp.FallbackSpr == "" {
		return nil
	}
	if g, err := e.getSprite(gp.FallbackAct, gp.FallbackSpr, sprite.TypeGarment); err == nil {
		return g
	}
	return nil
}

// applyPalettes loads and assigns body/head palette overrides when requested.
func (e *Engine) applyPalettes(req Request, body, head *sprite.Sprite, useOutfit bool) {
	if req.BodyPalette > -1 && req.Job != resolve.NoJobID && body != nil {
		var path string
		if req.Outfit > 0 && useOutfit {
			path = e.res.BodyAltPalette(req.Job, req.BodyPalette, req.Gender, req.Outfit, req.Madogear)
		} else {
			path = e.res.BodyPalette(req.Job, req.BodyPalette, req.Gender, req.Madogear)
		}
		if path != "" {
			if pal, err := e.mgr.Pal(path); err == nil {
				body.Palette = pal
			}
		}
	}
	if req.HeadPalette > -1 && head != nil {
		path := e.res.HeadPalette(req.Job, req.Head, req.HeadPalette, req.Gender)
		if path != "" {
			if pal, err := e.mgr.Pal(path); err == nil {
				head.Palette = pal
			}
		}
	}
}

// requestTone resolves the request's skin params to a tone. ok is false when no
// recolouring is wanted — no params, or the identity preset.
func requestTone(req Request) (skin.Tone, bool) {
	if req.SkinColor != nil {
		return skin.FromColor(*req.SkinColor), true
	}
	t, ok := skin.Preset(req.SkinTone)
	if !ok || t.Identity() {
		return skin.Tone{}, false
	}
	return t, true
}

// applySkin recolours the skin ramp in the body/head palettes and repaints the
// face-highlight pixels whose palette index is shared with hair.
//
// This is a fan-made capability: Ragnarok Online has no skin-tone selector, and
// the ramps are generated by this gateway from the sprites' own palettes.
//
// A sprite missing from the baked table is skipped on its own — madogear and
// other fully suited bodies genuinely have no skin ramp, and the head should
// still recolour in that case.
func applySkin(req Request, body *sprite.Sprite, bodyName string, head *sprite.Sprite, headName string) {
	tone, ok := requestTone(req)
	if !ok || resolve.IsDoram(req.Job) || !resolve.IsPlayer(req.Job) {
		return
	}
	ramp := tone.Ramp()

	if body != nil && bodyName != "" {
		if slots, ok := skin.Body(bodyName); ok {
			body.Palette = recolorSkin(body.Palette, body.Spr.Palette(), slots, ramp)
		}
	}
	if head != nil && headName != "" {
		if ent, ok := skin.Head(headName); ok {
			head.Palette = recolorSkin(head.Palette, head.Spr.Palette(), ent.Skin, ramp)
			head.PixelOverrides = buildPixelOverrides(ent, tone)
		}
	}
}

// recolorSkin returns a private copy of the palette with the skin indices
// replaced. Copying is mandatory: with no dye requested the sprite's Palette is
// nil and the SPR's embedded palette must be seeded, and with a dye requested the
// palette is the resource manager's shared cached value, which must never be
// written in place.
func recolorSkin(pal, embedded roformat.Palette, slots []skin.SlotIndex, ramp [8]raster.Color) roformat.Palette {
	src := pal
	if src == nil {
		src = embedded
	}
	out := make(roformat.Palette, len(src))
	copy(out, src)
	for _, s := range slots {
		if s.Index >= 0 && s.Index < len(out) && s.Slot >= 0 && s.Slot < len(ramp) {
			out[s.Index] = ramp[s.Slot]
		}
	}
	return out
}

// buildPixelOverrides turns the baked runs into per-image paint lists. Each run's
// colour comes from its baked ramp position, so it follows the requested tone and
// never the hair dye — even though the pixels share hair's palette index. The
// offset slices are aliased from the embedded table, which is read-only.
func buildPixelOverrides(ent skin.HeadEntry, tone skin.Tone) map[int][]sprite.PixelRun {
	if len(ent.Px) == 0 {
		return nil
	}
	cache := make(map[float64]raster.Color, 4)
	out := make(map[int][]sprite.PixelRun, len(ent.Px))
	for img, runs := range ent.Px {
		list := make([]sprite.PixelRun, 0, len(runs))
		for _, r := range runs {
			c, ok := cache[r.Pos]
			if !ok {
				c = tone.ColorAt(r.Pos)
				cache[r.Pos] = c
			}
			list = append(list, sprite.PixelRun{Color: c, Offsets: r.Offsets})
		}
		out[img] = list
	}
	return out
}

// processNonPlayer assembles monster/NPC/homunculus/mercenary sprites.
func (e *Engine) processNonPlayer(req Request, requestFrame *int) ([]*sprite.Sprite, float32, error) {
	bodyName := e.res.NonPlayerSprite(req.Job)
	if bodyName == "" {
		return nil, 0, fmt.Errorf("could not resolve non-player sprite for job %d", req.Job)
	}
	body, err := e.getSprite(bodyName, bodyName, e.nonPlayerType(req.Job))
	if err != nil {
		return nil, 0, fmt.Errorf("loading non-player body %q: %w", bodyName, err)
	}
	interval := body.Act.Interval(int(req.Action))
	if body.Act.NumberOfFrames(int(req.Action)) <= 1 {
		*requestFrame = 0
	}
	sprites := []*sprite.Sprite{body}

	// Mercenaries carry a head + weapon + headgears (handled like players).
	if resolve.IsMercenary(req.Job) {
		mercGender := rotype.Male
		if req.Job-6017 <= 9 {
			mercGender = rotype.Female
		}
		if headName := e.res.PlayerHeadSprite(req.Job, req.Head, mercGender); headName != "" {
			if h, err := e.getSprite(headName, headName, sprite.TypePlayerHead); err == nil {
				h.Parent = body
				h.HeadDir = req.HeadDir
				sprites = append(sprites, h)
			}
		}
	}

	return sprites, interval, nil
}

func (e *Engine) nonPlayerType(jobID uint32) sprite.Type {
	switch {
	case resolve.IsNPC(jobID):
		return sprite.TypeNPC
	case resolve.IsMercenary(jobID):
		return sprite.TypeMercenary
	case resolve.IsHomunculus(jobID):
		return sprite.TypeHomunculus
	default:
		return sprite.TypeMonster
	}
}

// shadowSprite loads the shadow sprite scaled by the job's shadow factor, or nil.
func (e *Engine) shadowSprite(jobID uint32) *sprite.Sprite {
	sh, err := e.getSprite("shadow", "shadow", sprite.TypeShadow)
	if err != nil {
		return nil
	}
	sh.ZIndex = -1
	scale := e.tables.ShadowFactor(jobID)
	sh.ScaleOverride = &scale
	return sh
}

// shouldDrawShadowFor mirrors app.d shouldDrawShadow. A free function rather than
// a method because it reads nothing but its arguments, and BuildPlan needs it to
// decide whether the shadow sprite is worth fetching.
func shouldDrawShadowFor(enable bool, jobID uint32, action uint) bool {
	if !enable || jobID == resolve.NoJobID {
		return false
	}
	if resolve.IsPlayer(jobID) || resolve.IsMercenary(jobID) {
		pa := rotype.IntToPlayerAction(action)
		if pa == rotype.ActSit || pa == rotype.ActDead {
			return false
		}
	} else if !resolve.IsNPC(jobID) {
		if rotype.IntToMonsterAction(action) == rotype.MonDead {
			return false
		}
	}
	return true
}

// imfForJob loads the body IMF (head z-priority), or nil.
func (e *Engine) imfForJob(jobID uint32, g rotype.Gender, mado rotype.MadogearType) *roformat.Imf {
	if jobID == resolve.NoJobID {
		return nil
	}
	name := e.res.ImfName(jobID, g, mado)
	if name == "" {
		return nil
	}
	imf, err := e.mgr.Imf(name)
	if err != nil {
		return nil
	}
	return imf
}

// sortDelegate returns the per-frame z-order function. It recomputes each
// sprite's z-index for the requested frame (garments depend on action/frame via
// the client DrawOnTop table) and sorts indices ascending by z-index.
func (e *Engine) sortDelegate(sprites []*sprite.Sprite, req Request, bodyImf *roformat.Imf) sortFunc {
	direction := int(req.Action % 8)
	return func(index []int, frame, maxframes int) {
		f := frame
		pa := rotype.IntToPlayerAction(req.Action)
		if maxframes > 3 && (pa == rotype.ActStand || pa == rotype.ActSit) {
			f = frame / (maxframes - 1)
		}
		for i, s := range sprites {
			switch {
			case s.Type == sprite.TypeGarment:
				s.ZIndex = e.garmentZIndex(req, f, direction)
			case s.Type == sprite.TypeAccessory:
				// Per-direction behind/front from the client's layer-priority table
				// (so e.g. the Sun God's Ornament hangs behind you facing the camera
				// and in front when you face away).
				s.Behind = e.accessoryBehind(req, s.AccessoryID, direction)
				s.ZIndex = sprite.ZIndexForSprite(s, direction, -1, -1, nil)
			case s.Type == sprite.TypePlayerHead && bodyImf != nil:
				s.ZIndex = sprite.ZIndexForSprite(s, direction, int(req.Action), f, bodyImf)
			default:
				s.ZIndex = sprite.ZIndexForSprite(s, direction, -1, -1, nil)
			}
			index[i] = i
		}
		// Stable insertion sort by z-index (small slices; preserves input order
		// for equal keys, matching makeIndex's stability).
		for a := 1; a < len(index); a++ {
			for b := a; b > 0 && sprites[index[b-1]].ZIndex > sprites[index[b]].ZIndex; b-- {
				index[b-1], index[b] = index[b], index[b-1]
			}
		}
	}
}

// garmentZIndex mirrors sprite.d zIndexForGarmentSprite. _New_DrawOnTop reduces
// to a per-direction rule (verified against the client lua): a garment draws in
// front of the body for back-facing directions (2..6) and behind for the
// front-facing ones (0,1,7) — so a cape hangs behind you when you face the
// camera and over your back when you face away.
// accessoryBehind decides whether a headgear draws behind the body for the given
// facing direction. The client's TB_Layer_Priority table is authoritative (a
// negative per-direction priority means behind); the headgearBehind request param
// is a manual override that forces behind in all directions for ids the table
// doesn't cover.
func (e *Engine) accessoryBehind(req Request, accessoryID uint32, direction int) bool {
	if containsU32(req.HeadgearBehind, accessoryID) {
		return true
	}
	behind, _ := e.tables.HeadgearBehind(accessoryID, direction)
	return behind
}

func (e *Engine) garmentZIndex(req Request, frame, direction int) int {
	onTop := direction >= 2 && direction <= 6
	if onTop {
		if e.tables.IsTopLayer(req.Garment) {
			return 25
		}
		if sprite.IsTopLeftDir(direction) {
			return 16
		}
		return 11
	}
	return 5
}
