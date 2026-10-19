// cli-modern: KiCad 9+ driven through kicad-cli.
//
// [phase 1] boardInfo, exportLayerSvgs, export3d, renderThumbnail (ported from the
//           MirrorLinkPCB viewer, behaviour unchanged).
// [P2-b]    exportSchematicSvgs (`sch export svg`, hierarchy from the .kicad_sch files),
//           exportBom (`sch export bom` with --fields / --group-by, parsed CSV),
//           netlist (`sch export netlist --format kicadxml`), footprints in boardInfo.
// [P2-c]    exportFab (gerbers, drill, pos, bom csv, sch pdf, step -> zip).
// [P2-d]    drc / erc (`--format json`), stats (`pcb export stats` or parsed).

import { existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { parseCheckReport } from '../checks.ts'
import { notYet } from '../errors.ts'
import { run } from '../process.ts'
import { computeBoardStats, mergeStats, parseKicadStatsJson } from '../stats.ts'
import type {
  BoardInfo, BoardStatsResult, BomOptions, BomRow, Capabilities, CheckReport, Export3dOptions, FabOptions, FabResult,
  KicadBackend, KicadInstall, KicadVersion, LayerSvgFile, LayerSvgOptions, Model3dResult, Netlist, OpContext, Operation,
  ProbeResult, SchematicSheet, SchematicSvgOptions, ThumbnailOptions, ThumbnailResult,
} from '../types.ts'
import { cliBom, cliNetlist, cliSchematicSvgs } from './cli-sch.ts'
import { defineArgs, fileSafe, limitTo, parseBoardFile, pathVars } from './common.ts'
import { exportFabCli } from './fab-cli.ts'

/** Operations implemented so far; phase 2 adds to this as it lands them. */
const IMPLEMENTED: ReadonlySet<Operation> = new Set<Operation>(['boardInfo', 'layerSvg', 'model3d', 'thumbnail', 'fab',
  'schematicSvg', 'bom', 'netlist',   // [P2-b]
  'drc', 'erc', 'stats',   // [P2-d]
])

export class CliModernBackend implements KicadBackend {
  readonly id = 'cli-modern' as const
  readonly install: KicadInstall
  readonly version: KicadVersion | null
  readonly capabilities: Capabilities
  private readonly cli: string

  constructor(probe: ProbeResult) {
    this.install = probe.install
    this.version = probe.version
    this.capabilities = limitTo(probe.capabilities, IMPLEMENTED)
    this.cli = probe.install.cli!
  }

  private env(vars: Record<string, string>): NodeJS.ProcessEnv {
    return { ...process.env, ...vars }
  }

  boardInfo(pcb: string): Promise<BoardInfo> {
    return parseBoardFile(pcb)
  }

  async exportLayerSvgs(pcb: string, layers: string[], opts: LayerSvgOptions, ctx: OpContext): Promise<LayerSvgFile[]> {
    const vars = pathVars(this.install, this.version, ctx)
    const out = join(ctx.workDir, opts.holes ? 'svg-holes' : 'svg-noholes')
    await mkdir(out, { recursive: true })
    const r = await run(this.cli, ['pcb', 'export', 'svg', '--layers', layers.join(','),
      '--mode-multi', '--exclude-drawing-sheet', '--page-size-mode', '1', '--drill-shape-opt', opts.holes ? '2' : '0',
      ...defineArgs(vars), '-o', out + '/', pcb], { timeoutMs: ctx.timeoutMs, env: this.env(vars), signal: ctx.signal })
    const plotted = r.out.map(l => /Plotted to '([^']+)'/.exec(l)?.[1]).filter((p): p is string => !!p)
    if (r.code !== 0 || plotted.length === 0)
      throw new Error(`svg export failed (exit ${r.code}): ${r.out.slice(-5).join(' | ')}`)

    // kicad-cli names files <board>-<layer user name or id>.svg and reports them in --layers order
    const info = await parseBoardFile(pcb)
    const stem = basename(pcb).replace(/\.kicad_pcb$/, '')
    const byName = new Map(plotted.map(p => [basename(p), p]))
    const entryOf = new Map(info.layers.map(l => [l.name, l]))
    const files: LayerSvgFile[] = []
    layers.forEach((id, i) => {
      const entry = entryOf.get(id)
      const candidates = [entry?.userName, id].filter((v): v is string => !!v).map(n => `${stem}-${fileSafe(n)}.svg`)
      const file = candidates.map(c => byName.get(c)).find(Boolean) ?? plotted[i]
      if (file) files.push({ layer: id, file })
      else ctx.warn?.(`layer ${id}: no SVG produced`)
    })
    return files
  }

  async export3d(pcb: string, opts: Export3dOptions, ctx: OpContext): Promise<Model3dResult> {
    const vars = pathVars(this.install, this.version, ctx)
    const ext = { vrml: 'wrl', glb: 'glb', step: 'step' }[opts.format]
    const out = join(ctx.workDir, `model.${ext}`)
    const noDnp = opts.noDnp !== false && this.capabilities.model3d.noDnp ? ['--no-dnp'] : []
    const args = opts.format === 'glb'
      ? ['pcb', 'export', 'glb', ...noDnp, '--subst-models', '--include-tracks', '--include-pads', '--include-zones',
         '--include-silkscreen', '--include-soldermask']
      : opts.format === 'step'
        ? ['pcb', 'export', 'step', ...noDnp, '--subst-models']
        : ['pcb', 'export', 'vrml', ...noDnp, '--units', 'mm']
    const r = await run(this.cli, [...args, ...defineArgs(vars), '-f', '-o', out, pcb],
                        { timeoutMs: ctx.timeoutMs, env: this.env(vars), signal: ctx.signal })
    const warnings = [...new Set(r.out.filter(l => /fail|No model|error|warning/i.test(l)))]
    if (!existsSync(out) || (await stat(out)).size === 0)
      throw new Error(`${opts.format} export failed (exit ${r.code}): ${r.out.slice(-3).join(' | ')}`)
    return { file: out, format: opts.format, bytes: (await stat(out)).size, warnings }
  }

  async renderThumbnail(pcb: string, opts: ThumbnailOptions, ctx: OpContext): Promise<ThumbnailResult> {
    const vars = pathVars(this.install, this.version, ctx)
    const out = join(ctx.workDir, 'render.png')
    const r = await run(this.cli, ['pcb', 'render', '--side', opts.side ?? 'top', '--background', 'transparent',
      '--quality', 'high', ...(opts.stackupColors === false ? [] : ['--use-board-stackup-colors']),
      '--perspective', '--rotate', '-35,0,20', '--zoom', '0.9', '-w', String(opts.width), '-h', String(opts.height),
      ...defineArgs(vars), '-o', out, pcb], { timeoutMs: ctx.timeoutMs, env: this.env(vars), signal: ctx.signal })
    if (!existsSync(out)) throw new Error(`render failed (exit ${r.code}): ${r.out.slice(-3).join(' | ')}`)
    return { file: out, width: opts.width, height: opts.height }
  }

  exportSchematicSvgs(sch: string, ctx: OpContext, opts: SchematicSvgOptions = {}): Promise<SchematicSheet[]> { return cliSchematicSvgs(this.cli, sch, pathVars(this.install, this.version, ctx), opts, ctx) }
  exportBom(input: { sch?: string; pcb?: string }, opts: BomOptions, ctx: OpContext): Promise<BomRow[]> { return cliBom(this.cli, input, opts, ctx) }
  async netlist(sch: string, ctx: OpContext): Promise<Netlist> { return { nets: (await cliNetlist(this.cli, sch, ctx)).nets } }
  /** [P2-c] Gerbers, drill, IPC-D-356, position files, BOM CSV, schematic PDF, STEP -> one deterministic zip (fab-cli.ts). */
  async exportFab(pcb: string, opts: FabOptions, ctx: OpContext): Promise<FabResult> {
    const vars = pathVars(this.install, this.version, ctx)
    return exportFabCli({ cli: this.cli, capabilities: this.capabilities, env: this.env(vars), defines: defineArgs(vars),
                          info: await parseBoardFile(pcb), export3d: (p, o, c) => this.export3d(p, o, c) }, pcb, opts, ctx)
  }
  // ---- [P2-d] DRC / ERC / stats -------------------------------------------------------
  /** `pcb drc --format json --severity-all` (+ `--schematic-parity` when a schematic sits next to the board). */
  async drc(pcb: string, opts: { sch?: string }, ctx: OpContext): Promise<CheckReport> {
    const vars = pathVars(this.install, this.version, ctx)
    const out = join(ctx.workDir, 'drc.json')
    const parity = opts.sch && existsSync(opts.sch) ? ['--schematic-parity'] : []
    const r = await run(this.cli, ['pcb', 'drc', '--format', 'json', '--units', 'mm', '--severity-all', ...parity,
      ...defineArgs(vars), '-o', out, pcb], { timeoutMs: ctx.timeoutMs, env: this.env(vars), signal: ctx.signal })
    if (!existsSync(out)) throw new Error(`drc failed (exit ${r.code}): ${r.out.slice(-3).join(' | ')}`)
    return parseCheckReport(await readFile(out, 'utf8'), 'drc')
  }

  /** `sch erc --format json --severity-all`. */
  async erc(sch: string, ctx: OpContext): Promise<CheckReport> {
    const vars = pathVars(this.install, this.version, ctx)
    const out = join(ctx.workDir, 'erc.json')
    const r = await run(this.cli, ['sch', 'erc', '--format', 'json', '--units', 'mm', '--severity-all',
      ...defineArgs(vars), '-o', out, sch], { timeoutMs: ctx.timeoutMs, env: this.env(vars), signal: ctx.signal })
    if (!existsSync(out)) throw new Error(`erc failed (exit ${r.code}): ${r.out.slice(-3).join(' | ')}`)
    return parseCheckReport(await readFile(out, 'utf8'), 'erc')
  }

  /** The file's statistics, enriched by `pcb export stats --format json` (measured clearance, area). */
  async stats(pcb: string, ctx: OpContext): Promise<BoardStatsResult> {
    const pro = pcb.replace(/\.kicad_pcb$/, '.kicad_pro')
    const file = computeBoardStats(await readFile(pcb, 'utf8'), existsSync(pro) ? await readFile(pro, 'utf8') : null)
    const out = join(ctx.workDir, 'stats.json')
    try {
      const r = await run(this.cli, ['pcb', 'export', 'stats', '--format', 'json', '--units', 'mm', '-o', out, pcb],
                          { timeoutMs: ctx.timeoutMs, env: this.env(ctx.vars), signal: ctx.signal })
      if (!existsSync(out)) throw new Error(`exit ${r.code}: ${r.out.slice(-2).join(' | ')}`)
      return mergeStats(file, parseKicadStatsJson(await readFile(out, 'utf8')))
    } catch (e) {
      ctx.warn?.(`pcb export stats failed, using the file's numbers only: ${e instanceof Error ? e.message : e}`)
      return file
    }
  }
}
