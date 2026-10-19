// Assembling the client Board (contract.ts) from what the pipeline holds: base
// facts from the board file, then each stage's result folded in by its apply().

import { relative } from 'node:path'

import { featureBlocker, FEATURES, titleFromName, type FeatureId } from '@kiview/kicad'

import type { Board, FeatureStatus } from './contract.ts'
import type { BoardEntry, Pipeline } from './pipeline.ts'
import { STAGES } from './stages/index.ts'

const round = (v: number) => Math.round(v * 1e4) / 1e4

export function assembleBoard(e: BoardEntry, p: Pipeline): Board {
  const { config } = p
  const { src } = e
  const info = e.input?.info ?? null
  const backend = e.input?.backend ?? null
  const hash = e.input?.hash ?? '?'
  const outline = info?.outline ?? null
  const m = config.margin
  const titleBlock = info?.titleBlock ?? { title: null, rev: null, date: null, company: null, comments: [] }

  const board: Board = {
    name: src.name,
    title: titleBlock.title ?? titleFromName(src.name),
    model: null,
    layers: [],
    bounds: outline
      ? { x: round(outline.x - m), y: round(outline.y - m), width: round(outline.width + 2 * m), height: round(outline.height + 2 * m) }
      : { x: 0, y: 0, width: 0, height: 0 },
    size: outline ? { width: round(outline.width), height: round(outline.height) } : { width: 0, height: 0 },
    thumbnail: null,
    copperLayers: info?.stackup.copperLayers ?? 0,
    revision: hash,
    maskColor: config.maskColor(src.name) ?? info?.stackup.maskColor.front ?? null,
    titleBlock,
    kicad: {
      formatVersion: info?.formatVersion ?? 0,
      minKicad: info?.minKicad ?? 0,
      exportedWith: backend?.version?.raw ?? null,
      backend: backend?.id ?? null,
    },
    files: {
      pcb: relative(config.root, src.pcb),
      sch: src.sch && relative(config.root, src.sch),
      pro: src.pro && relative(config.root, src.pro),
    },
    features: {} as Record<FeatureId, FeatureStatus>,
    rev: { hash, titleBlock: titleBlock.rev, version: null, git: null, label: titleBlock.rev ?? hash.slice(0, 7) },
    schematic: null,
    bom: null,
    parts: null,
    netlist: null,
    stats: null,
    reports: { drc: null, erc: null },
    bomOptions: { showDnp: config.bom.showDnp(src.name) },   // [assembly]
  }

  // features: what the backend and the project files allow, then the stage outcomes
  const files = { pcb: true, sch: !!src.sch }
  for (const id of Object.keys(FEATURES) as FeatureId[]) {
    const blocker = featureBlocker(id, backend?.capabilities ?? null, files)
    board.features[id] = blocker ? { available: false, reason: blocker } : { available: false, reason: 'not implemented yet' }
  }
  for (const stage of STAGES) {
    const s = e.stages.get(stage.name)
    if (s?.record) {
      const key = s.record.key
      stage.apply(board, s.record.result, f => p.assetUrl(src.name, stage.name, key, f))
    }
    const status: FeatureStatus = s?.record ? { available: true }
      : { available: false, reason: s?.skipped ?? (s?.error ? `export failed: ${s.error}` : 'not exported yet') }
    for (const f of stage.provides) board.features[f] = status
  }
  return board
}
