// The stage registry. Order matters only for display; stages run concurrently.
// Phase 2 adds its stages here (one line each):
//   [P2-c] revisionStage (git / VERSION into Board.rev), the generic fab in cli-modern
//   [P2-d] statsStage ('stats'), drcStage ('drc'), ercStage ('erc')
//   [P2-b] schematicStage, bomStage, partsStage ('crossProbe'), netlistStage

import { drcStage } from './drc.ts'
import { ercStage } from './erc.ts'
import { fabStage } from './fab.ts'
import { layersStage } from './layers.ts'
import { modelStage } from './model.ts'
import { statsStage } from './stats.ts'
import { thumbnailStage } from './thumbnail.ts'
import { bomStage } from './bom.ts'
import { netlistStage } from './netlist.ts'
import { partsStage } from './parts.ts'
import { schematicStage } from './schematic.ts'
import type { Stage } from './types.ts'

import { diffStage } from './diff.ts'          // [P2-c]
import { revisionStage } from './revision.ts'  // [P2-c]
import { assemblyStage } from './assembly.ts'  // [assembly]

export const STAGES: Stage<any>[] = [layersStage, modelStage, thumbnailStage, fabStage,
  revisionStage, diffStage,  // [P2-c]
  statsStage, drcStage, ercStage,   // [P2-d]
  schematicStage, bomStage, partsStage, netlistStage,   // [P2-b]
  assemblyStage,   // [assembly]
]
