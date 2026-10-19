// pcbnew-python: KiCad's own Python with the pcbnew module, through
// packages/kicad/python/kwv_pcbnew.py. For KiCad 5 / 6 (no kicad-cli) and as a fallback
// anywhere (`kicad.backend: 'pcbnew-python'`).
//
//   layer SVGs  PLOT_CONTROLLER, one SVG per layer, drill marks full / none; KiCad 5
//               SVGs in 1/10000 inch user units are rescaled to mm here
//   3D model    VRML through EXPORTER_VRML when the probe's self-test passes (7+ where
//               standalone export works; not KiCad 10.0.6 on macOS, which aborts)
//   fab         Gerbers (PLOT_CONTROLLER), Excellon drill (EXCELLON_WRITER) and the
//               position file (PLACE_FILE_EXPORTER, 6+) zipped by the script; BOM,
//               schematic PDF and STEP need kicad-cli, so the bundle is 'incomplete'
//   others      thumbnail (no renderer in pcbnew), schematic, BOM, netlist, DRC / ERC,
//               stats: unsupported

import { readFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { UnsupportedError } from '../errors.ts'
import { PCBNEW_SCRIPT, scriptResult } from '../probe.ts'
import { run } from '../process.ts'
import type {
  BoardInfo, BoardStatsResult, BomOptions, BomRow, Capabilities, FabItem, FabItemId, CheckReport, Export3dOptions, FabOptions, FabResult,
  KicadBackend, KicadInstall, KicadVersion, LayerSvgFile, LayerSvgOptions, Model3dResult, Netlist, OpContext, Operation,
  ProbeResult, SchematicSheet, ThumbnailOptions, ThumbnailResult,
} from '../types.ts'
import { limitTo, parseBoardFile, pathVars } from './common.ts'
import { FAB_LABELS, FAB_REQUIRED } from './fab-cli.ts'

const IMPLEMENTED: ReadonlySet<Operation> = new Set<Operation>(['boardInfo', 'layerSvg', 'model3d', 'fab'])

/**
 * Rescale an SVG whose user units are not millimetres (KiCad 5 plots in 1/10000 inch)
 * so its content is in mm like kicad-cli's: the factor is width (mm) / viewBox width.
 * Each top-level group gets the scale, so the with / without drill plots still differ
 * only by their hole groups (svg.ts normaliseLayerSvg).
 */
export function svgToMillimetres(svg: string): string {
  const root = /<svg\b[^>]*>/.exec(svg)
  if (!root) return svg
  const width = /\bwidth="([\d.]+)mm"/.exec(root[0])
  const vb = /\bviewBox="([^"]+)"/.exec(root[0])
  if (!width || !vb) return svg
  const [x, y, w, h] = vb[1]!.trim().split(/[\s,]+/).map(Number)
  const s = Number(width[1]) / w!
  if (!Number.isFinite(s) || Math.abs(s - 1) < 1e-6) return svg
  const r = (v: number) => String(Math.round(v * 1e6) / 1e6)
  const newRoot = root[0].replace(vb[0], `viewBox="${r(x! * s)} ${r(y! * s)} ${r(w! * s)} ${r(h! * s)}"`)
  const start = root.index + root[0].length
  const end = svg.lastIndexOf('</svg>')
  const inner = svg.slice(start, end)
  // walk top-level elements: groups get the transform, other drawing gets wrapped
  let out = ''
  let depth = 0
  let loose = ''
  const flushLoose = () => {
    if (loose.trim() && /<(path|circle|rect|polyline|polygon|line|ellipse|use|image)\b/.test(loose)) out += `<g transform="scale(${r(s)})">${loose}</g>`
    else out += loose
    loose = ''
  }
  const re = /<(\/?)g\b([^>]*?)(\/?)>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(inner))) {
    if (depth === 0) loose += inner.slice(last, m.index)
    else out += inner.slice(last, m.index)
    last = m.index + m[0].length
    if (m[1] === '/') { depth--; out += m[0]; continue }
    if (m[3] === '/') { if (depth === 0) loose += m[0]; else out += m[0]; continue }
    if (depth === 0) {
      flushLoose()
      const attrs = m[2]!
      const t = /\btransform="([^"]*)"/.exec(attrs)
      out += t ? `<g${attrs.replace(t[0], `transform="scale(${r(s)}) ${t[1]}"`)}>` : `<g transform="scale(${r(s)})"${attrs}>`
    } else out += m[0]
    depth++
  }
  loose += inner.slice(last)
  flushLoose()
  return svg.slice(0, root.index) + newRoot + out + svg.slice(end)
}

export class PcbnewPythonBackend implements KicadBackend {
  readonly id = 'pcbnew-python' as const
  readonly install: KicadInstall
  readonly version: KicadVersion | null
  readonly capabilities: Capabilities
  private readonly python: string

  constructor(probe: ProbeResult) {
    this.install = probe.install
    this.version = probe.version
    this.capabilities = limitTo(probe.capabilities, IMPLEMENTED)
    this.python = probe.install.python ?? 'python3'
  }

  private async script<T>(args: string[], ctx: OpContext): Promise<T> {
    const vars = pathVars(this.install, this.version, ctx)
    const r = await run(this.python, [PCBNEW_SCRIPT, ...args], {
      timeoutMs: ctx.timeoutMs, signal: ctx.signal, env: { ...process.env, ...vars }, cwd: ctx.workDir,
    })
    return scriptResult<T>(r)
  }

  private unsupported(op: Operation, why = 'not available through pcbnew Python'): never {
    throw new UnsupportedError(this.id, op, why)
  }

  boardInfo(pcb: string): Promise<BoardInfo> { return parseBoardFile(pcb) }

  async exportLayerSvgs(pcb: string, layers: string[], opts: LayerSvgOptions, ctx: OpContext): Promise<LayerSvgFile[]> {
    const out = join(ctx.workDir, opts.holes ? 'svg-holes' : 'svg-noholes')
    await mkdir(out, { recursive: true })
    const files = await this.script<LayerSvgFile[]>(['svg', pcb, out, opts.holes ? '1' : '0', layers.join(',')], ctx)
    const done = new Set(files.map(f => f.layer))
    for (const l of layers) if (!done.has(l)) ctx.warn?.(`layer ${l}: no SVG produced`)
    for (const f of files) {
      const svg = await readFile(f.file, 'utf8')
      const mm = svgToMillimetres(svg)
      if (mm !== svg) await writeFile(f.file, mm)
    }
    if (!files.length) throw new Error('svg export produced no files')
    return files
  }

  async export3d(pcb: string, opts: Export3dOptions, ctx: OpContext): Promise<Model3dResult> {
    if (opts.format !== 'vrml' || !this.capabilities.model3d.formats.includes('vrml'))
      this.unsupported('model3d', `cannot export ${opts.format} through pcbnew Python ${this.version?.raw ?? ''}`)
    await mkdir(ctx.workDir, { recursive: true })
    const out = join(ctx.workDir, 'model.wrl')
    // kicad-cli centres the model on the outline; do the same
    const info = await parseBoardFile(pcb)
    const o = info.outline
    const cx = o ? o.x + o.width / 2 : 0
    const cy = o ? o.y + o.height / 2 : 0
    await this.script(['vrml', pcb, out, String(cx), String(cy), opts.noDnp === false ? '0' : '1'], ctx)
    return { file: out, format: 'vrml', bytes: (await stat(out)).size, warnings: [] }
  }

  renderThumbnail(_pcb: string, _opts: ThumbnailOptions, _ctx: OpContext): Promise<ThumbnailResult> {
    return this.unsupported('thumbnail', 'pcbnew Python has no renderer')
  }

  async exportFab(pcb: string, _opts: FabOptions, ctx: OpContext): Promise<FabResult> {
    const dir = join(ctx.workDir, 'fab')
    await mkdir(dir, { recursive: true })
    const stem = pcb.split(/[\\/]/).pop()!.replace(/\.kicad_pcb$/, '')
    const zip = join(ctx.workDir, `${stem}.zip`)
    const r = await this.script<{ zip: string; contents: string[]; missing: string[]; warnings: string[] }>(['fab', pcb, dir, zip], ctx)
    const missing = [...r.missing, 'BOM', 'Schematic PDF', '3D model (STEP)']
    // per-deliverable outcome (FabItem, P2-c) from what the script put in the zip
    const drill = r.contents.filter(c => /\.drl$/i.test(c))
    const pos = r.contents.filter(c => !c.startsWith('gerbers/'))
    const produced: Partial<Record<FabItemId, string[]>> = {
      gerbers: r.contents.filter(c => c.startsWith('gerbers/') && !drill.includes(c)), drill, pos,
    }
    const items: FabItem[] = (Object.keys(FAB_LABELS) as FabItemId[]).map(id => {
      const files = produced[id] ?? []
      const ok = files.length > 0
      return { id, label: FAB_LABELS[id], required: FAB_REQUIRED.has(id), status: ok ? 'ok' : id in produced ? 'failed' : 'skipped', files,
               reason: ok ? null : id in produced ? 'pcbnew Python wrote no file' : 'not available through pcbnew Python' }
    })
    return { zip: r.zip, contents: r.contents, status: 'incomplete', missing, warnings: r.warnings, items }
  }

  exportSchematicSvgs(_sch: string, _ctx: OpContext): Promise<SchematicSheet[]> { return this.unsupported('schematicSvg') }
  exportBom(_input: { sch?: string; pcb?: string }, _opts: BomOptions, _ctx: OpContext): Promise<BomRow[]> { return this.unsupported('bom') }
  netlist(_sch: string, _ctx: OpContext): Promise<Netlist> { return this.unsupported('netlist') }
  drc(_pcb: string, _opts: { sch?: string }, _ctx: OpContext): Promise<CheckReport> { return this.unsupported('drc') }
  erc(_sch: string, _ctx: OpContext): Promise<CheckReport> { return this.unsupported('erc') }
  stats(_pcb: string, _ctx: OpContext): Promise<BoardStatsResult> { return this.unsupported('stats') }
}
