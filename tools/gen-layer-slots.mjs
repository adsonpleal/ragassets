// Rebuild headgear view defaults from the client-derived raw/items.json.
// TB_Layer_Priority overrides take precedence in the renderer. Run from repo root:
//   node tools/gen-layer-slots.mjs [items.json] [layer_slots.json]
import fs from 'node:fs';
const itemsPath = process.argv[2] || 'resources/raw/items.json';
const outPath = process.argv[3] || 'gateway/internal/render/resolve/data/layer_slots.json';
const items = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
if (!Array.isArray(items)) throw new Error("items.json must contain an array");
const candidates = new Map();
for (const item of items) {
  if (item.viewKind !== 'headgear' || !item.spriteView) continue;
  const slots = item.equipSlots || [];
  // A combined headgear uses its uppermost occupied equipment slot.
  const priority = slots.includes('top') ? 200 : slots.includes('mid') ? 100 : slots.includes('low') ? 300 : 0;
  if (!priority) continue;
  const values = candidates.get(item.spriteView) || new Set();
  values.add(priority);
  candidates.set(item.spriteView, values);
}
const output = {};
const conflicts = [];
for (const [id, values] of [...candidates].sort((a,b) => a[0]-b[0])) {
  if (values.size !== 1) { conflicts.push(id); continue; }
  output[id] = [...values][0];
}
if (!Object.keys(output).length) throw new Error("no headgear slot metadata; refusing to replace the baked defaults");
fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
console.log(`Baked ${Object.keys(output).length} accessory slot defaults from client item metadata; conflicting views fall back to request slots: ${conflicts.join(', ') || 'none'}`);
