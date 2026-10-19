// Placed footprints for cross-probing (BOM <-> 2D layers <-> 3D <-> schematic) and
// net highlight: ref, value, position, side, box, pads with nets. A pure parse of
// the board file (BoardInfo.footprints), published as parts.json (PartsData). [P2-b]

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { PartsData } from '../contract.ts'
import type { Stage } from './types.ts'

export interface PartsResult { file: string; bytes: number; count: number }

export const partsStage: Stage<PartsResult> = {
  name: 'parts',
  version: 'p1',
  inputs: ['pcb'],
  provides: ['crossProbe'],
  skip: i => (i.info.footprints.length ? null : 'the board has no footprints'),
  recipe: () => ({}),

  async run(ctx) {
    const footprints = ctx.info.footprints.filter(f => f.ref)
    const data: PartsData = { footprints, thickness: ctx.info.stackup.thickness }
    const text = JSON.stringify(data)
    await writeFile(join(ctx.outDir, 'parts.json'), text)
    return { result: { file: 'parts.json', bytes: Buffer.byteLength(text), count: footprints.length }, files: ['parts.json'] }
  },

  apply(board, r, url) {
    board.parts = { url: url(r.file), bytes: r.bytes }
  },
}
