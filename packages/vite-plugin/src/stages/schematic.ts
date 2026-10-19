// Schematic pages: one SVG per sheet instance (hierarchical sub-sheets included) and
// the sheet tree (names, paths, parent / child, page numbers, symbol boxes for
// cross-probing, sheet-symbol boxes for click-to-open). [P2-b]
//
// The tree ships inline in Board.schematic (it is small); sheets.json holds the same
// records for other tools.

import { rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SchematicSheet } from '@kiview/kicad'

import type { Stage } from './types.ts'

export interface SchematicResult {
  sheets: (Omit<SchematicSheet, 'file'> & { svg: string; bytes: number })[]
}

export const schematicStage: Stage<SchematicResult> = {
  name: 'schematic',
  version: 's2',
  inputs: ['sch', 'pro'],
  provides: ['schematic'],
  late: true,
  skip: i => (!i.src.sch ? 'the project has no .kicad_sch file'
    : i.backend?.capabilities.ops.schematicSvg ? null : 'the KiCad backend cannot plot schematics'),
  recipe: i => ({ ...i.config.schematic, env: i.config.env }),

  async run(ctx) {
    const snap = await ctx.snapshot()
    const { drawingSheet, theme } = ctx.config.schematic
    const raw = await ctx.sem.run(() => ctx.backend!.exportSchematicSvgs(snap.sch!, ctx.op(), { drawingSheet, ...(theme ? { theme } : {}) }))
    const sheets: SchematicResult['sheets'] = []
    for (const [i, { file, ...sh }] of raw.entries()) {
      const svg = `sheet-${i + 1}.svg`
      await rename(file, join(ctx.outDir, svg))
      sheets.push({ ...sh, svg, bytes: (await stat(join(ctx.outDir, svg))).size })
    }
    await writeFile(join(ctx.outDir, 'sheets.json'), JSON.stringify({ sheets }))
    return { result: { sheets }, files: [...sheets.map(s => s.svg), 'sheets.json'] }
  },

  apply(board, r, url) {
    board.schematic = { sheets: r.sheets.map(({ svg, bytes: _b, ...s }) => ({ ...s, url: url(svg) })) }
  },
}
