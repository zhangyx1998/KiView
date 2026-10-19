// [P2-d] A private copy of the project for checks (DRC, ERC): the snapshot files plus
// the project's custom design rules (<Name>.kicad_dru) and library tables, which the
// shared snapshot does not carry but which change what DRC / ERC report. Their
// content is part of the stage key through checkExtras().

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { BoardSource, StageContext } from './types.ts'

const extraNames = (src: BoardSource) => [`${src.name}.kicad_dru`, 'fp-lib-table', 'sym-lib-table']

/** Hash of the extra project files (custom rules, library tables), for the recipe. */
export function checkExtras(src: BoardSource): Record<string, string> {
  const out: Record<string, string> = {}
  for (const n of extraNames(src)) {
    const p = join(src.dir, n)
    if (existsSync(p)) out[n] = createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)
  }
  return out
}

/** Copy the snapshot and the extras into <workDir>/project; returns the copied paths. */
export async function projectCopy(ctx: StageContext): Promise<{ dir: string; pcb: string; sch: string | null }> {
  const snap = await ctx.snapshot()
  const dir = join(ctx.workDir, 'project')
  await mkdir(dir, { recursive: true })
  for (const f of await readdir(snap.dir)) if (/\.kicad_(pcb|pro|sch)$/.test(f)) await copyFile(join(snap.dir, f), join(dir, f))
  for (const n of extraNames(ctx.src)) {
    const p = join(ctx.src.dir, n)
    if (existsSync(p)) await copyFile(p, join(dir, n))
  }
  return { dir, pcb: join(dir, basename(snap.pcb)), sch: snap.sch && join(dir, basename(snap.sch)) }
}
