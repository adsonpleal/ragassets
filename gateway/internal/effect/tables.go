package effect

import _ "embed"

// The skill/effect lookup tables, ported verbatim from roBrowser's plain-data
// modules by tools/gen-effect-tables.mjs and embedded so the client can resolve
// skillId -> effectId(s) -> parts without shipping its own copy. They are served
// as-is (already valid JSON) by /effect/skill-map and /effect/table.
//
//   SkillMapJSON:   skill id   -> { effectId?, hitEffectId?, groundEffectId? }
//   EffectTableJSON: effect id -> [ { type, file, min, wav, attachedEntity, rand, ... } ]
//
// Regenerate with: node tools/gen-effect-tables.mjs

//go:embed data/skill_map.json
var SkillMapJSON []byte

//go:embed data/effect_table.json
var EffectTableJSON []byte
