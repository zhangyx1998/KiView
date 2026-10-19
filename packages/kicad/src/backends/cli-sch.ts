// Schematic operations through kicad-cli (`sch export svg | netlist`), shared by the
// kicad-cli backends (KiCad 7+ have both commands). [P2-b]
//
//   schematic SVGs  one `sch export svg` call for all sheets; files are matched to
//                   sheet instances by kicad-cli's naming ("<root>-<name>-<name>.svg"),
//                   then by page order; the hierarchy comes from the .kicad_sch files
//                   (schematic.ts).
//   netlist / BOM   one `sch export netlist` (kicadsexpr) call, parsed by netlist.ts.

import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { bomItemsFromFootprints, bomItemsFromNetlist, groupBom, parseNetlist, type ParsedNetlist } from '../netlist.ts'
import { readBoard } from '../board-file.ts'
import { run } from '../process.ts'
import { readSchematicTree, schematicSvgName } from '../schematic.ts'
import type { BomOptions, BomRow, OpContext, SchematicSheet, SchematicSvgOptions } from '../types.ts'
import { defineArgs } from './common.ts'

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ ...process.env, ...vars })

export async function cliSchematicSvgs(cli: string, sch: string, vars: Record<string, string>, opts: SchematicSvgOptions,
                                       ctx: OpContext, defineVars = true): Promise<SchematicSheet[]> {
  const tree = await readSchematicTree(sch)
  const out = join(ctx.workDir, 'sch-svg')
  await mkdir(out, { recursive: true })
  const r = await run(cli, ['sch', 'export', 'svg', ...(opts.drawingSheet === false ? ['--exclude-drawing-sheet'] : []),
    ...(opts.theme ? ['--theme', opts.theme] : []), ...(defineVars ? defineArgs(vars) : []), '-o', out + '/', sch],
  { timeoutMs: ctx.timeoutMs, env: env(vars), signal: ctx.signal })
  const plotted = r.out.map(l => /Plotted to '([^']+)'/.exec(l)?.[1]).filter((p): p is string => !!p)
  if (r.code !== 0 || plotted.length === 0)
    throw new Error(`schematic svg export failed (exit ${r.code}): ${r.out.slice(-5).join(' | ')}`)

  return matchSheets(tree, sch, plotted, ctx)
}

/**
 * Pair the sheet instances of the hierarchy with the SVG files kicad-cli wrote: by
 * kicad-cli's naming ("<root>-<name>-<name>.svg"), then by page order. Shared with the
 * probe-driven kicad-cli backends (cli-ops.ts).
 */
export function matchSheets(tree: Awaited<ReturnType<typeof readSchematicTree>>, sch: string, plotted: string[],
                            ctx: OpContext): SchematicSheet[] {
  const stem = basename(sch).replace(/\.kicad_sch$/, '')
  const byName = new Map(plotted.map(p => [basename(p), p]))
  const used = new Set<string>()
  const sheets: SchematicSheet[] = []
  tree.forEach((sh, i) => {
    let file = byName.get(schematicSvgName(stem, sh.names))
    if (!file || used.has(file)) file = plotted[i] && !used.has(plotted[i]!) ? plotted[i] : undefined
    if (!file || !existsSync(file)) { ctx.warn?.(`sheet ${sh.path} (${sh.name}): no SVG produced`); return }
    used.add(file)
    const { schFile: _f, names: _n, ...rest } = sh
    sheets.push({ ...rest, file })
  })
  if (!sheets.length) throw new Error('no schematic sheet could be matched to an SVG')
  return sheets
}

export async function cliNetlist(cli: string, sch: string, ctx: OpContext): Promise<ParsedNetlist> {
  const out = join(ctx.workDir, 'netlist.net')
  await mkdir(ctx.workDir, { recursive: true })
  const r = await run(cli, ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', out, sch],
                      { timeoutMs: ctx.timeoutMs, env: env(ctx.vars), signal: ctx.signal })
  if (!existsSync(out)) throw new Error(`netlist export failed (exit ${r.code}): ${r.out.slice(-3).join(' | ')}`)
  return parseNetlist(await readFile(out, 'utf8'))
}

export async function cliBom(cli: string, input: { sch?: string; pcb?: string }, opts: BomOptions, ctx: OpContext): Promise<BomRow[]> {
  return bomFrom(input, opts, sch => cliNetlist(cli, sch, ctx))
}

/** BOM rows from the schematic's netlist (preferred) or the board's footprints, grouped unless opts.group is false. */
export async function bomFrom(input: { sch?: string; pcb?: string }, opts: BomOptions,
                              netlist: (sch: string) => Promise<ParsedNetlist>): Promise<BomRow[]> {
  let items: BomRow[]
  if (input.sch) items = bomItemsFromNetlist(await netlist(input.sch), opts.fields)
  else if (input.pcb) {
    items = bomItemsFromFootprints(readBoard(await readFile(input.pcb, 'utf8')).footprints, opts.fields)
  } else throw new Error('exportBom needs a schematic or a board')
  return opts.group === false ? items : groupBom(items)
}
