// [P2-d] Board statistics (Board.stats) and the copper geometry by net
// (Board.geometry -> geometry.json) for the layer browser's net highlight and
// measure tools. The numbers come from the board file, enriched by
// `kicad-cli pcb export stats` when the backend has it; the stage needs no KiCad
// otherwise. Late, so a slow kicad-cli never holds back the page.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { computeBoardStats, parseSExpr, readGeometry, type BoardStatsResult, type SExpr } from '@kiview/kicad'

import type { Stage } from './types.ts'

export interface StatsStageResult { stats: BoardStatsResult; geometry: { file: string; bytes: number } }

export const statsStage: Stage<StatsStageResult> = {
  name: 'stats',
  version: 's1',
  inputs: ['pcb', 'pro'],
  provides: ['stats'],
  late: true,
  recipe: i => ({ cli: !!i.backend?.capabilities.ops.stats, footprints: i.info.footprints.length > 0 }),

  async run(ctx) {
    const snap = await ctx.snapshot()
    const stats = ctx.backend?.capabilities.ops.stats
      ? await ctx.sem.run(() => ctx.backend!.stats(snap.pcb, ctx.op()))
      : computeBoardStats(ctx.contents.pcb, ctx.contents.pro)
    const root = parseSExpr(await readFile(snap.pcb, 'utf8')).find(e => Array.isArray(e) && e[0] === 'kicad_pcb') as SExpr[]
    const json = JSON.stringify(readGeometry(root, ctx.info.footprints))
    await writeFile(join(ctx.outDir, 'geometry.json'), json)
    return { result: { stats, geometry: { file: 'geometry.json', bytes: Buffer.byteLength(json) } }, files: ['geometry.json'] }
  },

  apply(board, r, url) {
    board.stats = r.stats
    board.geometry = { url: url(r.geometry.file), bytes: r.geometry.bytes }
  },
}
