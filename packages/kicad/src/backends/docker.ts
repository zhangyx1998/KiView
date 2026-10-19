// docker: kicad-cli inside a kicad/kicad:<ver> image, for KiCad versions not installed
// natively (`kicad.docker.enabled`). Every call is a `docker run --rm` with
//
//   - the files it reads bind-mounted read-only (the board snapshot's dir, KIPRJMOD,
//     path variables that name host directories), the dirs it writes bind-mounted
//     read-write, each at /kwv/r<i> or /kwv/w<i>;
//   - host paths in arguments and variables rewritten to those mounts, and container
//     paths in its output rewritten back (so "Plotted to '...'" names host files);
//   - --network none, --user <uid>:<gid> (POSIX hosts, so outputs are the caller's),
//     HOME=/tmp (KiCad writes its config there), the image's own 3D model library
//     (/usr/share/kicad/3dmodels, set as KICAD<n>_3DMODEL_DIR).
//
// Per-layer SVG exports (images 7 / 8) run in one container (`sh -c` with one kicad-cli
// per layer), not one container per layer. Operations are cli-ops.ts, flags come from
// the image's probed help (probe.ts probeDocker). Not run in CI; the command
// construction is unit-tested (tests/docker.test.ts).

import { UnsupportedError } from '../errors.ts'
import { run, type RunResult } from '../process.ts'
import type {
  BoardInfo, BoardStatsResult, BomOptions, BomRow, Capabilities, CheckReport, Export3dOptions, FabOptions, FabResult,
  KicadBackend, KicadInstall, KicadVersion, LayerSvgFile, LayerSvgOptions, Model3dResult, Netlist, OpContext, Operation,
  ProbeResult, SchematicSheet, SchematicSvgOptions, ThumbnailOptions, ThumbnailResult,
} from '../types.ts'
import { CliOps, withNetlistBom, type CliRunner, type ExecOptions } from './cli-ops.ts'
import { limitTo, parseBoardFile } from './common.ts'

/** Operations implemented here; each is on only where the probed help has the command (capabilitiesFromHelp). */
const IMPLEMENTED: ReadonlySet<Operation> = new Set<Operation>(['boardInfo', 'layerSvg', 'model3d', 'thumbnail',
  'schematicSvg', 'bom', 'netlist', 'drc', 'erc', 'stats'])

export interface Mount { host: string; container: string; readonly: boolean }

export interface DockerCommandInput {
  image: string
  /** kicad-cli argument lists (host paths); several run in one container. */
  calls: string[][]
  env: Record<string, string>
  read: string[]
  write: string[]
  /** "uid:gid" for --user, null to keep the image's user (Windows hosts). */
  user: string | null
  /** Paths that already are container paths (the image's model dir): never mounted or mapped. */
  containerPaths?: string[]
  /** Host path flavour (tests build Windows commands on any OS). */
  windows?: boolean
}

export interface DockerCommand {
  /** Arguments of `docker`. */
  args: string[]
  mounts: Mount[]
  /** Rewrites container paths in an output line back to host paths. */
  toHost(line: string): string
  /** Marker printed after each call when there are several: "@@KWV-END <i> <exit code>". */
  multi: boolean
}

const isAbs = (p: string, win: boolean) => (win ? /^([A-Za-z]:[\\/]|\\\\)/.test(p) : p.startsWith('/'))
const norm = (p: string, win: boolean) => (win ? p.replace(/\//g, '\\').replace(/\\+$/, '') : p.replace(/\/+$/, '')) || p
const parentOf = (p: string, win: boolean) => {
  const sep = win ? '\\' : '/'
  const i = p.lastIndexOf(sep)
  return i <= 0 ? (win ? p : '/') : p.slice(0, i)
}
const within = (p: string, dir: string, win: boolean) => {
  const sep = win ? '\\' : '/'
  const [a, b] = win ? [p.toLowerCase(), dir.toLowerCase()] : [p, dir]
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/** Single-quote for sh. */
export const shQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** A --mount value; fields with a comma or a quote are CSV-quoted (docker parses --mount as CSV). */
function mountArg(m: Mount): string {
  const field = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return ['type=bind', field(`source=${m.host}`), field(`target=${m.container}`), ...(m.readonly ? ['readonly'] : [])].join(',')
}

/**
 * The `docker run` for some kicad-cli calls: mounts for what they read and write, paths
 * mapped into the container, and the mapping back for their output. Pure (no I/O).
 */
export function dockerCommand(i: DockerCommandInput): DockerCommand {
  const win = i.windows ?? process.platform === 'win32'
  const skip = new Set(i.containerPaths ?? [])
  const isFileLike = (p: string) => /\.[A-Za-z0-9_]+$/.test(p) && !p.endsWith('/') && !p.endsWith('\\')
  // directories to mount: writes as given, reads by their directory (files) unless covered
  const writes = [...new Set(i.write.filter(p => isAbs(p, win)).map(p => norm(p, win)))]
  const readDirs = [...new Set(i.read.filter(p => isAbs(p, win) && !skip.has(p))
    .map(p => norm(isFileLike(p) ? parentOf(norm(p, win), win) : p, win)))]
  const mounts: Mount[] = []
  const covered = (p: string) => mounts.some(m => within(p, m.host, win))
  // shortest first, so a nested dir is covered by its parent's mount (writes before reads)
  for (const [k, w] of [...writes].sort((a, b) => a.length - b.length).entries())
    if (!covered(w)) mounts.push({ host: w, container: `/kwv/w${k}`, readonly: false })
  readDirs.sort((a, b) => a.length - b.length).forEach((r, k) => {
    if (!covered(r)) mounts.push({ host: r, container: `/kwv/r${k}`, readonly: true })
  })
  // host -> container: the most specific mount wins
  const bySpecificity = [...mounts].sort((a, b) => b.host.length - a.host.length)
  const toContainer = (s: string): string => {
    if (skip.has(s) || !isAbs(s, win)) return s
    const m = bySpecificity.find(m => within(norm(s, win), m.host, win))
    if (!m) return s
    const rest = norm(s, win).slice(m.host.length).replace(/\\/g, '/')
    const trailing = /[\\/]$/.test(s) ? '/' : ''
    return (m.container + rest + trailing).replace(/\/\/+$/, '/')
  }
  const mapArg = (a: string): string => {
    const eq = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(a)   // -D NAME=value
    return eq ? `${eq[1]}=${toContainer(eq[2]!)}` : toContainer(a)
  }
  const byContainer = [...mounts].sort((a, b) => b.container.length - a.container.length)
  const toHost = (line: string): string => {
    let out = line
    for (const m of byContainer) {
      out = out.replace(new RegExp(`${m.container.replace(/[/]/g, '\\/')}(?=[/'"\\s]|$)([^'"\\s]*)`, 'g'),
        (_, rest: string) => m.host + (win ? rest.replace(/\//g, '\\') : rest))
    }
    return out
  }

  const args = ['run', '--rm', '--network', 'none', '--workdir', '/tmp', '-e', 'HOME=/tmp']
  if (i.user) args.push('--user', i.user)
  for (const m of mounts) args.push('--mount', mountArg(m))
  for (const [k, v] of Object.entries(i.env)) args.push('-e', `${k}=${toContainer(v)}`)
  const calls = i.calls.map(c => c.map(mapArg))
  if (calls.length === 1) {
    args.push('--entrypoint', 'kicad-cli', i.image, ...calls[0]!)
    return { args, mounts, toHost, multi: false }
  }
  const script = calls.map((c, k) => `kicad-cli ${c.map(shQuote).join(' ')}; echo "@@KWV-END ${k} $?"`).join('; ')
  args.push('--entrypoint', 'sh', i.image, '-c', script)
  return { args, mounts, toHost, multi: true }
}

/** Split the output of a multi-call container into one RunResult per call. */
export function splitMultiOutput(lines: string[], calls: number, code: number | null): RunResult[] {
  const out: RunResult[] = Array.from({ length: calls }, () => ({ code: null, out: [] }))
  let k = 0
  for (const l of lines) {
    const m = /^@@KWV-END (\d+) (\d+)$/.exec(l)
    if (m) { out[Number(m[1])]!.code = Number(m[2]); k = Number(m[1]) + 1; continue }
    if (k < calls) out[k]!.out.push(l)
  }
  for (const r of out) if (r.code === null) r.code = code === 0 ? -1 : code
  return out
}

export class DockerRunner implements CliRunner {
  constructor(readonly image: string, readonly containerPaths: string[] = [], readonly docker = 'docker') {}

  private user(): string | null {
    return typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : null
  }

  async exec(args: string[], o: ExecOptions): Promise<RunResult> {
    return (await this.execMany([args], o))[0]!
  }

  async execMany(calls: string[][], o: ExecOptions): Promise<RunResult[]> {
    const cmd = dockerCommand({ image: this.image, calls, env: o.env, read: o.read, write: o.write, user: this.user(), containerPaths: this.containerPaths })
    const r = await run(this.docker, cmd.args, { timeoutMs: (o.timeoutMs ?? 180_000) * Math.max(1, Math.ceil(calls.length / 4)), signal: o.signal })
    const out = r.out.map(cmd.toHost)
    return cmd.multi ? splitMultiOutput(out, calls.length, r.code) : [{ code: r.code, out }]
  }
}

export class DockerBackend implements KicadBackend {
  readonly id = 'docker' as const
  readonly install: KicadInstall
  readonly version: KicadVersion | null
  readonly capabilities: Capabilities
  private readonly ops: CliOps

  constructor(probe: ProbeResult, runner?: CliRunner) {
    this.install = probe.install
    this.version = probe.version
    this.capabilities = withNetlistBom(limitTo(probe.capabilities, IMPLEMENTED), probe.help)
    const image = probe.install.image ?? 'kicad/kicad'
    this.ops = new CliOps(this.id, probe.install, probe.version, probe.help,
      runner ?? new DockerRunner(image, probe.install.modelDir ? [probe.install.modelDir] : []))
  }

  private unsupported(op: Operation): never {
    throw new UnsupportedError(this.id, op, 'not implemented for the docker backend')
  }

  boardInfo(pcb: string): Promise<BoardInfo> { return parseBoardFile(pcb) }
  exportLayerSvgs(pcb: string, layers: string[], opts: LayerSvgOptions, ctx: OpContext): Promise<LayerSvgFile[]> {
    return this.ops.exportLayerSvgs(pcb, layers, opts, ctx)
  }
  export3d(pcb: string, opts: Export3dOptions, ctx: OpContext): Promise<Model3dResult> { return this.ops.export3d(pcb, opts, ctx) }
  renderThumbnail(pcb: string, opts: ThumbnailOptions, ctx: OpContext): Promise<ThumbnailResult> { return this.ops.renderThumbnail(pcb, opts, ctx) }
  // schematic / BOM / netlist (P2-b) and DRC / ERC / stats (P2-d), gated on the probed help (cli-ops.ts)
  exportSchematicSvgs(sch: string, ctx: OpContext, opts?: SchematicSvgOptions): Promise<SchematicSheet[]> { return this.ops.exportSchematicSvgs(sch, ctx, opts) }
  exportBom(input: { sch?: string; pcb?: string }, opts: BomOptions, ctx: OpContext): Promise<BomRow[]> { return this.ops.exportBom(input, opts, ctx) }
  netlist(sch: string, ctx: OpContext): Promise<Netlist> { return this.ops.netlist(sch, ctx) }
  exportFab(_pcb: string, _opts: FabOptions, _ctx: OpContext): Promise<FabResult> { return this.unsupported('fab') }
  drc(pcb: string, opts: { sch?: string }, ctx: OpContext): Promise<CheckReport> { return this.ops.drc(pcb, opts, ctx) }
  erc(sch: string, ctx: OpContext): Promise<CheckReport> { return this.ops.erc(sch, ctx) }
  stats(pcb: string, ctx: OpContext): Promise<BoardStatsResult> { return this.ops.stats(pcb, ctx) }
}

/** Image names for the configured versions: template "kicad/kicad:{version}" x ["8.0", "9.0"]. */
export function dockerImages(template: string, versions: string[]): string[] {
  return versions.map(v => template.replace('{version}', v))
}

/** Locally present kicad/kicad images (empty when docker is missing). */
export async function listDockerImages(docker = 'docker', repo = 'kicad/kicad'): Promise<string[]> {
  const r = await run(docker, ['image', 'ls', repo, '--format', '{{.Repository}}:{{.Tag}}'], { timeoutMs: 30_000 })
  if (r.code !== 0) return []
  return r.out.map(l => l.trim()).filter(l => l.startsWith(`${repo}:`) && !l.endsWith(':<none>'))
}
