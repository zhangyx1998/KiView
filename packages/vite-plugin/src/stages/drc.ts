// [P2-d] Design-rule check: `kicad-cli pcb drc --format json` (with schematic parity
// when the project has a schematic) parsed into a CheckReport, published as drc.json.
// Late: DRC of a big board takes a while and does not hold back the page.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { CheckReport, Severity } from '@kiview/kicad'

import { checkExtras, projectCopy } from './project-copy.ts'
import type { Stage } from './types.ts'

export interface CheckStageResult { file: string; counts: Record<Severity, number> }

export const drcStage: Stage<CheckStageResult> = {
  name: 'drc',
  version: 'd1',
  inputs: ['pcb', 'sch', 'pro'],
  provides: ['drc'],
  late: true,
  skip: i => (i.backend?.capabilities.ops.drc ? null : 'the KiCad backend cannot run DRC'),
  recipe: i => ({ env: i.config.env, extras: checkExtras(i.src) }),

  async run(ctx) {
    const p = await projectCopy(ctx)
    const report: CheckReport = await ctx.sem.run(() => ctx.backend!.drc(p.pcb, { sch: p.sch ?? undefined }, ctx.op()))
    await writeFile(join(ctx.outDir, 'drc.json'), JSON.stringify(report))
    return { result: { file: 'drc.json', counts: report.counts }, files: ['drc.json'] }
  },

  apply(board, r, url) {
    board.reports = { ...board.reports, drc: { url: url(r.file), counts: r.counts } }
  },
}
