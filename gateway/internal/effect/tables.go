package effect

import _ "embed"

// The skill/effect lookup tables, ported from roBrowserLegacy's plain-data
// modules (github.com/MrAntares/roBrowserLegacy: SkillConst/SkillEffect/EffectTable)
// by tools/gen-effect-tables.mjs and embedded so the client can resolve
// skillId -> effectId(s) -> parts without shipping its own copy. They are served
// as-is (already valid JSON) by /effect/skill-map and /effect/table. Both come from
// the same source so their effect-id numbering is consistent (it shifted between
// roBrowser versions). See the generator header for the source rationale (the
// client's own skilleffectinfolist.lub covers only ~66 scripted skills).
//
//   SkillMapJSON:   skill id   -> { effectId?, hitEffectId?, groundEffectId? }
//   EffectTableJSON: effect id -> [ { type, file, min, wav, attachedEntity, rand, ... } ]
//
// Regenerate with: node tools/gen-effect-tables.mjs

//go:embed data/skill_map.json
var SkillMapJSON []byte

//go:embed data/effect_table.json
var EffectTableJSON []byte
