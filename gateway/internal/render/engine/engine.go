package engine

import (
	"fmt"

	"github.com/ragassets/zrenderer-gateway/internal/render/geom"
	"github.com/ragassets/zrenderer-gateway/internal/render/raster"
	"github.com/ragassets/zrenderer-gateway/internal/render/resolve"
	"github.com/ragassets/zrenderer-gateway/internal/render/resource"
	"github.com/ragassets/zrenderer-gateway/internal/render/roformat"
	"github.com/ragassets/zrenderer-gateway/internal/render/rotype"
	"github.com/ragassets/zrenderer-gateway/internal/render/sprite"
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
	res    *resolve.Resolver
	tables resolve.Tables
}

// New builds an Engine reading assets from resourceRoot (the directory holding
// "data/") and resolving client IDs via tables (use resolve.NopTables{} for none).
func New(resourceRoot string, tables resolve.Tables) *Engine {
	if tables == nil {
		tables = resolve.NopTables{}
	}
	return &Engine{
		mgr:    resource.NewManager(resourceRoot),
		res:    resolve.New(tables),
		tables: tables,
	}
}

// Render produces the frames for a request.
func (e *Engine) Render(req Request) (*Result, error) {
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
		sprites, interval, err = e.processPlayer(req, &requestFrame)
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

	if e.shouldDrawShadow(req.EnableShadow, jobID, req.Action) {
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
func (e *Engine) processPlayer(req Request, requestFrame *int) ([]*sprite.Sprite, float32, error) {
	jobID := req.Job
	g := req.Gender

	// Body.
	bodyName, useOutfit := e.resolveBody(req)
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
	if headName := e.res.PlayerHeadSprite(jobID, req.Head, g); headName != "" {
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
		if gm := e.loadGarment(req); gm != nil {
			sprites = append(sprites, gm)
		}
	}

	// Palettes.
	e.applyPalettes(req, body, head, useOutfit)

	return sprites, interval, nil
}

// resolveBody picks the body sprite path, preferring an alternative outfit when
// one exists. Returns "" when unresolved.
func (e *Engine) resolveBody(req Request) (name string, useOutfit bool) {
	if req.Outfit > 0 {
		alt := e.res.PlayerBodyAltSprite(req.Job, req.Gender, req.Outfit, req.Madogear)
		if alt != "" && e.mgr.ExistsAct(alt) && e.mgr.ExistsSpr(alt) {
			return alt, true
		}
	}
	return e.res.PlayerBodySprite(req.Job, req.Gender, req.Madogear), false
}

// loadGarment resolves the garment to the first candidate path where both the
// .act and .spr exist (a matched pair — different garment costumes use different
// folder layouts), and loads it. Falls back to zrenderer's split act/spr probing
// only if no complete same-folder pair is found. Returns nil if unavailable.
func (e *Engine) loadGarment(req Request) *sprite.Sprite {
	for _, base := range e.res.GarmentCandidates(req.Job, req.Garment, req.Gender) {
		if e.mgr.ExistsAct(base) && e.mgr.ExistsSpr(base) {
			if g, err := e.getSprite(base, base, sprite.TypeGarment); err == nil {
				return g
			}
		}
	}

	// Last resort: zrenderer's korean→english act path + shared-fallback spr (may
	// pair an act and spr from different folders). Kept so garments that lack a
	// same-folder pair still render as they did before.
	actName := e.res.GarmentSprite(req.Job, req.Garment, req.Gender, false, false)
	if actName == "" {
		return nil
	}
	sprName := actName
	if !e.mgr.ExistsAct(actName) {
		actName = e.res.GarmentSprite(req.Job, req.Garment, req.Gender, true, false)
		sprName = actName
	}
	if !e.mgr.ExistsSpr(sprName) {
		sprName = e.res.GarmentSprite(req.Job, req.Garment, req.Gender, false, true)
	}
	if g, err := e.getSprite(actName, sprName, sprite.TypeGarment); err == nil {
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

// shouldDrawShadow mirrors app.d shouldDrawShadow.
func (e *Engine) shouldDrawShadow(enable bool, jobID uint32, action uint) bool {
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
