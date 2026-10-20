// [P2-d] A private copy of the project for checks (DRC, ERC): the snapshot files plus
// the project's custom design rules (<Name>.kicad_dru) and library tables, which the
// shared snapshot does not carry but which change what DRC / ERC report. Their
// content is part of the stage key through checkExtras().
//
// KiCad sets KIPRJMOD itself to the directory of the project it loads (here the copy),
// whatever `-D KIPRJMOD=` says, so a library table's `${KIPRJMOD}/...` URIs would
// resolve inside the work dir. The copied tables therefore name the source project
// directory instead (projectTable); other variables and plain relative URIs stay as
// they are.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { BoardSource, StageContext } from './types.ts'

const extraNames = (src: BoardSource) => [`${src.name}.kicad_dru`, 'fp-lib-table', 'sym-lib-table']

const isTable = (name: string) => name.endsWith('-lib-table')

/**
 * A library table with every `${KIPRJMOD}` (and `$(KIPRJMOD)`) replaced by `dir`, the
 * source project directory (forward slashes, quote-escaped for the S-expression string).
 * Anything else, including other variables, is left byte for byte.
 */
export function projectTable(text: string, dir: string): string {
  const abs = dir.replace(/\\/g, '/').replace(/"/g, '\\"')
  return text.replace(/\$\{KIPRJMOD\}|\$\(KIPRJMOD\)/g, () => abs)
}

/** The bytes an extra file has in the project copy (tables rewritten, the rest as is). */
function extraContent(src: BoardSource, name: string): Buffer | null {
  const p = join(src.dir, name)
  if (!existsSync(p)) return null
  const raw = readFileSync(p)
  if (!isTable(name)) return raw
  const text = raw.toString('utf8')
  const out = projectTable(text, src.dir)
  return out === text ? raw : Buffer.from(out, 'utf8')
}

/** Hash of the extra project files (custom rules, library tables as copied), for the recipe. */
export function checkExtras(src: BoardSource): Record<string, string> {
  const out: Record<string, string> = {}
  for (const n of extraNames(src)) {
    const c = extraContent(src, n)
    if (c) out[n] = createHash('sha256').update(c).digest('hex').slice(0, 16)
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
    const c = extraContent(ctx.src, n)
    if (c) await writeFile(join(dir, n), c)
  }
  return { dir, pcb: join(dir, basename(snap.pcb)), sch: snap.sch && join(dir, basename(snap.sch)) }
}
