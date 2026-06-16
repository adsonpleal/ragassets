package engine

import "regexp"

// Canvas is an explicit output frame with an origin point at which the sprite's
// (0,0) is placed. The zero Canvas means "auto-size to the sprite bounds".
type Canvas struct {
	Width   int
	Height  int
	OriginX int
	OriginY int
}

// IsZero reports whether no explicit canvas was requested.
func (c Canvas) IsZero() bool { return c == Canvas{} }

var canvasRe = regexp.MustCompile(`^([0-9]+)x([0-9]+)([+-][0-9]+)([+-][0-9]+)$`)

// ParseCanvas parses a "<w>x<h>±<x>±<y>" canvas string. An empty string yields
// the zero Canvas (auto-size). ok is false for malformed non-empty input.
func ParseCanvas(s string) (Canvas, bool) {
	if s == "" {
		return Canvas{}, true
	}
	m := canvasRe.FindStringSubmatch(s)
	if m == nil {
		return Canvas{}, false
	}
	return Canvas{
		Width:   atoi(m[1]),
		Height:  atoi(m[2]),
		OriginX: atoi(m[3]),
		OriginY: atoi(m[4]),
	}, true
}

func atoi(s string) int {
	neg := false
	i := 0
	if len(s) > 0 && (s[0] == '+' || s[0] == '-') {
		neg = s[0] == '-'
		i = 1
	}
	n := 0
	for ; i < len(s); i++ {
		n = n*10 + int(s[i]-'0')
	}
	if neg {
		return -n
	}
	return n
}
