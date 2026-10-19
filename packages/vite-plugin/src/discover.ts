// Board discovery. `boards` entries are directories or globs (relative to the root):
//   directory: <dir>/<Name>.kicad_pcb and every <dir>/<Name>/<Name>.kicad_pcb
//   glob:      every matching .kicad_pcb (or .kicad_pro, meaning its board)
// The board name is the file stem; a clash gets a numeric suffix (and a warning).

import { existsSync } from 'node:fs'
import { glob, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import type { BoardSource } from './stages/types.ts'

const PCB = '.kicad_pcb'

function source(pcb: string): BoardSource {
  const dir = dirname(pcb)
  const name = basename(pcb, PCB)
  const sch = join(dir, name + '.kicad_sch')
  const pro = join(dir, name + '.kicad_pro')
  return { name, dir, pcb, sch: existsSync(sch) ? sch : null, pro: existsSync(pro) ? pro : null }
}

const IGNORED = /(^|[\\/])(node_modules|\.kiview|\.git)([\\/]|$)|-backups([\\/]|$)/

const isGlob = (s: string) => /[*?[\]{}]/.test(s)

export async function discoverBoards(root: string, entries: string[], warn: (m: string) => void): Promise<BoardSource[]> {
  const pcbs = new Set<string>()
  for (const entry of entries) {
    if (isGlob(entry)) {
      for await (const f of glob(entry, { cwd: root, exclude: p => IGNORED.test(p) })) {
        const abs = resolve(root, f)
        if (abs.endsWith(PCB)) pcbs.add(abs)
        else if (abs.endsWith('.kicad_pro') && existsSync(abs.slice(0, -'.kicad_pro'.length) + PCB)) pcbs.add(abs.slice(0, -'.kicad_pro'.length) + PCB)
      }
      continue
    }
    const dir = resolve(root, entry)
    const own = join(dir, basename(dir) + PCB)
    if (existsSync(own)) pcbs.add(own)
    for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const sub = join(dir, name)
      if (name.endsWith(PCB)) { pcbs.add(sub); continue }
      const pcb = join(sub, name + PCB)
      if (existsSync(pcb) && (await stat(sub)).isDirectory()) pcbs.add(pcb)
    }
  }
  const out: BoardSource[] = []
  const names = new Set<string>()
  for (const pcb of [...pcbs].sort()) {
    const s = source(pcb)
    if (names.has(s.name)) {
      let i = 2
      while (names.has(`${s.name}-${i}`)) i++
      warn(`two boards named ${s.name}; ${pcb} is listed as ${s.name}-${i}`)
      s.name = `${s.name}-${i}`
    }
    names.add(s.name)
    out.push(s)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Project files whose change affects a board (dev watching). */
export const isProjectFile = (f: string, extra: readonly string[] = []) =>
  /\.kicad_(pcb|sch|pro)$/.test(f) || basename(f) === 'VERSION' || basename(f) === 'ASSEMBLY.md' || extra.includes(basename(f))
