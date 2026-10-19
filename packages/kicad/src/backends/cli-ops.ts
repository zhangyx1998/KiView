// kicad-cli operations shared by the cli-7-8 and docker backends: each call's flags
// come from the probed help of that very kicad-cli (so one implementation covers
// KiCad 7.0 to 10), and the process is started by a CliRunner (native, or a container).
//
//   layer SVGs  9+: one `--mode-multi` call; 7/8: one call per layer (`-o <file>.svg`)
//   3D model    vrml (8+), glb (8+), step (7+); --no-dnp only where that command has it
//               (vrml from 9, glb / step from 8); --units mm where vrml has it
//   thumbnail   `pcb render` (9+), else UnsupportedError: the thumbnail stage falls back
//   schematic   `sch export svg` (7+), sheets matched as in cli-sch.ts         [P2-b]
//   netlist/BOM `sch export netlist --format kicadsexpr` (7+), parsed by netlist.ts
//   DRC / ERC   `pcb drc` / `sch erc --format json` (8+), checks.ts             [P2-d]
//   stats       the board file's numbers, plus `pcb export stats` (10+)
// Every flag beyond the command itself is passed only when that kicad-cli lists it.
//
// Layer names: always the canonical (untranslated) names of the board file ("F.SilkS",
// "In1.Cu", "User.1"). kicad-cli 7 accepts only those; 8+ also takes the GUI names
// ("F.Silkscreen"), which we never pass. In multi-file mode kicad-cli names files after
// the layer's user name when it has one, so files are matched on both.

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { parseCheckReport } from '../checks.ts'
import { UnsupportedError } from '../errors.ts'
import { parseNetlist, type ParsedNetlist } from '../netlist.ts'
import { helpHasFlag } from '../probe.ts'
import { run, type RunResult } from '../process.ts'
import { readSchematicTree } from '../schematic.ts'
import { computeBoardStats, mergeStats, parseKicadStatsJson } from '../stats.ts'
import type {
  BackendId, BoardStatsResult, BomOptions, BomRow, Capabilities, CheckReport, Export3dOptions, HelpFacts, KicadInstall, KicadVersion,
  LayerSvgFile, LayerSvgOptions, Model3dResult, Netlist, OpContext, Operation, SchematicSheet, SchematicSvgOptions,
  ThumbnailOptions, ThumbnailResult,
} from '../types.ts'
import { bomFrom, matchSheets } from './cli-sch.ts'
import { defineArgs, fileSafe, parseBoardFile, pathVars } from './common.ts'

export interface ExecOptions {
  /** Variables for the process environment (KiCad reads ${VAR} from it too). */
  env: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  /** Host paths the calls read (files or dirs). */
  read: string[]
  /** Host directories the calls write into. */
  write: string[]
}

/** Starts kicad-cli. Paths in arguments are host paths; a container runner maps them. */
export interface CliRunner {
  exec(args: string[], o: ExecOptions): Promise<RunResult>
  /** Several calls; a container runner uses one container for all of them. */
  execMany(calls: string[][], o: ExecOptions): Promise<RunResult[]>
}

export class NativeRunner implements CliRunner {
  constructor(readonly cli: string) {}
  exec(args: string[], o: ExecOptions): Promise<RunResult> {
    return run(this.cli, args, { timeoutMs: o.timeoutMs, env: { ...process.env, ...o.env }, signal: o.signal })
  }
  async execMany(calls: string[][], o: ExecOptions): Promise<RunResult[]> {
    const out: RunResult[] = []
    for (const c of calls) out.push(await this.exec(c, o))
    return out
  }
}

const plottedFiles = (r: RunResult) => r.out.map(l => /Plotted to '([^']+)'/.exec(l)?.[1]).filter((p): p is string => !!p)

export class CliOps {
  private warnedDrill = false

  constructor(readonly id: BackendId, readonly install: KicadInstall, readonly version: KicadVersion | null,
              readonly help: Record<string, HelpFacts>, readonly runner: CliRunner) {}

  private has = (path: string, f: string) => helpHasFlag(this.help, path, f)
  private sub = (path: string, s: string) => this.help[path]?.subcommands.includes(s) ?? false

  /** -D NAME=value where the command takes --define-var (8+); KiCad 7 reads the environment only. */
  private defines(path: string, vars: Record<string, string>): string[] {
    return this.has(path, '--define-var') ? defineArgs(vars) : []
  }

  /** Keep only flags (and their values) the command lists. */
  private only(path: string, args: (string | [string, string])[]): string[] {
    return args.flatMap(a => (Array.isArray(a) ? (this.has(path, a[0]) ? a : []) : this.has(path, a) ? [a] : []))
  }

  /** Variables naming host directories to mount; a container's own model library is not one. */
  private hostDirs(vars: Record<string, string>): string[] {
    const own = this.install.kind === 'docker' ? this.install.modelDir : undefined
    return readVars(vars).filter(v => v !== own)
  }

  async exportLayerSvgs(pcb: string, layers: string[], opts: LayerSvgOptions, ctx: OpContext): Promise<LayerSvgFile[]> {
    const P = 'pcb export svg'
    if (!this.sub('pcb export', 'svg')) throw new UnsupportedError(this.id, 'layerSvg', 'kicad-cli has no pcb export svg')
    const vars = pathVars(this.install, this.version, ctx)
    const out = join(ctx.workDir, opts.holes ? 'svg-holes' : 'svg-noholes')
    await mkdir(out, { recursive: true })
    if (!this.has(P, '--drill-shape-opt') && !this.warnedDrill) {
      this.warnedDrill = true
      ctx.warn?.(`kicad-cli ${this.version?.raw ?? ''} has no --drill-shape-opt: drill holes are not cut out of the layers`)
    }
    const common = [
      ...this.only(P, ['--exclude-drawing-sheet', ['--page-size-mode', '1'], ['--drill-shape-opt', opts.holes ? '2' : '0']]),
      ...this.defines(P, vars),
    ]
    const xo: ExecOptions = { env: vars, timeoutMs: ctx.timeoutMs, signal: ctx.signal, read: [pcb, ...this.hostDirs(vars)], write: [out] }

    if (this.has(P, '--mode-multi')) {
      const r = await this.runner.exec(['pcb', 'export', 'svg', '--layers', layers.join(','), '--mode-multi', ...common, '-o', out + '/', pcb], xo)
      const plotted = plottedFiles(r)
      if (r.code !== 0 || plotted.length === 0) throw new Error(`svg export failed (exit ${r.code}): ${r.out.slice(-5).join(' | ')}`)
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

    // one call per layer (kicad-cli 7 / 8): the output is a file
    const single = this.has(P, '--mode-single') ? ['--mode-single'] : []
    const targets = layers.map(id => ({ id, file: join(out, `${fileSafe(id)}.svg`) }))
    const results = await this.runner.execMany(
      targets.map(t => ['pcb', 'export', 'svg', '--layers', t.id, ...single, ...common, '-o', t.file, pcb]), xo)
    const files: LayerSvgFile[] = []
    targets.forEach((t, i) => {
      if (existsSync(t.file)) files.push({ layer: t.id, file: t.file })
      else ctx.warn?.(`layer ${t.id}: no SVG produced (exit ${results[i]?.code}: ${results[i]?.out.slice(-2).join(' | ')})`)
    })
    if (!files.length) throw new Error(`svg export failed: ${results[0]?.out.slice(-5).join(' | ')}`)
    return files
  }

  async export3d(pcb: string, opts: Export3dOptions, ctx: OpContext): Promise<Model3dResult> {
    if (!this.sub('pcb export', opts.format)) {
      throw new UnsupportedError(this.id, 'model3d', `kicad-cli ${this.version?.raw ?? ''} has no pcb export ${opts.format}`)
    }
    const P = `pcb export ${opts.format}`
    const vars = pathVars(this.install, this.version, ctx)
    const ext = { vrml: 'wrl', glb: 'glb', step: 'step' }[opts.format]
    const out = join(ctx.workDir, `model.${ext}`)
    await mkdir(ctx.workDir, { recursive: true })
    const noDnp = opts.noDnp !== false ? ['--no-dnp'] : []
    const extra = opts.format === 'vrml'
      ? [['--units', 'mm'] as [string, string]]
      : opts.format === 'glb'
        ? ['--subst-models', '--include-tracks', '--include-pads', '--include-zones', '--include-silkscreen', '--include-soldermask']
        : ['--subst-models']
    const args = ['pcb', 'export', opts.format, ...this.only(P, [...noDnp, ...extra, '--force']),
      ...this.defines(P, vars), '-o', out, pcb]
    if (opts.noDnp !== false && !this.has(P, '--no-dnp')) ctx.warn?.(`kicad-cli ${this.version?.raw ?? ''} ${opts.format}: no --no-dnp, unfitted parts are included`)
    const r = await this.runner.exec(args, { env: vars, timeoutMs: ctx.timeoutMs, signal: ctx.signal, read: [pcb, ...this.hostDirs(vars)], write: [dirname(out)] })
    const warnings = [...new Set(r.out.filter(l => /fail|No model|error|warning/i.test(l)))]
    if (!existsSync(out) || (await stat(out)).size === 0)
      throw new Error(`${opts.format} export failed (exit ${r.code}): ${r.out.slice(-3).join(' | ')}`)
    return { file: out, format: opts.format, bytes: (await stat(out)).size, warnings }
  }

  async renderThumbnail(pcb: string, opts: ThumbnailOptions, ctx: OpContext): Promise<ThumbnailResult> {
    if (!this.sub('pcb', 'render')) throw new UnsupportedError(this.id, 'thumbnail', 'kicad-cli has no pcb render (KiCad 9+)')
    const P = 'pcb render'
    const vars = pathVars(this.install, this.version, ctx)
    const out = join(ctx.workDir, 'render.png')
    await mkdir(ctx.workDir, { recursive: true })
    const r = await this.runner.exec(['pcb', 'render', '--side', opts.side ?? 'top', '--background', 'transparent',
      '--quality', 'high', ...(opts.stackupColors === false ? [] : this.only(P, ['--use-board-stackup-colors'])),
      '--perspective', '--rotate', '-35,0,20', '--zoom', '0.9', '-w', String(opts.width), '-h', String(opts.height),
      ...this.defines(P, vars), '-o', out, pcb],
    { env: vars, timeoutMs: ctx.timeoutMs, signal: ctx.signal, read: [pcb, ...this.hostDirs(vars)], write: [ctx.workDir] })
    if (!existsSync(out)) throw new Error(`render failed (exit ${r.code}): ${r.out.slice(-3).join(' | ')}`)
    return { file: out, width: opts.width, height: opts.height }
  }
  // ---- [integration] schematic / netlist / BOM (P2-b), DRC / ERC / stats (P2-d) ---------

  private need(op: Operation, path: string, what: string): void {
    const [parent, cmd] = [path.split(' ').slice(0, -1).join(' '), path.split(' ').pop()!]
    if (!this.sub(parent, cmd)) throw new UnsupportedError(this.id, op, `kicad-cli ${this.version?.raw ?? ''} has no ${path}${what}`)
  }
  /** Exec options: the schematic / board directory (sub-sheets, project, rules) read, the work dir written. */
  private async xo(file: string, ctx: OpContext, vars: Record<string, string>): Promise<ExecOptions> {
    await mkdir(ctx.workDir, { recursive: true })
    return { env: vars, timeoutMs: ctx.timeoutMs, signal: ctx.signal, read: [dirname(file), ...this.hostDirs(vars)], write: [ctx.workDir] }
  }

  async exportSchematicSvgs(sch: string, ctx: OpContext, opts: SchematicSvgOptions = {}): Promise<SchematicSheet[]> {
    const P = 'sch export svg'
    this.need('schematicSvg', P, '')
    const vars = pathVars(this.install, this.version, ctx)
    const tree = await readSchematicTree(sch)
    const out = join(ctx.workDir, 'sch-svg')
    await mkdir(out, { recursive: true })
    const flags = [
      ...(opts.drawingSheet === false ? this.only(P, ['--exclude-drawing-sheet']) : []),
      ...(opts.theme ? this.only(P, [['--theme', opts.theme]]) : []),
      ...this.defines(P, vars),
    ]
    const xo = await this.xo(sch, ctx, vars)
    const r = await this.runner.exec(['sch', 'export', 'svg', ...flags, '-o', out + '/', sch], { ...xo, write: [out] })
    let plotted = plottedFiles(r).filter(f => f.endsWith('.svg'))
    // older kicad-cli may not print "Plotted to": take what is in the directory
    if (!plotted.length) plotted = (await readdir(out)).filter(f => f.endsWith('.svg')).sort().map(f => join(out, f))
    if (!plotted.length) throw new Error(`schematic svg export failed (exit ${r.code}): ${r.out.slice(-5).join(' | ')}`)
    return matchSheets(tree, sch, plotted, ctx)
  }

  private async readNetlist(sch: string, ctx: OpContext): Promise<ParsedNetlist> {
    const P = 'sch export netlist'
    this.need('netlist', P, '')
    if (!this.has(P, '--format')) throw new UnsupportedError(this.id, 'netlist', `kicad-cli ${this.version?.raw ?? ''} ${P} has no --format`)
    const vars = pathVars(this.install, this.version, ctx)
    const out = join(ctx.workDir, 'netlist.net')
    const r = await this.runner.exec(['sch', 'export', 'netlist', '--format', 'kicadsexpr', ...this.defines(P, vars), '-o', out, sch],
                                     await this.xo(sch, ctx, vars))
    if (!existsSync(out)) throw new Error(`netlist export failed (exit ${r.code}): ${r.out.slice(-3).join(' | ')}`)
    return parseNetlist(await readFile(out, 'utf8'))
  }
  async netlist(sch: string, ctx: OpContext): Promise<Netlist> { return { nets: (await this.readNetlist(sch, ctx)).nets } }
  exportBom(input: { sch?: string; pcb?: string }, opts: BomOptions, ctx: OpContext): Promise<BomRow[]> {
    return bomFrom(input, opts, sch => this.readNetlist(sch, ctx))
  }

  private async check(kind: 'drc' | 'erc', file: string, extra: string[], ctx: OpContext): Promise<CheckReport> {
    const P = kind === 'drc' ? 'pcb drc' : 'sch erc'
    this.need(kind, P, '')
    if (!this.has(P, '--format')) throw new UnsupportedError(this.id, kind, `kicad-cli ${this.version?.raw ?? ''} ${P} has no --format json`)
    const vars = pathVars(this.install, this.version, ctx)
    const out = join(ctx.workDir, `${kind}.json`)
    const r = await this.runner.exec([...P.split(' '), '--format', 'json', ...this.only(P, [['--units', 'mm'], '--severity-all', ...extra]),
      ...this.defines(P, vars), '-o', out, file], await this.xo(file, ctx, vars))
    if (!existsSync(out)) throw new Error(`${kind} failed (exit ${r.code}): ${r.out.slice(-3).join(' | ')}`)
    return parseCheckReport(await readFile(out, 'utf8'), kind)
  }
  drc(pcb: string, opts: { sch?: string }, ctx: OpContext): Promise<CheckReport> {
    return this.check('drc', pcb, opts.sch && existsSync(opts.sch) ? ['--schematic-parity'] : [], ctx)
  }
  erc(sch: string, ctx: OpContext): Promise<CheckReport> { return this.check('erc', sch, [], ctx) }

  /** The board file's numbers, enriched by `pcb export stats` where this kicad-cli has it. */
  async stats(pcb: string, ctx: OpContext): Promise<BoardStatsResult> {
    const pro = pcb.replace(/\.kicad_pcb$/, '.kicad_pro')
    const file = computeBoardStats(await readFile(pcb, 'utf8'), existsSync(pro) ? await readFile(pro, 'utf8') : null)
    if (!this.sub('pcb export', 'stats')) return file
    const P = 'pcb export stats'
    const vars = pathVars(this.install, this.version, ctx)
    const out = join(ctx.workDir, 'stats.json')
    try {
      const r = await this.runner.exec(['pcb', 'export', 'stats', ...this.only(P, [['--format', 'json'], ['--units', 'mm']]), '-o', out, pcb],
                                       await this.xo(pcb, ctx, vars))
      if (!existsSync(out)) throw new Error(`exit ${r.code}: ${r.out.slice(-2).join(' | ')}`)
      return mergeStats(file, parseKicadStatsJson(await readFile(out, 'utf8')))
    } catch (e) {
      ctx.warn?.(`pcb export stats failed, using the file's numbers only: ${e instanceof Error ? e.message : e}`)
      return file
    }
  }
}

/**
 * The BOM comes from the netlist (cli-sch.ts bomFrom), not from `sch export bom` (8+),
 * so it is available wherever `sch export netlist --format` is.
 */
export function withNetlistBom(c: Capabilities, help?: Record<string, HelpFacts>): Capabilities {
  const netlist = c.ops.netlist && (!help || helpHasFlag(help, 'sch export netlist', '--format'))
  return { ...c, ops: { ...c.ops, netlist, bom: netlist } }
}

/** Path variables that name existing host directories (a container mounts them read-only). */
export function readVars(vars: Record<string, string>): string[] {
  return Object.values(vars).filter(v => /^([A-Za-z]:)?[\\/]/.test(v) && existsSync(v))
}
