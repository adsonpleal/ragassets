// Command gen-tables bakes the committed JSON lookup tables into Go source.
//
// The JSON files stay the reviewable artifact — cmd/gen-resolver and
// cmd/gen-skin-table still produce them, and a client update still shows up as a
// readable diff. This tool is the second step: it turns them into Go data so the
// gateway never parses JSON at startup.
//
// That matters for two reasons:
//
//   - encoding/json needs reflection, which is the single biggest obstacle to
//     compiling the render path for a WebAssembly target.
//   - the embedded tables are 352 KB and were unmarshalled in init(), a cost paid
//     on every cold start. On a long-lived server that is invisible; per isolate
//     it is not.
//
// The two large string tables (accname, jobName) become sorted key/value arrays
// searched with sort.Search — fully static data, zero init work. The smaller
// structured tables stay map literals, where the shape is fiddly and 500-odd
// entries of init cost do not repay the generator complexity.
//
// Run from the gateway module root:
//
//	go run ./cmd/gen-tables
//
// Regenerate whenever internal/render/{resolve,skin}/data/*.json change. The
// staleness tests in those packages fail if you forget.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/format"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
)

const (
	resolveDir = "internal/render/resolve"
	skinDir    = "internal/render/skin"
)

type rawTables struct {
	AccName    map[string]string `json:"accname"`
	Robe       map[string]string `json:"robe"`
	RobeEng    map[string]string `json:"robeEng"`
	Weapon     map[string]string `json:"weapon"`
	RealWeapon map[string]uint32 `json:"realWeapon"`
	JobName    map[string]string `json:"jobName"`
	IsTopLayer map[string]bool   `json:"isTopLayer"`
}

type rawLayerPriority struct {
	Default *int           `json:"default"`
	Dir     map[string]int `json:"dir"`
}

type rawSkinTable struct {
	Version int                `json:"version"`
	Base    []string           `json:"base"`
	Body    map[string][]int   `json:"body"`
	Head    map[string]rawHead `json:"head"`
}

type rawHead struct {
	Skin []int              `json:"skin"`
	Px   map[string][][]int `json:"px"`
}

func main() {
	log.SetFlags(0)
	if err := run(); err != nil {
		log.Fatalf("gen-tables: %v", err)
	}
}

func run() error {
	if err := genResolve(); err != nil {
		return err
	}
	return genSkin()
}

// ---------------------------------------------------------------------------
// resolve

func genResolve() error {
	var t rawTables
	if err := readJSON(filepath.Join(resolveDir, "data", "tables.json"), &t); err != nil {
		return err
	}
	var lp map[string]rawLayerPriority
	if err := readJSON(filepath.Join(resolveDir, "data", "layer_priority.json"), &lp); err != nil {
		return err
	}

	var b bytes.Buffer
	header(&b, "resolve", "cmd/gen-tables from data/tables.json and data/layer_priority.json")

	// Large tables: sorted parallel arrays, binary-searched.
	writeStringTable(&b, "accName", t.AccName)
	writeStringTable(&b, "jobName", t.JobName)
	writeStringTable(&b, "robe", t.Robe)
	writeStringTable(&b, "robeEng", t.RobeEng)
	writeStringTable(&b, "weapon", t.Weapon)

	// realWeapon: uint32 -> uint32.
	{
		keys := sortedUintKeys(mapKeys(t.RealWeapon))
		fmt.Fprintf(&b, "\n// realWeapon maps a weapon id to the id whose sprite it actually uses.\nvar realWeaponKeys = []uint32{")
		for i, k := range keys {
			sep(&b, i)
			fmt.Fprintf(&b, "%d", k)
		}
		b.WriteString("}\n\nvar realWeaponVals = []uint32{")
		for i, k := range keys {
			sep(&b, i)
			fmt.Fprintf(&b, "%d", t.RealWeapon[strconv.FormatUint(uint64(k), 10)])
		}
		b.WriteString("}\n")
	}

	// isTopLayer: only the true ids are stored — a missing id already reads as
	// false, so the false entries carry no information.
	{
		var trues []uint32
		for k, v := range t.IsTopLayer {
			if !v {
				continue
			}
			id, err := strconv.ParseUint(k, 10, 32)
			if err != nil {
				continue
			}
			trues = append(trues, uint32(id))
		}
		sort.Slice(trues, func(i, j int) bool { return trues[i] < trues[j] })
		fmt.Fprintf(&b, "\n// topLayerIDs holds only the accessories flagged true; absence means false,\n// so the explicit false entries in the JSON carry no information.\nvar topLayerIDs = []uint32{")
		for i, k := range trues {
			sep(&b, i)
			fmt.Fprintf(&b, "%d", k)
		}
		b.WriteString("}\n")
	}

	// layerPriority: a map literal. ~500 entries with one or two direction
	// overrides each — not worth flattening.
	{
		keys := sortedUintKeys(mapKeys(lp))
		b.WriteString("\n// layerPriorityTable is TB_Layer_Priority: an optional default plus\n// per-direction overrides. A negative effective value draws behind the body.\nvar layerPriorityTable = map[uint32]layerPriority{\n")
		for _, k := range keys {
			v := lp[strconv.FormatUint(uint64(k), 10)]
			fmt.Fprintf(&b, "\t%d: {", k)
			if v.Default != nil {
				fmt.Fprintf(&b, "def: %d, hasDefault: true", *v.Default)
			}
			if len(v.Dir) > 0 {
				if v.Default != nil {
					b.WriteString(", ")
				}
				b.WriteString("dir: map[int]int{")
				dirKeys := make([]int, 0, len(v.Dir))
				for dk := range v.Dir {
					d, err := strconv.Atoi(dk)
					if err != nil {
						continue
					}
					dirKeys = append(dirKeys, d)
				}
				sort.Ints(dirKeys)
				for i, d := range dirKeys {
					sep(&b, i)
					fmt.Fprintf(&b, "%d: %d", d, v.Dir[strconv.Itoa(d)])
				}
				b.WriteString("}")
			}
			b.WriteString("},\n")
		}
		b.WriteString("}\n")
	}

	return writeGo(filepath.Join(resolveDir, "tables_baked_gen.go"), b.Bytes())
}

// writeStringTable emits sorted key/value arrays for a uint32 -> string map.
func writeStringTable(b *bytes.Buffer, name string, m map[string]string) {
	keys := sortedUintKeys(mapKeys(m))
	fmt.Fprintf(b, "\nvar %sKeys = []uint32{", name)
	for i, k := range keys {
		sep(b, i)
		fmt.Fprintf(b, "%d", k)
	}
	fmt.Fprintf(b, "}\n\nvar %sVals = []string{", name)
	for i, k := range keys {
		sep(b, i)
		fmt.Fprintf(b, "%q", m[strconv.FormatUint(uint64(k), 10)])
	}
	b.WriteString("}\n")
}

// ---------------------------------------------------------------------------
// skin

func genSkin() error {
	var st rawSkinTable
	if err := readJSON(filepath.Join(skinDir, "data", "skin_table.json"), &st); err != nil {
		return err
	}

	var b bytes.Buffer
	header(&b, "skin", "cmd/gen-tables from data/skin_table.json")

	fmt.Fprintf(&b, "\n// bakedVersion is the schema version of the JSON this file was generated from.\nconst bakedVersion = %d\n", st.Version)

	// body: path -> []SlotIndex
	{
		paths := sortedStringKeys(mapKeys(st.Body))
		b.WriteString("\nvar bodyTable = map[string][]SlotIndex{\n")
		for _, p := range paths {
			fmt.Fprintf(&b, "\t%q: {", p)
			writeSlots(&b, st.Body[p])
			b.WriteString("},\n")
		}
		b.WriteString("}\n")
	}

	// head: path -> HeadEntry{Skin, Px}
	{
		paths := sortedStringKeys(mapKeys(st.Head))
		b.WriteString("\nvar headTable = map[string]HeadEntry{\n")
		for _, p := range paths {
			h := st.Head[p]
			fmt.Fprintf(&b, "\t%q: {Skin: []SlotIndex{", p)
			writeSlots(&b, h.Skin)
			b.WriteString("}")
			if len(h.Px) > 0 {
				b.WriteString(", Px: map[int][]Run{")
				imgs := sortedIntKeys(mapKeys(h.Px))
				for i, img := range imgs {
					sep(&b, i)
					fmt.Fprintf(&b, "%d: {", img)
					for j, run := range h.Px[strconv.Itoa(img)] {
						sep(&b, j)
						// run is [srcIndex, pos*1000, offsets...]
						fmt.Fprintf(&b, "{SrcIndex: %d, Pos: %s, Offsets: []int32{", run[0], formatMilli(run[1]))
						for k, o := range run[2:] {
							sep(&b, k)
							fmt.Fprintf(&b, "%d", o)
						}
						b.WriteString("}}")
					}
					b.WriteString("}")
				}
				b.WriteString("}")
			} else {
				// Px is documented as present-but-empty for heads needing no repaint.
				b.WriteString(", Px: map[int][]Run{}")
			}
			b.WriteString("},\n")
		}
		b.WriteString("}\n")
	}

	return writeGo(filepath.Join(skinDir, "table_baked_gen.go"), b.Bytes())
}

func writeSlots(b *bytes.Buffer, flat []int) {
	for i := 0; i+1 < len(flat); i += 2 {
		sep(b, i)
		fmt.Fprintf(b, "{Index: %d, Slot: %d}", flat[i], flat[i+1])
	}
}

// formatMilli renders pos/1000 as an exact Go float literal. The JSON stores
// thousandths as an integer, so dividing at generation time keeps the constant
// exact rather than leaving a division for init.
func formatMilli(milli int) string {
	return strconv.FormatFloat(float64(milli)/1000, 'g', -1, 64)
}

// ---------------------------------------------------------------------------
// helpers

func header(b *bytes.Buffer, pkg, src string) {
	fmt.Fprintf(b, "// Code generated by %s. DO NOT EDIT.\n\npackage %s\n", src, pkg)
}

func sep(b *bytes.Buffer, i int) {
	if i > 0 {
		b.WriteString(", ")
	}
}

func mapKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func sortedUintKeys(keys []string) []uint32 {
	out := make([]uint32, 0, len(keys))
	for _, k := range keys {
		id, err := strconv.ParseUint(k, 10, 32)
		if err != nil {
			continue
		}
		out = append(out, uint32(id))
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func sortedIntKeys(keys []string) []int {
	out := make([]int, 0, len(keys))
	for _, k := range keys {
		n, err := strconv.Atoi(k)
		if err != nil {
			continue
		}
		out = append(out, n)
	}
	sort.Ints(out)
	return out
}

func sortedStringKeys(keys []string) []string {
	sort.Strings(keys)
	return keys
}

func readJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	return nil
}

func writeGo(path string, src []byte) error {
	formatted, err := format.Source(src)
	if err != nil {
		// Write the unformatted source so the syntax error is inspectable.
		os.WriteFile(path+".broken", src, 0o644)
		return fmt.Errorf("format %s: %w (unformatted output at %s.broken)", path, err, path)
	}
	if err := os.WriteFile(path, formatted, 0o644); err != nil {
		return err
	}
	log.Printf("wrote %s (%d bytes)", path, len(formatted))
	return nil
}
