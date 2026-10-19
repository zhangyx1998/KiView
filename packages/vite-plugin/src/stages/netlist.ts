// Nets and their nodes (refdes + pin) from the schematic, published as netlist.json
// (NetlistData). Net highlight [P2-d] joins these with the pads' nets in parts.json. [P2-b]

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { NetlistData } from '../contract.ts'
import type { Stage } from './types.ts'

export interface NetlistResult { file: string; bytes: number; nets: number }

export const netlistStage: Stage<NetlistResult> = {
  name: 'netlist',
  version: 'n1',
  inputs: ['sch'],
  provides: ['netlist'],
  late: true,
  skip: i => (!i.src.sch ? 'the project has no .kicad_sch file'
    : i.backend?.capabilities.ops.netlist ? null : 'the KiCad backend cannot export a netlist'),
  recipe: () => ({}),

  async run(ctx) {
    const snap = await ctx.snapshot()
    const data: NetlistData = await ctx.sem.run(() => ctx.backend!.netlist(snap.sch!, ctx.op()))
    const text = JSON.stringify(data)
    await writeFile(join(ctx.outDir, 'netlist.json'), text)
    return { result: { file: 'netlist.json', bytes: Buffer.byteLength(text), nets: data.nets.length }, files: ['netlist.json'] }
  },

  apply(board, r, url) {
    board.netlist = { url: url(r.file), bytes: r.bytes }
  },
}
