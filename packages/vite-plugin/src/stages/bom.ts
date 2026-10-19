// Bill of materials: grouped rows from the schematic's netlist (all fields, DNP and
// exclude-from-BOM flags), or from the board's footprints when there is no
// schematic. Published as bom.json (BomData). [P2-b]

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { BomRow } from '@kiview/kicad'

import type { BomData } from '../contract.ts'
import type { Stage } from './types.ts'

export interface BomResult { file: string; bytes: number; rows: number }

const FIRST = ['MPN', 'Manufacturer', 'LCSC']
const LAST = ['Description', 'Datasheet']

/** Field columns in display order: part numbers first, free text last, the rest by name. */
export function bomFields(rows: BomRow[]): string[] {
  const all = new Set(rows.flatMap(r => Object.keys(r.fields)))
  const rank = (f: string) => (FIRST.includes(f) ? FIRST.indexOf(f) - 100 : LAST.includes(f) ? 100 + LAST.indexOf(f) : 0)
  return [...all].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

export const bomStage: Stage<BomResult> = {
  name: 'bom',
  version: 'b1',
  inputs: ['sch', 'pcb'],
  provides: ['bom'],
  late: true,
  skip: i => (i.backend?.capabilities.ops.bom ? null : 'the KiCad backend cannot build a BOM'),
  recipe: () => ({ group: true }),

  async run(ctx) {
    const snap = await ctx.snapshot()
    const rows = await ctx.sem.run(() => ctx.backend!.exportBom(snap.sch ? { sch: snap.sch } : { pcb: snap.pcb }, { group: true }, ctx.op()))
    const data: BomData = { rows, fields: bomFields(rows) }
    const text = JSON.stringify(data)
    await writeFile(join(ctx.outDir, 'bom.json'), text)
    return { result: { file: 'bom.json', bytes: Buffer.byteLength(text), rows: rows.length }, files: ['bom.json'] }
  },

  apply(board, r, url) {
    board.bom = { url: url(r.file), bytes: r.bytes }
  },
}
