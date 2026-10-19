// 3D model of the board (VRML by default: it carries VRML-only part models; see
// docs/architecture.md "3D model findings").

import { rename } from 'node:fs/promises'
import { join } from 'node:path'

import { maskOverride, renderCopy } from './render-copy.ts'
import type { Stage } from './types.ts'

export interface ModelResult { file: string; format: 'vrml' | 'glb'; bytes: number }

export const modelStage: Stage<ModelResult> = {
  name: 'model',
  version: 'm1',
  inputs: ['pcb', 'pro'],
  provides: ['model3d'],
  skip: i => (i.backend?.capabilities.model3d.formats.includes(i.config.modelFormat)
    ? null : `the KiCad backend cannot export ${i.config.modelFormat}`),
  recipe: i => ({ format: i.config.modelFormat, mask: maskOverride(i), env: i.config.env, modelDir: i.backend?.install.modelDir }),

  async run(ctx) {
    const pcb = await renderCopy(ctx)
    const format = ctx.config.modelFormat
    const r = await ctx.sem.run(() => ctx.backend!.export3d(pcb, { format, noDnp: true }, ctx.op()))
    for (const w of r.warnings) ctx.warn(`model: ${w}`)
    const file = format === 'glb' ? 'model.glb' : 'model.wrl'
    await rename(r.file, join(ctx.outDir, file))
    return { result: { file, format, bytes: r.bytes }, files: [file] }
  },

  apply(board, r, url) {
    board.model = { url: url(r.file), format: r.format, bytes: r.bytes }
  },
}
