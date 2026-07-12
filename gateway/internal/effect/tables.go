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
//   SkillMapJSON:   skill id   -> { effectId?, hitEffectId?, groundEffectId?, wav? }
//   EffectTableJSON: effect id -> [ { type, file, min, wav, attachedEntity, rand, ... } ]
//
// SkillMapJSON's `wav` (added by tools/gen-effect-tables.mjs's resolveSkillWav)
// is a de-duplicated array of GRF-relative sound names — same form as
// EffectTableJSON's `wav` field — verified against the extracted data/wav/
// tree (resources/sounds/index.json) at generation time, so every entry is
// guaranteed servable from /effect/sound. It covers skills whose effect has no
// wav in EffectTableJSON (most 3rd/4th-class skills) by falling back to the
// skill's own SKID constant name.
//
// Regenerate with: node tools/gen-effect-tables.mjs

//go:embed data/skill_map.json
var SkillMapJSON []byte

//go:embed data/effect_table.json
var EffectTableJSON []byte
