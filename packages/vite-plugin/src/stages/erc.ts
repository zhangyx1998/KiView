// [P2-d] Electrical-rule check: `kicad-cli sch erc --format json` parsed into a
// CheckReport (positions in sheet mm plus the sheet path), published as erc.json.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { CheckReport } from '@kiview/kicad'

import type { CheckStageResult } from './drc.ts'
import { checkExtras, projectCopy } from './project-copy.ts'
import type { Stage } from './types.ts'

export const ercStage: Stage<CheckStageResult> = {
  name: 'erc',
  version: 'e1',
  inputs: ['sch', 'pro'],
  provides: ['erc'],
  late: true,
  skip: i => (!i.src.sch ? 'the project has no schematic'
    : i.backend?.capabilities.ops.erc ? null : 'the KiCad backend cannot run ERC'),
  recipe: i => ({ env: i.config.env, extras: checkExtras(i.src) }),

  async run(ctx) {
    const p = await projectCopy(ctx)
    const report: CheckReport = await ctx.sem.run(() => ctx.backend!.erc(p.sch!, ctx.op()))
    await writeFile(join(ctx.outDir, 'erc.json'), JSON.stringify(report))
    return { result: { file: 'erc.json', counts: report.counts }, files: ['erc.json'] }
  },

  apply(board, r, url) {
    board.reports = { ...board.reports, erc: { url: url(r.file), counts: r.counts } }
  },
}
