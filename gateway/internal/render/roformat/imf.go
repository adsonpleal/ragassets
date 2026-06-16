package roformat

// Imf is a parsed .imf file. It encodes, per layer/action/frame, a priority used
// to decide head-vs-body draw order. The renderer only consults
// priority(layer=1, action, frame). data is indexed [layer][action][frame].
type Imf struct {
	Ver  float32
	data [][][]int32
}

// ParseImf parses a .imf file buffer. It tolerates truncation by stopping early;
// out-of-range Priority lookups return -1, matching zrenderer.
func ParseImf(buf []byte) (*Imf, error) {
	r := newReader(buf)
	m := &Imf{}
	m.Ver = r.f32()
	r.skip(4) // checksum, unused

	maxLayer := int(r.u32())
	m.data = make([][][]int32, maxLayer+1)
	for layer := 0; layer <= maxLayer; layer++ {
		numActions := int(r.u32())
		m.data[layer] = make([][]int32, numActions)
		for action := 0; action < numActions; action++ {
			numFrames := int(r.u32())
			m.data[layer][action] = make([]int32, numFrames)
			for frame := 0; frame < numFrames; frame++ {
				m.data[layer][action][frame] = r.i32()
				r.skip(8) // cx, cy, unused
			}
		}
		if r.err != nil {
			break
		}
	}
	if r.err != nil {
		return nil, r.err
	}
	return m, nil
}

// Priority returns the priority for (layer, action, frame), or -1 if out of range.
func (m *Imf) Priority(layer, action, frame int) int {
	if m == nil || layer < 0 || layer >= len(m.data) ||
		action < 0 || action >= len(m.data[layer]) ||
		frame < 0 || frame >= len(m.data[layer][action]) {
		return -1
	}
	return int(m.data[layer][action][frame])
}
