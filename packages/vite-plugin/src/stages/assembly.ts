// Assembly-mode settings of a board: the config's `assembly` entry (side order, notes,
// per-part notes, step order, build variants) and the notes file next to the board
// (`ASSEMBLY.md` by default), into Board.assembly. No KiCad call and no published
// files: the resolved settings and the notes file's text are the recipe, so editing
// either re-keys the stage. The client builds the step list from the BOM and parts.

import { readFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'

import type { BoardAssembly } from '../contract.ts'
import type { Stage, StageInput } from './types.ts'

/** The board's assembly settings with the notes file read (null text when absent). */
export async function resolveAssembly(i: StageInput): Promise<BoardAssembly> {
  const a = i.config.assembly(i.src.name)
  const notes: BoardAssembly['notes'] = []
  if (a.notesFile) {
    const file = join(i.src.dir, a.notesFile)
    const text = await readFile(file, 'utf8').catch(() => null)
    // shown as its path from the root; a board outside the root as <board dir>/<file>
    const rel = relative(i.config.root, file)
    const source = rel.startsWith('..') ? join(basename(i.src.dir), a.notesFile) : rel
    if (text?.trim()) notes.push({ source: source.split('\\').join('/'), markdown: text })
  }
  if (a.notes?.trim()) notes.push({ source: 'config', markdown: a.notes })
  return {
    sideOrder: a.sideOrder === 'front-first' ? ['front', 'back'] : ['back', 'front'],
    notes,
    refNotes: a.refNotes,
    noteFields: a.noteFields,
    order: a.order,
    variants: Object.entries(a.variants).map(([id, v]) => ({
      id, label: v.label ?? id, fit: v.fit ?? [], dnp: v.dnp ?? [], values: v.values ?? {}, note: v.note ?? null,
    })),
  }
}

export const assemblyStage: Stage<BoardAssembly> = {
  name: 'assembly',
  version: 'a1',
  inputs: [],
  provides: [],
  recipe: i => resolveAssembly(i),
  async run(ctx) {
    return { result: await resolveAssembly(ctx), files: [] }
  },
  apply(board, r) {
    board.assembly = r
  },
}
