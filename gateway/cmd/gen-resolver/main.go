// Command gen-resolver turns the TSV dumps produced by dump.lua into the
// embedded resolver table JSON consumed at runtime (resolve/data/tables.json).
//
// It decodes the hex-encoded EUC-KR (Windows-949) names to UTF-8 and lowercases
// them, exactly as zrenderer does (fromWindows949 → toUTF8 → toLower). Non-player
// job names additionally get backslashes converted to forward slashes, matching
// resolver.d's substitute("\\", dirSeparator).
//
// Usage: gen-resolver <dump_dir> <out_json>
package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/text/encoding/korean"
)

type tablesJSON struct {
	AccName    map[string]string `json:"accname"`
	Robe       map[string]string `json:"robe"`
	RobeEng    map[string]string `json:"robeEng"`
	Weapon     map[string]string `json:"weapon"`
	RealWeapon map[string]uint32 `json:"realWeapon"`
	JobName    map[string]string `json:"jobName"`
	IsTopLayer map[string]bool   `json:"isTopLayer"`
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: gen-resolver <dump_dir> <out_json>")
		os.Exit(2)
	}
	dumpDir, outPath := os.Args[1], os.Args[2]

	t := tablesJSON{
		AccName:    map[string]string{},
		Robe:       map[string]string{},
		RobeEng:    map[string]string{},
		Weapon:     map[string]string{},
		RealWeapon: map[string]uint32{},
		JobName:    map[string]string{},
		IsTopLayer: map[string]bool{},
	}

	// id <tab> hexname
	forEachLine(dumpDir, "accname.tsv", func(f []string) {
		if len(f) == 2 {
			t.AccName[f[0]] = decodeName(f[1], false)
		}
	})
	// id <tab> english(bool) <tab> hexname
	forEachLine(dumpDir, "robe.tsv", func(f []string) {
		if len(f) == 3 {
			name := decodeName(f[2], false)
			if f[1] == "true" {
				t.RobeEng[f[0]] = name
			} else {
				t.Robe[f[0]] = name
			}
		}
	})
	forEachLine(dumpDir, "weapon.tsv", func(f []string) {
		if len(f) == 2 {
			t.Weapon[f[0]] = decodeName(f[1], false)
		}
	})
	// id <tab> realid
	forEachLine(dumpDir, "realweapon.tsv", func(f []string) {
		if len(f) == 2 {
			if v, err := strconv.ParseUint(f[1], 10, 32); err == nil {
				t.RealWeapon[f[0]] = uint32(v)
			}
		}
	})
	// Non-player job names get backslash → slash substitution.
	forEachLine(dumpDir, "jobname.tsv", func(f []string) {
		if len(f) == 2 {
			t.JobName[f[0]] = decodeName(f[1], true)
		}
	})
	forEachLine(dumpDir, "istoplayer.tsv", func(f []string) {
		if len(f) >= 1 {
			t.IsTopLayer[f[0]] = true
		}
	})

	out, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		fatal(err)
	}
	if err := os.WriteFile(outPath, append(out, '\n'), 0o644); err != nil {
		fatal(err)
	}
	fmt.Printf("wrote %s: accname=%d robe=%d/%d weapon=%d realweapon=%d jobname=%d istoplayer=%d\n",
		outPath, len(t.AccName), len(t.Robe), len(t.RobeEng), len(t.Weapon),
		len(t.RealWeapon), len(t.JobName), len(t.IsTopLayer))
}

var eucDecoder = korean.EUCKR.NewDecoder()

// decodeName hex-decodes EUC-KR bytes, converts to UTF-8 and lowercases. When
// slashify is set, backslashes become forward slashes (non-player job names).
func decodeName(h string, slashify bool) string {
	raw, err := hex.DecodeString(h)
	if err != nil {
		return ""
	}
	utf8, err := eucDecoder.Bytes(raw)
	if err != nil {
		// Fall back to the raw bytes if decoding fails (shouldn't happen).
		utf8 = raw
	}
	s := strings.ToLower(string(utf8))
	if slashify {
		s = strings.ReplaceAll(s, "\\", "/")
	}
	return s
}

func forEachLine(dir, name string, fn func(fields []string)) {
	f, err := os.Open(filepath.Join(dir, name))
	if err != nil {
		fmt.Fprintf(os.Stderr, "skip %s: %v\n", name, err)
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		fn(strings.Split(line, "\t"))
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
