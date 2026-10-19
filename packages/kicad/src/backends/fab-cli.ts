// The generic fabrication bundle through kicad-cli (KiCad 8+ command set), used by
// cli-modern's exportFab. One zip, laid out as:
//
//   gerbers/   Gerber X2 per layer (the board's copper, masks, used paste / silk,
//              Edge.Cuts) + the job file, Excellon drill (PTH and NPTH separate),
//              IPC-D-356 netlist: everything a bare-board order needs, side by side
//   assembly/  position files (CSV, mm, one per side with parts), BOM CSV (schematic)
//   docs/      schematic PDF, drill maps (PDF)
//   3d/        the board as STEP (or GLB when STEP is not available)
//
// Every item is recorded with its outcome (ok / skipped / failed + reason), so the
// UI can tell an orderable bundle from an incomplete one. DNP parts are left out of
// the position files, the BOM and the 3D model.

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { run, type RunResult } from '../process.ts'
import type {
  BoardInfo, Capabilities, Export3dOptions, FabItem, FabItemId, FabOptions, FabResult, Model3dResult, OpContext,
} from '../types.ts'
import { writeZip, type ZipEntry } from '../zip.ts'

export interface FabCliDeps {
  cli: string
  capabilities: Capabilities
  /** Process env (path variables included) and -D arguments for a run. */
  env: NodeJS.ProcessEnv
  defines: string[]
  info: BoardInfo
  export3d(pcb: string, opts: Export3dOptions, ctx: OpContext): Promise<Model3dResult>
}

export const FAB_LABELS: Record<FabItemId, string> = {
  gerbers: 'Gerbers (X2)',
  drill: 'Drill files (Excellon, PTH + NPTH)',
  drillMap: 'Drill maps',
  ipcd356: 'IPC-D-356 netlist',
  pos: 'Position files (CSV)',
  bom: 'BOM (CSV)',
  schematicPdf: 'Schematic (PDF)',
  model: '3D model',
}
/** Items a bare-board order cannot do without. */
export const FAB_REQUIRED: ReadonlySet<FabItemId> = new Set(['gerbers', 'drill'])

/** macOS framework chatter kicad-cli prints on stderr (not about the board). */
const OS_NOISE = /^\d{4}-\d\d-\d\d [\d:.]+ kicad-cli\[\d+:\d+\]/

const tail = (r: RunResult) => r.out.slice(-3).join(' | ')

/** Gerber layer set: every copper layer, both masks, Edge.Cuts, and paste / silk when used. */
export function gerberLayers(info: BoardInfo): string[] {
  const names = new Set(info.layers.map(l => l.name))
  const used = new Set(info.usedLayers)
  const cu = info.layers.map(l => l.name).filter(n => /^(F|B|In\d+)\.Cu$/.test(n))
  const pos = (n: string) => (n === 'F.Cu' ? 0 : n === 'B.Cu' ? 1000 : Number(n.slice(2, -3)))
  cu.sort((a, b) => pos(a) - pos(b))
  const out = [...cu]
  for (const l of ['F.Mask', 'B.Mask', 'Edge.Cuts']) if (names.has(l)) out.push(l)
  for (const l of ['F.Paste', 'B.Paste', 'F.SilkS', 'B.SilkS']) if (names.has(l) && used.has(l)) out.push(l)
  return out
}

async function filesIn(dir: string): Promise<string[]> {
  return existsSync(dir) ? (await readdir(dir)).filter(f => !f.startsWith('.')).sort() : []
}

/** A position CSV with no data rows (only the header) means no parts on that side. */
const hasRows = (csv: string) => csv.split(/\r?\n/).filter(l => l.trim()).length > 1

export async function exportFabCli(d: FabCliDeps, pcb: string, opts: FabOptions, ctx: OpContext): Promise<FabResult> {
  const stem = basename(pcb).replace(/\.kicad_pcb$/, '')
  const root = join(ctx.workDir, 'fab-out')
  const items = new Map<FabItemId, FabItem>()
  const warnings: string[] = []
  const entries: ZipEntry[] = []
  const warn = (m: string) => { warnings.push(m); ctx.warn?.(m) }
  const cli = (args: string[]) => run(d.cli, args, { timeoutMs: ctx.timeoutMs, env: d.env, signal: ctx.signal })
  const record = (id: FabItemId, status: FabItem['status'], files: string[], reason: string | null = null) =>
    items.set(id, { id, label: FAB_LABELS[id], required: FAB_REQUIRED.has(id), status, files, reason })
  const add = async (dir: string, file: string, as: string) => {
    entries.push({ name: as, data: await readFile(join(dir, file)) })
    return as
  }
  const caps = d.capabilities.fab

  // ---- Gerbers ------------------------------------------------------------------
  const gDir = join(root, 'gerbers')
  await mkdir(gDir, { recursive: true })
  if (!caps.gerbers) record('gerbers', 'skipped', [], 'kicad-cli has no `pcb export gerbers`')
  else {
    const layers = gerberLayers(d.info)
    const base = ['pcb', 'export', 'gerbers', '--layers', layers.join(','), ...d.defines, '-o', gDir + '/']
    // refill zones before plotting when the KiCad supports it (9+); older ones reject the flag
    let r = await cli([...base.slice(0, 3), '--check-zones', ...base.slice(3), pcb])
    if (r.code !== 0 && /check-zones|unknown argument/i.test(r.out.join('\n'))) r = await cli([...base, pcb])
    const files = (await filesIn(gDir)).filter(f => !f.endsWith('.drl'))
    if (r.code !== 0 || !files.some(f => !f.endsWith('.gbrjob')))
      record('gerbers', 'failed', [], `gerber export failed (exit ${r.code}): ${tail(r)}`)
    else {
      for (const l of r.out) if (/warning|error/i.test(l)) warn(`gerbers: ${l.trim()}`)
      record('gerbers', 'ok', await Promise.all(files.map(f => add(gDir, f, `gerbers/${f}`))))
      if (!d.info.outline) warn('the board has no Edge.Cuts outline; the Edge.Cuts Gerber is empty')
    }
  }

  // ---- Drill + maps -------------------------------------------------------------
  const dDir = join(root, 'drill')
  await mkdir(dDir, { recursive: true })
  if (!caps.drill) {
    record('drill', 'skipped', [], 'kicad-cli has no `pcb export drill`')
    record('drillMap', 'skipped', [], 'kicad-cli has no `pcb export drill`')
  } else {
    const r = await cli(['pcb', 'export', 'drill', '--format', 'excellon', '--excellon-units', 'mm',
      '--excellon-separate-th', '--generate-map', '--map-format', 'pdf', '-o', dDir + '/', pcb])
    const files = await filesIn(dDir)
    const drl = files.filter(f => f.endsWith('.drl'))
    const maps = files.filter(f => !f.endsWith('.drl'))
    if (r.code !== 0 || !drl.length) {
      record('drill', 'failed', [], `drill export failed (exit ${r.code}): ${tail(r)}`)
      record('drillMap', 'failed', [], 'drill export failed')
    } else {
      record('drill', 'ok', await Promise.all(drl.map(f => add(dDir, f, `gerbers/${f}`))))
      if (maps.length) record('drillMap', 'ok', await Promise.all(maps.map(f => add(dDir, f, `docs/${f}`))))
      else record('drillMap', 'failed', [], 'no drill map produced')
    }
  }

  // ---- IPC-D-356 ----------------------------------------------------------------
  if (!caps.ipcd356) record('ipcd356', 'skipped', [], 'kicad-cli has no `pcb export ipcd356`')
  else {
    const f = `${stem}.d356`
    const r = await cli(['pcb', 'export', 'ipcd356', '-o', join(root, f), pcb])
    if (r.code !== 0 || !existsSync(join(root, f))) record('ipcd356', 'failed', [], `IPC-D-356 export failed (exit ${r.code}): ${tail(r)}`)
    else record('ipcd356', 'ok', [await add(root, f, `gerbers/${f}`)])
  }

  // ---- Position files -----------------------------------------------------------
  if (!caps.pos) record('pos', 'skipped', [], 'kicad-cli has no `pcb export pos`')
  else {
    const files: string[] = []
    const errors: string[] = []
    for (const side of ['front', 'back'] as const) {
      const f = `${stem}-pos-${side}.csv`
      const r = await cli(['pcb', 'export', 'pos', '--side', side, '--format', 'csv', '--units', 'mm', '--exclude-dnp',
        '-o', join(root, f), pcb])
      if (r.code !== 0 || !existsSync(join(root, f))) { errors.push(`${side}: exit ${r.code}: ${tail(r)}`); continue }
      if (hasRows(await readFile(join(root, f), 'utf8'))) files.push(await add(root, f, `assembly/${f}`))
    }
    if (errors.length) record('pos', 'failed', files, `position export failed (${errors.join('; ')})`)
    else if (!files.length) record('pos', 'skipped', [], 'no placeable parts on either side')
    else record('pos', 'ok', files)
  }

  // ---- Schematic: BOM and PDF ---------------------------------------------------
  if (!opts.sch) {
    record('bom', 'skipped', [], 'the project has no schematic')
    record('schematicPdf', 'skipped', [], 'the project has no schematic')
  } else {
    const bom = `${stem}-bom.csv`
    let r = await cli(['sch', 'export', 'bom', '--fields', 'Reference,Value,Footprint,${QUANTITY}', '--labels', 'Refs,Value,Footprint,Qty',
      '--group-by', 'Value,Footprint', '--exclude-dnp', '-o', join(root, bom), opts.sch])
    if (r.code !== 0 || !existsSync(join(root, bom))) record('bom', 'failed', [], `BOM export failed (exit ${r.code}): ${tail(r)}`)
    else record('bom', 'ok', [await add(root, bom, `assembly/${bom}`)])

    if (!caps.schematicPdf) record('schematicPdf', 'skipped', [], 'kicad-cli has no `sch export pdf`')
    else {
      const pdf = `${stem}-schematic.pdf`
      r = await cli(['sch', 'export', 'pdf', ...d.defines, '-o', join(root, pdf), opts.sch])
      if (r.code !== 0 || !existsSync(join(root, pdf))) record('schematicPdf', 'failed', [], `schematic PDF failed (exit ${r.code}): ${tail(r)}`)
      else record('schematicPdf', 'ok', [await add(root, pdf, `docs/${pdf}`)])
    }
  }

  // ---- 3D model -----------------------------------------------------------------
  const fmt = d.capabilities.model3d.formats.includes('step') ? 'step' : d.capabilities.model3d.formats.includes('glb') ? 'glb' : null
  if (opts.model === false) record('model', 'skipped', [], 'turned off')
  else if (!fmt) record('model', 'skipped', [], 'kicad-cli exports neither STEP nor GLB')
  else {
    const mDir = join(root, 'model')
    await mkdir(mDir, { recursive: true })
    try {
      const m = await d.export3d(pcb, { format: fmt, noDnp: true }, { ...ctx, workDir: mDir, warn: undefined })
      for (const w of m.warnings.filter(w => !OS_NOISE.test(w)).slice(0, 20)) warn(`3D model: ${w.trim()}`)
      const name = `${stem}.${fmt}`
      entries.push({ name: `3d/${name}`, data: await readFile(m.file) })
      record('model', 'ok', [`3d/${name}`])
    } catch (e) {
      record('model', 'failed', [], e instanceof Error ? e.message : String(e))
    }
  }

  // ---- the zip ------------------------------------------------------------------
  const order: FabItemId[] = ['gerbers', 'drill', 'ipcd356', 'pos', 'bom', 'schematicPdf', 'drillMap', 'model']
  const list = order.map(id => items.get(id)).filter((i): i is FabItem => !!i)
  const missing = list.filter(i => i.required && i.status !== 'ok').map(i => `${i.label}: ${i.reason ?? i.status}`)
  if (!d.info.outline) missing.push('Board outline (no Edge.Cuts shape)')
  const zip = join(ctx.workDir, opts.zipName ?? `${stem}-fab.zip`)
  const { names, bytes } = await writeZip(zip, entries)
  if (!bytes || !(await stat(zip)).size) throw new Error('fab: empty zip')
  return { zip, contents: names, status: missing.length ? 'incomplete' : 'ok', missing, warnings, items: list }
}
