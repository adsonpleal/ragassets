package resolve

import "testing"

// stubTables answers like a client's name tables, for the ids it knows.
type stubTables struct {
	NopTables
	acc  map[uint32]string
	robe map[uint32]string
}

func (s stubTables) AccName(id uint32) string { return s.acc[id] }
func (s stubTables) RobeSprName(id uint32, english bool) string {
	return s.robe[id]
}

func TestSpriteNamesOverridesOnlyWhatItNames(t *testing.T) {
	base := stubTables{
		acc:  map[uint32]string{771: "_quepe_regional", 2696: "_something_else"},
		robe: map[uint32]string{132: "_latam_cape"},
	}
	s := SpriteNames{
		Tables: base,
		Acc:    map[uint32]string{2904: "_c_harword_doll_hat", 2696: "_c_foreign_hat"},
		Robe:   map[uint32]string{28: "c_2018_rtc_cape_tw"},
	}

	// The id this client does not know at all: without the override the
	// renderer draws no hat and still returns a PNG.
	if got := s.AccName(2904); got != "_c_harword_doll_hat" {
		t.Errorf("unknown id: got %q, want the override", got)
	}
	// The id this client knows as a *different* hat — the dangerous case, since
	// the picture looks right and is wrong.
	if got := s.AccName(2696); got != "_c_foreign_hat" {
		t.Errorf("colliding id: got %q, want the override to win", got)
	}
	// Everything not named still comes from the client's own tables.
	if got := s.AccName(771); got != "_quepe_regional" {
		t.Errorf("un-overridden id: got %q, want the table's answer", got)
	}
	if got := s.RobeSprName(28, false); got != "c_2018_rtc_cape_tw" {
		t.Errorf("garment override: got %q", got)
	}
	if got := s.RobeSprName(132, false); got != "_latam_cape" {
		t.Errorf("un-overridden garment: got %q", got)
	}
}

func TestSpriteNamesWithNoOverridesIsTransparent(t *testing.T) {
	base := stubTables{acc: map[uint32]string{771: "_quepe_regional"}}
	s := SpriteNames{Tables: base}
	if got := s.AccName(771); got != "_quepe_regional" {
		t.Errorf("got %q, want the table's answer", got)
	}
	if got := s.AccName(9999); got != "" {
		t.Errorf("an unknown id with no override is still unknown, got %q", got)
	}
	// An empty override is not an override: it must not shadow the table with "".
	s.Acc = map[uint32]string{771: ""}
	if got := s.AccName(771); got != "_quepe_regional" {
		t.Errorf("empty override should not shadow the table, got %q", got)
	}
}

func TestWithTablesReusesStaticTables(t *testing.T) {
	r := New(stubTables{acc: map[uint32]string{1: "_a"}})
	r2 := r.WithTables(stubTables{acc: map[uint32]string{1: "_b"}})
	if r2 == r {
		t.Fatal("WithTables should return a different Resolver")
	}
	// Job names and the rest are parsed once and shared, which is what makes
	// this cheap enough to do per request.
	if len(r2.static.jobNames) == 0 || len(r2.static.jobNames) != len(r.static.jobNames) {
		t.Errorf("static tables should be reused, got %d vs %d", len(r2.static.jobNames), len(r.static.jobNames))
	}
	if got := r2.HeadgearSprite(1, 1); got == r.HeadgearSprite(1, 1) {
		t.Errorf("the new Resolver should answer from the new tables, both gave %q", got)
	}
	if r.WithTables(nil) != r {
		t.Error("WithTables(nil) should be a no-op")
	}
}
