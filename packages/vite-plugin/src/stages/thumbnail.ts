// Card thumbnail.
//   render     (backend has `pcb render`, KiCad 9+): isometric render of the front at
//              2x, cropped to the board and shrunk 2:1 in Node (no image dependencies)
//   composite  (otherwise, or when the render fails): a top view composed from the
//              F.Cu / F.Mask / F.SilkS / Edge.Cuts plots in the stackup colours, as
//              an SVG (thumbnail-composite.ts). Board.thumbnail is the same either way.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { decodePng, encodePng, trimAndShrink } from '@kiview/kicad'

import { maskOverride, renderCopy } from './render-copy.ts'
import { renderComposite } from './thumbnail-composite.ts'
import type { Stage, StageContext, StageInput, StageOutput } from './types.ts'

export interface ThumbnailStageResult { file: string; width: number; height: number }

const mode = (i: StageInput): 'render' | 'composite' | null =>
  i.backend?.capabilities.ops.thumbnail ? 'render' : i.backend?.capabilities.ops.layerSvg ? 'composite' : null

async function composite(ctx: StageContext): Promise<StageOutput<ThumbnailStageResult>> {
  const box = ctx.config.thumbnail as { width: number; height: number }
  const r = await renderComposite(ctx, maskOverride(ctx), box)
  await writeFile(join(ctx.outDir, 'thumbnail.svg'), r.svg)
  return { result: { file: 'thumbnail.svg', width: r.width, height: r.height }, files: ['thumbnail.svg'] }
}

export const thumbnailStage: Stage<ThumbnailStageResult> = {
  name: 'thumbnail',
  version: 't2',
  inputs: ['pcb', 'pro'],
  provides: ['thumbnail'],
  skip: i => (i.config.thumbnail === false ? 'thumbnails are turned off'
    : mode(i) ? null : 'the KiCad backend can neither render nor plot layers'),
  recipe: i => ({ mode: mode(i), size: i.config.thumbnail, mask: maskOverride(i), env: i.config.env, modelDir: i.backend?.install.modelDir }),

  async run(ctx) {
    if (mode(ctx) === 'composite') return composite(ctx)
    const { width, height } = ctx.config.thumbnail as { width: number; height: number }
    try {
      const pcb = await renderCopy(ctx)
      const r = await ctx.sem.run(() => ctx.backend!.renderThumbnail(pcb, { width: width * 2, height: height * 2 }, ctx.op()))
      const img = trimAndShrink(decodePng(await readFile(r.file)), 2)
      await writeFile(join(ctx.outDir, 'thumbnail.png'), encodePng(img))
      return { result: { file: 'thumbnail.png', width: img.width, height: img.height }, files: ['thumbnail.png'] }
    } catch (e) {
      // e.g. no OpenGL on a headless machine: a plotted top view is better than nothing
      if (!ctx.backend?.capabilities.ops.layerSvg) throw e
      ctx.warn(`render failed, using a layer composite: ${e instanceof Error ? e.message : String(e)}`)
      return composite(ctx)
    }
  },

  apply(board, r, url) {
    board.thumbnail = { url: url(r.file), width: r.width, height: r.height }
  },
}
