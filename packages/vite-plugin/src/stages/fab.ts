// Fabrication bundle (download link). A late stage: a build waits for it, the dev
// server pushes it to open pages when ready.
//
// - fab: 'generic'  -> backend.exportFab() (Gerbers X2, Excellon PTH/NPTH + maps,
//                      IPC-D-356, position CSVs, BOM CSV, schematic PDF, STEP), named
//                      <Name>-fab-<rev label>.zip, with every item's outcome. [P2-c]
// - fab: hook       -> the user's function builds the zip; it gets the board's rev. [phase 1]
// - fab: false      -> no downloads.
// Status: 'incomplete' (with what is missing) when a bare-board order item (Gerbers,
// drill, the outline) could not be produced.

import { createHash } from 'node:crypto'
import { copyFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { FabItem } from '@kiview/kicad'

import type { FabHookConfig, FabHookResult } from '../config.ts'
import type { BoardRevision } from '../contract.ts'
import { resolveRevision } from './revision.ts'
import type { Stage } from './types.ts'

export interface FabStageResult {
  file: string
  filename: string
  bytes: number
  status: 'ok' | 'incomplete'
  missing: string[]
  contents: string[]
  /** Generic bundle only. */
  items?: FabItem[]
}

const safeName = (s: string) => s.replace(/[^\w.+-]+/g, '_')

export const fabStage: Stage<FabStageResult> = {
  name: 'fab',
  version: 'f2',
  inputs: ['pcb', 'sch', 'pro'],
  provides: ['fab'],
  late: true,
  skip(i) {
    const fab = i.config.fab
    if (fab === false) return 'fabrication downloads are turned off (fab: false)'
    if (fab === 'generic' && !i.backend?.capabilities.ops.fab) return 'the generic fabrication bundle is not available with this KiCad backend yet'
    return null
  },
  async recipe(i) {
    const fab = i.config.fab
    const { label } = await resolveRevision(i)
    if (typeof fab !== 'object') return { fab, label, env: i.config.env }
    const r = fab.recipe ? await fab.recipe() : createHash('sha256').update(fab.build.toString()).digest('hex').slice(0, 16)
    return { hook: r, label, env: i.config.env }
  },

  async run(ctx) {
    const snap = await ctx.snapshot()
    const { state: _state, ...facts } = await resolveRevision(ctx)
    let res: (FabHookResult & { items?: FabItem[] }) | null
    if (ctx.config.fab === 'generic') {
      const zipName = safeName(`${ctx.src.name}-fab-${facts.label}.zip`)
      // warnings reach the log through op().warn already
      const r = await ctx.sem.run(() => ctx.backend!.exportFab(snap.pcb, { sch: snap.sch ?? undefined, zipName }, ctx.op()))
      res = { zip: r.zip, status: r.status, missing: r.missing, contents: r.contents, filename: zipName, items: r.items }
    } else {
      const rev: BoardRevision = { hash: ctx.hash, titleBlock: ctx.info.titleBlock.rev, version: facts.version, git: facts.git, label: facts.label }
      const hook = ctx.config.fab as FabHookConfig
      const out = await ctx.sem.run(() => hook.build({
        name: ctx.src.name, projectDir: ctx.src.dir, pcb: snap.pcb, sch: snap.sch, pro: snap.pro,
        workDir: ctx.workDir, backend: ctx.backend, hash: ctx.hash, rev, log: m => ctx.warn(m),
      }))
      res = typeof out === 'string' ? { zip: out } : out
    }
    if (!res) throw new Error('the fab hook returned no bundle')
    const filename = safeName(res.filename ?? basename(res.zip))
    await copyFile(res.zip, join(ctx.outDir, filename))
    return {
      result: {
        file: filename, filename, bytes: (await stat(join(ctx.outDir, filename))).size,
        status: res.status ?? 'ok', missing: res.missing ?? [], contents: res.contents ?? [],
        ...(res.items ? { items: res.items } : {}),
      },
      files: [filename],
    }
  },

  apply(board, r, url) {
    board.download = { url: url(r.file), filename: r.filename, bytes: r.bytes, status: r.status, missing: r.missing, contents: r.contents,
                       ...(r.items ? { items: r.items } : {}) }
  },
}
