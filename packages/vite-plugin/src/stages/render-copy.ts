// The board copy the 3D model and the thumbnail are made from: the snapshot as is
// (stackup colours), or with the configured solder-mask colour written into it.

import { copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { withMaskColour } from '@kiview/kicad'

import type { StageContext, StageInput } from './types.ts'

/** The mask colour override for this board, or null to keep the stackup's. */
export const maskOverride = (i: StageInput): string | null => i.config.maskColor(i.src.name)

export async function renderCopy(ctx: StageContext): Promise<string> {
  const snap = await ctx.snapshot()
  const colour = maskOverride(ctx)
  if (!colour) return snap.pcb
  const pcb = join(ctx.workDir, 'render.kicad_pcb')
  await writeFile(pcb, withMaskColour(ctx.contents.pcb, colour))
  if (snap.pro) await copyFile(snap.pro, join(ctx.workDir, 'render.kicad_pro'))
  return pcb
}
