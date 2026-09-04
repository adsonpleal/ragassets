package engine

import (
	"github.com/ragassets/gateway/internal/render/resolve"
	"github.com/ragassets/gateway/internal/render/resource"
	"github.com/ragassets/gateway/internal/render/rotype"
)

// A Plan is everything a render needs to decide before it reads a single byte:
// the full set of resource keys it may touch, plus the three decisions that are
// currently made mid-render by probing the filesystem.
//
// Why this exists: the engine resolves what to load lazily, interleaving "does
// this file exist?" with "parse this file". That is fine against a local disk and
// unworkable against an object store, where each probe is a network round trip —
// a garment request alone can test a dozen candidate pairs before it finds one.
// Splitting the decision out means a caller can resolve the whole key set up
// front, fetch it in one batch, and hand the engine bytes it can read
// synchronously.
//
// Building a Plan needs no file contents, only Existence. Every name comes from
// the baked resolver tables; nothing downstream of a file *read* changes which
// files are needed. The only content-dependent branches in a render
// (Act.NumberOfFrames() <= 1 collapsing to a single frame, Spr.Palette() during
// skin recolouring, and the z-order delegate) all consume bytes that are already
// in hand by then.
type Plan struct {
	// Keys is every resource key the render may read, deduplicated. Some may not
	// exist — the engine tries a few speculatively and tolerates the miss, just as
	// it does today — so a fetcher is free to skip keys its Existence rejects.
	Keys []string

	// Body is the resolved body sprite name, and UseOutfit records whether the
	// alternative-outfit variant won. UseOutfit also selects which palette
	// applyPalettes reaches for, so it has to be decided here rather than re-probed.
	Body      string
	UseOutfit bool

	// Garment carries every candidate that passed the existence check, in
	// priority order, rather than just the winner. loadGarment falls through to
	// the next candidate when a pair exists but fails to parse, and collapsing
	// that to a single choice would quietly change which garment renders.
	Garment GarmentPlan

	// HatEffect holds the hat-effect sprite name per headgear slot, or "" where
	// the headgear has none (almost always).
	HatEffect [3]string
}

// GarmentPlan is the precomputed result of loadGarment's candidate walk.
type GarmentPlan struct {
	// Candidates passed both existence checks, in the resolver's priority order.
	Candidates []resolve.GarmentPath
	// FallbackAct/FallbackSpr are loadGarment's last resort: the korean→english
	// act path paired with a shared-fallback spr, which may come from a different
	// folder. Empty when there is no fallback to try.
	FallbackAct string
	FallbackSpr string
}

// planBuilder accumulates keys while walking the same decisions the engine makes.
type planBuilder struct {
	res *resolve.Resolver
	ex  resource.Existence

	keys map[string]struct{}
	out  []string
}

func (b *planBuilder) add(keys ...string) {
	for _, k := range keys {
		if _, seen := b.keys[k]; seen {
			continue
		}
		b.keys[k] = struct{}{}
		b.out = append(b.out, k)
	}
}

// addSprite records the act/spr pair a getSprite call would read.
func (b *planBuilder) addSprite(actName, sprName string) {
	if actName == "" || sprName == "" {
		return
	}
	b.add(resource.Key("sprite", actName, "act"), resource.Key("sprite", sprName, "spr"))
}

func (b *planBuilder) addPal(name string) {
	if name != "" {
		b.add(resource.Key("palette", name, "pal"))
	}
}

func (b *planBuilder) addImf(name string) {
	if name != "" {
		b.add(resource.Key("imf", name, "imf"))
	}
}

// hasPair reports whether both halves of a sprite exist — the existence test the
// engine performs before committing to a candidate.
func (b *planBuilder) hasPair(actName, sprName string) bool {
	return b.ex.Has(resource.Key("sprite", actName, "act")) &&
		b.ex.Has(resource.Key("sprite", sprName, "spr"))
}

// BuildPlan resolves a request into the keys it needs and the decisions that
// depend on which files exist. It performs no reads. The resolver already carries
// the baked tables, so every name it derives comes from res alone.
//
// It mirrors processPlayer, processNonPlayer, applyPalettes, imfForJob and
// shadowSprite. When those change, this must change with them — the golden tests
// run both paths against the same references, so a divergence surfaces as a
// render difference rather than silently.
func BuildPlan(req Request, res *resolve.Resolver, ex resource.Existence) Plan {
	b := &planBuilder{res: res, ex: ex, keys: map[string]struct{}{}}
	var p Plan

	jobID := req.Job
	if resolve.IsPlayer(jobID) {
		b.planPlayer(req, &p)
		if jobID != resolve.NoJobID {
			b.addImf(res.ImfName(jobID, req.Gender, req.Madogear))
		}
	} else {
		b.planNonPlayer(req)
	}

	// shouldDrawShadow depends only on the job and action, never on file contents.
	if shouldDrawShadowFor(req.EnableShadow, jobID, req.Action) {
		b.addSprite("shadow", "shadow")
	}

	p.Keys = b.out
	return p
}

func (b *planBuilder) planPlayer(req Request, p *Plan) {
	jobID := req.Job
	g := req.Gender

	// Body — the one probe whose outcome also steers palette selection.
	p.Body, p.UseOutfit = b.resolveBody(req)
	if p.Body == "" {
		// Unresolvable; the engine will fail on it. Nothing to fetch.
		return
	}
	b.addSprite(p.Body, p.Body)

	headName := b.res.PlayerHeadSprite(jobID, req.Head, g)
	b.addSprite(headName, headName)

	if (req.Weapon > 0 || resolve.IsMadogear(jobID)) && jobID != resolve.NoJobID {
		if wp := b.res.WeaponSprite(jobID, req.Weapon, g, req.Madogear); wp != "" {
			if !resolve.IsMadogear(jobID) {
				b.addSprite(wp, wp)
			}
			b.addSprite(wp+"_검광", wp+"_검광")
		}
	}

	if req.Shield > 0 && jobID != resolve.NoJobID {
		sh := b.res.ShieldSprite(jobID, req.Shield, g)
		b.addSprite(sh, sh)
	}

	// Headgears are only loaded when a head resolved, matching processPlayer.
	if headName != "" {
		for h := 0; h < len(req.Headgear) && h < 3; h++ {
			id := req.Headgear[h]
			if id == 0 {
				continue
			}
			if hg := b.res.HeadgearSprite(id, g); hg != "" {
				// The hat effect is probed and loaded independently of the
				// accessory itself, because a hat-effect costume's accessory
				// sprite is blank by design.
				if fx := b.res.HatEffectSprite(id); fx != "" && b.hasPair(fx, fx) {
					p.HatEffect[h] = fx
					b.addSprite(fx, fx)
				}
				b.addSprite(hg, hg)
			}
		}
	}

	if req.Garment > 0 && jobID != resolve.NoJobID && !resolve.IsMadogear(jobID) {
		p.Garment = b.planGarment(req)
		for _, c := range p.Garment.Candidates {
			b.addSprite(c.Act, c.Spr)
		}
		b.addSprite(p.Garment.FallbackAct, p.Garment.FallbackSpr)
	}

	// Palettes. The body palette depends on the outfit decision above.
	if req.BodyPalette > -1 && jobID != resolve.NoJobID {
		if req.Outfit > 0 && p.UseOutfit {
			b.addPal(b.res.BodyAltPalette(jobID, req.BodyPalette, g, req.Outfit, req.Madogear))
		} else {
			b.addPal(b.res.BodyPalette(jobID, req.BodyPalette, g, req.Madogear))
		}
	}
	if req.HeadPalette > -1 && headName != "" {
		b.addPal(b.res.HeadPalette(jobID, req.Head, req.HeadPalette, g))
	}
}

// planNonPlayer does not set Plan.Body: only processPlayer reads it, and
// processNonPlayer resolves the same name for itself. Writing it here would leave
// a field that is correct only by accident on one of the two paths.
func (b *planBuilder) planNonPlayer(req Request) {
	bodyName := b.res.NonPlayerSprite(req.Job)
	if bodyName == "" {
		return
	}
	b.addSprite(bodyName, bodyName)

	if resolve.IsMercenary(req.Job) {
		mercGender := rotype.Male
		if req.Job-6017 <= 9 {
			mercGender = rotype.Female
		}
		head := b.res.PlayerHeadSprite(req.Job, req.Head, mercGender)
		b.addSprite(head, head)
	}
}

// resolveBody mirrors Engine.resolveBody.
func (b *planBuilder) resolveBody(req Request) (name string, useOutfit bool) {
	if req.Outfit > 0 {
		alt := b.res.PlayerBodyAltSprite(req.Job, req.Gender, req.Outfit, req.Madogear)
		if alt != "" && b.hasPair(alt, alt) {
			return alt, true
		}
	}
	return b.res.PlayerBodySprite(req.Job, req.Gender, req.Madogear), false
}

// planGarment mirrors Engine.loadGarment's candidate walk and fallback chain,
// keeping every candidate that passed rather than only the first.
func (b *planBuilder) planGarment(req Request) GarmentPlan {
	var gp GarmentPlan
	for _, c := range b.res.GarmentCandidates(req.Job, req.Garment, req.Gender) {
		if b.hasPair(c.Act, c.Spr) {
			gp.Candidates = append(gp.Candidates, c)
		}
	}

	actName := b.res.GarmentSprite(req.Job, req.Garment, req.Gender, false, false)
	if actName == "" {
		return gp
	}
	sprName := actName
	if !b.ex.Has(resource.Key("sprite", actName, "act")) {
		actName = b.res.GarmentSprite(req.Job, req.Garment, req.Gender, true, false)
		sprName = actName
	}
	if !b.ex.Has(resource.Key("sprite", sprName, "spr")) {
		sprName = b.res.GarmentSprite(req.Job, req.Garment, req.Gender, false, true)
	}
	gp.FallbackAct, gp.FallbackSpr = actName, sprName
	return gp
}
