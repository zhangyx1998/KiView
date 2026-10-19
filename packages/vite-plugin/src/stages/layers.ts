// Layer SVGs: every layer plotted twice (with and without drill shapes), normalised
// onto one viewBox (outline + margin) with holes as real cut-outs (see
// @kiview/kicad svg.ts and docs/architecture.md "Layer SVGs").

import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { normaliseLayerSvg, selectLayers, type Rect } from '@kiview/kicad'

import type { BoardLayer } from '../contract.ts'
import type { Stage } from './types.ts'

const fileSafe = (id: string) => id.replace(/[^A-Za-z0-9]+/g, '_')
const round = (v: number) => Math.round(v * 1e4) / 1e4

export interface LayersResult {
  layers: (Omit<BoardLayer, 'url'> & { file: string })[]
  bounds: Rect
  copperLayers: number
}

export const layersStage: Stage<LayersResult> = {
  name: 'layers',
  version: 'l2',
  inputs: ['pcb', 'pro'],
  provides: ['layers'],
  skip: i => (i.backend?.capabilities.ops.layerSvg ? null : 'the KiCad backend cannot plot layers'),
  recipe: i => ({ margin: i.config.margin, env: i.config.env }),

  async run(ctx) {
    const { info, backend } = ctx
    const snap = await ctx.snapshot()
    const specs = selectLayers(info.layers, new Set(info.usedLayers))
    const ids = specs.map(l => l.id)
    const [withHoles, withoutHoles] = await Promise.all([
      ctx.sem.run(() => backend!.exportLayerSvgs(snap.pcb, ids, { holes: true }, ctx.op(join(ctx.workDir, 'a')))),
      ctx.sem.run(() => backend!.exportLayerSvgs(snap.pcb, ids, { holes: false }, ctx.op(join(ctx.workDir, 'b')))),
    ])
    const noHoleOf = new Map(withoutHoles.map(f => [f.layer, f.file]))
    const m = ctx.config.margin
    const outline = info.outline
    if (!outline) ctx.warn('no Edge.Cuts outline found; using the plotted page as bounds')
    let bounds: Rect | null = outline && { x: outline.x - m, y: outline.y - m, width: outline.width + 2 * m, height: outline.height + 2 * m }

    const layers: LayersResult['layers'] = []
    const specOf = new Map(specs.map(s => [s.id, s]))
    let order = 0
    for (const { layer, file: path } of withHoles) {
      const spec = specOf.get(layer)!
      const raw = await readFile(path, 'utf8')
      const other = noHoleOf.get(layer)
      if (!other) { ctx.warn(`layer ${layer}: no plot without holes (${basename(path)})`); continue }
      const rawNoHoles = await readFile(other, 'utf8')
      if (!bounds) {
        const vb = /viewBox="([^"]+)"/.exec(raw)?.[1]?.split(/\s+/).map(Number)
        bounds = vb && vb.length === 4 ? { x: vb[0]!, y: vb[1]!, width: vb[2]!, height: vb[3]! } : { x: 0, y: 0, width: 100, height: 100 }
      }
      const file = `${fileSafe(layer)}.svg`
      const { svg } = normaliseLayerSvg(raw, rawNoHoles, {
        viewBox: bounds, color: spec.color, layerId: layer, maskId: `holes-${fileSafe(ctx.src.name)}-${fileSafe(layer)}`,
      })
      await writeFile(join(ctx.outDir, file), svg)
      layers.push({ id: layer, name: spec.name, kind: spec.kind, side: spec.side, color: spec.color, order: order++, file })
    }
    if (!bounds || !layers.length) throw new Error('no layers exported')
    return {
      result: {
        layers,
        bounds: { x: round(bounds.x), y: round(bounds.y), width: round(bounds.width), height: round(bounds.height) },
        copperLayers: specs.filter(l => l.kind === 'copper').length,
      },
      files: layers.map(l => l.file),
    }
  },

  apply(board, r, url) {
    board.layers = r.layers.map(({ file, ...l }) => ({ ...l, url: url(file) }))
    board.bounds = r.bounds
    board.copperLayers = r.copperLayers
    if (board.size.width === 0) board.size = { width: r.bounds.width, height: r.bounds.height }
  },
}
