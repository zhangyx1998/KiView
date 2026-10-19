// Feature consistency: Board.features against the data fields and the capabilities.
//
// Rules (docs/ci.md, "The contract"):
//   1. A feature is available exactly when its data is there (FEATURE_DATA), and an
//      unavailable feature carries a reason.
//   2. A feature no stage provides is unavailable; its reason is the capability /
//      file blocker (featureBlocker) or "not implemented yet".
//   3. A feature a stage provides follows the stage: when the capabilities block it the
//      stage may still deliver it through a fallback (reported, not an error); when
//      nothing blocks it, it is available unless the stage skipped it (with the skip
//      reason) - an export failure is an error.

import { featureBlocker, FEATURES, type Capabilities, type FeatureId } from '@kiview/kicad'
import type { Board } from '@kiview/vite-plugin/contract'

/** Where each feature's data lives in a Board; true when present. */
export const FEATURE_DATA: Record<FeatureId, (b: Board) => boolean> = {
  layers: b => b.layers.length > 0,
  model3d: b => b.model !== null,
  thumbnail: b => b.thumbnail !== null,
  schematic: b => b.schematic !== null,
  bom: b => b.bom !== null,
  crossProbe: b => b.parts !== null,
  netlist: b => b.netlist !== null,
  fab: b => b.download !== undefined,
  drc: b => b.reports.drc !== null,
  erc: b => b.reports.erc !== null,
  stats: b => b.stats !== null,
}

export const FEATURE_IDS = Object.keys(FEATURES) as FeatureId[]

export interface FeatureContext {
  /** Capabilities of the backend that exported the board (null: no usable install). */
  caps: Capabilities | null
  /** Features some registered stage provides (STAGES[].provides). */
  provided: ReadonlySet<FeatureId>
  /** Per provided feature, the stage outcome when known (from Pipeline.status()). */
  stages?: Partial<Record<FeatureId, { skipped: string | null; error: string | null }>>
}

export interface FeatureFinding {
  feature: FeatureId
  level: 'error' | 'note'
  message: string
}

export function checkFeatures(board: Board, ctx: FeatureContext): FeatureFinding[] {
  const out: FeatureFinding[] = []
  const files = { pcb: true, sch: board.files.sch !== null }
  for (const id of FEATURE_IDS) {
    const status = board.features[id]
    const err = (message: string) => out.push({ feature: id, level: 'error', message })
    const note = (message: string) => out.push({ feature: id, level: 'note', message })
    if (!status) { err('missing from Board.features'); continue }
    const has = FEATURE_DATA[id](board)
    // rule 1
    if (status.available && !has) err('available, but its data is missing')
    if (!status.available && has) err(`unavailable ("${status.reason}"), but its data is present`)
    if (!status.available && !status.reason) err('unavailable without a reason')

    const blocker = featureBlocker(id, ctx.caps, files)
    if (!ctx.provided.has(id)) {
      // rule 2
      if (status.available) err('available, but no stage provides it')
      else if (blocker && status.reason !== blocker) err(`reason "${status.reason}", expected the blocker "${blocker}"`)
      else if (!blocker && status.reason !== 'not implemented yet') err(`reason "${status.reason}", expected "not implemented yet"`)
      continue
    }
    // rule 3
    const stage = ctx.stages?.[id]
    if (stage?.error) {
      if (status.available) note(`served from an earlier export; the last run failed: ${stage.error}`)
      else err(`export failed: ${stage.error}`)
      continue
    }
    if (status.available) {
      if (blocker) note(`delivered although the capabilities block it (${blocker}): a fallback`)
      continue
    }
    if (stage?.skipped) {
      if (status.reason !== stage.skipped) err(`reason "${status.reason}", the stage skipped with "${stage.skipped}"`)
      if (!blocker) note(`skipped although the capabilities allow it: ${stage.skipped}`)
      continue
    }
    if (blocker) continue
    err(`not exported although nothing blocks it (reason: "${status.reason}")`)
  }
  return out
}
