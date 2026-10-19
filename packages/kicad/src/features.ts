// Graceful degradation: each UI feature declares the operations (and project files)
// it needs; the plugin evaluates them per board and the client hides what is
// unavailable (Board.features in the client contract).

import type { Capabilities, FeatureId, FeatureRequirement } from './types.ts'

export const FEATURES: Record<FeatureId, FeatureRequirement> = {
  layers: { requires: ['layerSvg'], needsFiles: ['pcb'] },
  model3d: { requires: ['model3d'], needsFiles: ['pcb'] },
  thumbnail: { requires: ['thumbnail'], needsFiles: ['pcb'] },
  schematic: { requires: ['schematicSvg'], needsFiles: ['sch'] },
  bom: { requires: ['bom'] },
  crossProbe: { requires: ['boardInfo', 'bom'], needsFiles: ['pcb'] },
  netlist: { requires: ['netlist'], needsFiles: ['sch'] },
  fab: { requires: ['fab'], needsFiles: ['pcb'] },
  drc: { requires: ['drc'], needsFiles: ['pcb'] },
  erc: { requires: ['erc'], needsFiles: ['sch'] },
  stats: { requires: ['stats'], needsFiles: ['pcb'] },
}

/** null when the feature can be offered, else a short reason. */
export function featureBlocker(id: FeatureId, caps: Capabilities | null, files: { pcb: boolean; sch: boolean }): string | null {
  const req = FEATURES[id]
  for (const f of req.needsFiles ?? []) if (!files[f]) return `the project has no .kicad_${f} file`
  if (!caps) return 'no usable KiCad install'
  const missing = req.requires.filter(op => !caps.ops[op])
  return missing.length ? `the KiCad backend cannot do: ${missing.join(', ')}` : null
}
