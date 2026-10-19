// Helpers shared by the backends.

import { readFile } from 'node:fs/promises'

import { readBoard } from '../board-file.ts'
import type { BoardInfo, Capabilities, KicadInstall, KicadVersion, OpContext, Operation } from '../types.ts'

/** Capabilities limited to the operations a backend implements so far. */
export function limitTo(c: Capabilities, implemented: ReadonlySet<Operation>): Capabilities {
  const ops = { ...c.ops }
  for (const k of Object.keys(ops) as Operation[]) ops[k] = ops[k] && implemented.has(k)
  return { ...c, ops }
}

/** File-parser board info, shared by all backends. */
export async function parseBoardFile(pcb: string): Promise<BoardInfo> {
  return readBoard(await readFile(pcb, 'utf8'))
}

/**
 * Path variables for a run: the stock 3D model library of the install as
 * KICAD6_3DMODEL_DIR .. KICAD<major>_3DMODEL_DIR (so footprints of every era find
 * their models), then the caller's variables, which win.
 */
export function pathVars(install: KicadInstall, version: KicadVersion | null, ctx: OpContext): Record<string, string> {
  const vars: Record<string, string> = {}
  if (install.modelDir) {
    const top = Math.max(10, version?.major ?? 10)
    for (let v = 6; v <= top; v++) vars[`KICAD${v}_3DMODEL_DIR`] = install.modelDir
  }
  return { ...vars, ...ctx.vars }
}

export const defineArgs = (vars: Record<string, string>): string[] =>
  Object.entries(vars).flatMap(([k, v]) => ['-D', `${k}=${v}`])

export const fileSafe = (id: string) => id.replace(/[^A-Za-z0-9]+/g, '_')
