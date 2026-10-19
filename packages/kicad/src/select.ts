// openKicad(): discover installs, probe them, and pick a backend per file.
//
// Selection for a file with `(version YYYYMMDD)`:
//   1. the oldest KiCad major that opens it comes from versions.ts;
//   2. candidates are the usable installs at or above that major that match
//      `kicad.version` ("9", ">=8 <10"), in tiers: kicad-cli installs, then pcbnew
//      Python (installs without kicad-cli, KiCad 5 / 6, or the Python of a kicad-cli
//      that cannot export VRML, KiCad 7), then kicad/kicad images (`kicad.docker.enabled`);
//   3. within a tier `kicad.prefer` orders them: 'newest' (default: the most capable
//      install, the richest features) or 'oldest' (the export matches the KiCad the
//      file was made with);
//   4. the first candidate is the backend. Operations it cannot do (`pcb render` before
//      KiCad 9, VRML in KiCad 7, ...) go to the next candidate that can, so a KiCad 8
//      board can be plotted by KiCad 8 and rendered by KiCad 10 (FallbackBackend).
// None fits: backendFor() returns null and explain() names the KiCad version needed.
//
// Backend per install: cli-modern (kicad-cli with --mode-multi SVG), cli-7-8 (other
// kicad-cli), pcbnew-python (an install without kicad-cli, KiCad 5 / 6), docker (images);
// `kicad.backend` forces one ('pcbnew-python' probes the install's Python instead).

import { CliModernBackend } from './backends/cli-modern.ts'
import { Cli78Backend } from './backends/cli-7-8.ts'
import { DockerBackend, dockerImages, listDockerImages } from './backends/docker.ts'
import { PcbnewPythonBackend } from './backends/pcbnew-python.ts'
import { discoverInstalls, dockerInstalls } from './installs.ts'
import { noCapabilities, probeCli, probeDocker, probePython } from './probe.ts'
import type {
  BackendId, BoardInfo, BoardStatsResult, BomOptions, BomRow, Capabilities, CheckReport, Export3dOptions, FabOptions,
  FabResult, KicadBackend, KicadInstall, KicadOptions, KicadToolkit, KicadVersion, LayerSvgFile, LayerSvgOptions,
  Model3dResult, Netlist, OpContext, Operation, ProbeResult, SchematicSheet, ThumbnailOptions, ThumbnailResult,
} from './types.ts'
import { minKicadFor, needsKicadMessage } from './versions.ts'

export function createBackend(probe: ProbeResult, id: BackendId = probe.backend): KicadBackend {
  switch (id) {
    case 'cli-modern': return new CliModernBackend(probe)
    case 'cli-7-8': return new Cli78Backend(probe)
    case 'pcbnew-python': return new PcbnewPythonBackend(probe)
    case 'docker': return new DockerBackend(probe)
  }
}

/** Does a major version satisfy "auto" | "9" | ">=8" | "<10" | ">=8 <10"? */
export function versionMatches(major: number, spec: string | undefined): boolean {
  if (!spec || spec === 'auto' || spec === 'latest') return true
  return spec.trim().split(/\s+/).every(part => {
    const m = /^(>=|<=|>|<|=)?(\d+)(?:\.\d+)*$/.exec(part)
    if (!m) throw new Error(`kicad.version: cannot read "${spec}" (use "9", ">=8" or "<10")`)
    const v = Number(m[2])
    switch (m[1]) {
      case '>=': return major >= v
      case '<=': return major <= v
      case '>': return major > v
      case '<': return major < v
      default: return major === v
    }
  })
}

const cmpVersion = (a: KicadVersion, b: KicadVersion) => a.major - b.major || a.minor - b.minor || a.patch - b.patch

/** Selection rules over probe results, without I/O (tests drive it with fake probes). */
export interface SelectionOptions {
  version?: string
  prefer?: 'oldest' | 'newest'
}

/** Selection tier: kicad-cli installs, then pcbnew Python, then docker images. */
const tier = (p: ProbeResult) => (p.install.kind === 'docker' ? 2 : p.backend === 'pcbnew-python' ? 1 : 0)

/**
 * Probes that can open a file of this format, best first: by tier, then by `prefer`.
 * Unusable probes (error / no version) never qualify.
 */
export function rankCandidates(probes: ProbeResult[], formatVersion: number, kind: 'pcb' | 'sch',
                               o: SelectionOptions = {}): ProbeResult[] {
  const min = minKicadFor(formatVersion, kind)
  const sign = (o.prefer ?? 'newest') === 'oldest' ? 1 : -1
  return probes
    .filter(p => !p.error && p.version && p.version.major >= min && versionMatches(p.version.major, o.version))
    .sort((a, b) => tier(a) - tier(b) || sign * cmpVersion(a.version!, b.version!))
}

/** Why no probe fits, in one line naming the KiCad version the file needs. */
export function explainNoFit(probes: ProbeResult[], formatVersion: number, kind: 'pcb' | 'sch', o: SelectionOptions = {}): string {
  const usable = probes.filter(p => !p.error && p.version)
  const where = (p: ProbeResult) => p.install.image ?? (p.backend === 'pcbnew-python' ? p.install.python : p.install.cli) ?? p.install.id
  const have = usable.length
    ? `found ${usable.map(p => `KiCad ${p.version!.raw} (${where(p)})`).join(', ')}`
    : 'no usable KiCad install found'
  const filtered = o.version && o.version !== 'auto' ? `; kicad.version is "${o.version}"` : ''
  return `${needsKicadMessage(formatVersion, kind)}; ${have}${filtered}. Install KiCad ${minKicadFor(formatVersion, kind)}+ ` +
    `(or set kicad.cli / KICAD_CLI_<ver>, or kicad.docker.enabled with a kicad/kicad image)`
}

// ------------------------------------------------------------------- fallback chain

const OPS: Operation[] = ['boardInfo', 'layerSvg', 'model3d', 'thumbnail', 'schematicSvg', 'bom', 'netlist', 'fab', 'drc', 'erc', 'stats']

/**
 * The first backend serves everything it can; each operation it lacks goes to the
 * first later backend that has it. id / install / version are the primary's.
 */
export class FallbackBackend implements KicadBackend {
  readonly id: BackendId
  readonly install: KicadInstall
  readonly version: KicadVersion | null
  readonly capabilities: Capabilities
  private readonly byOp: Map<Operation, KicadBackend>

  constructor(readonly chain: KicadBackend[]) {
    const primary = chain[0]!
    this.id = primary.id
    this.install = primary.install
    this.version = primary.version
    this.byOp = new Map(OPS.map(op => [op, chain.find(b => b.capabilities.ops[op]) ?? primary]))
    const caps = (op: Operation) => this.byOp.get(op)!.capabilities
    const formats = [...new Set(chain.flatMap(b => (b.capabilities.ops.model3d ? b.capabilities.model3d.formats : [])))]
    this.capabilities = {
      ops: Object.fromEntries(OPS.map(op => [op, chain.some(b => b.capabilities.ops[op])])) as Record<Operation, boolean>,
      layerSvg: caps('layerSvg').layerSvg,
      model3d: { formats, noDnp: caps('model3d').model3d.noDnp },
      thumbnail: caps('thumbnail').thumbnail,
      fab: caps('fab').fab,
    }
  }

  /** The backend that serves an operation (for logs and the status page). */
  serving(op: Operation): KicadBackend { return this.byOp.get(op)! }

  private for3d(format: string): KicadBackend {
    return this.chain.find(b => b.capabilities.ops.model3d && b.capabilities.model3d.formats.includes(format as never)) ?? this.byOp.get('model3d')!
  }

  boardInfo(pcb: string): Promise<BoardInfo> { return this.byOp.get('boardInfo')!.boardInfo(pcb) }
  exportLayerSvgs(pcb: string, layers: string[], opts: LayerSvgOptions, ctx: OpContext): Promise<LayerSvgFile[]> {
    return this.byOp.get('layerSvg')!.exportLayerSvgs(pcb, layers, opts, ctx)
  }
  export3d(pcb: string, opts: Export3dOptions, ctx: OpContext): Promise<Model3dResult> { return this.for3d(opts.format).export3d(pcb, opts, ctx) }
  renderThumbnail(pcb: string, opts: ThumbnailOptions, ctx: OpContext): Promise<ThumbnailResult> {
    return this.byOp.get('thumbnail')!.renderThumbnail(pcb, opts, ctx)
  }
  exportSchematicSvgs(sch: string, ctx: OpContext): Promise<SchematicSheet[]> { return this.byOp.get('schematicSvg')!.exportSchematicSvgs(sch, ctx) }
  exportBom(input: { sch?: string; pcb?: string }, opts: BomOptions, ctx: OpContext): Promise<BomRow[]> {
    return this.byOp.get('bom')!.exportBom(input, opts, ctx)
  }
  netlist(sch: string, ctx: OpContext): Promise<Netlist> { return this.byOp.get('netlist')!.netlist(sch, ctx) }
  exportFab(pcb: string, opts: FabOptions, ctx: OpContext): Promise<FabResult> { return this.byOp.get('fab')!.exportFab(pcb, opts, ctx) }
  drc(pcb: string, opts: { sch?: string }, ctx: OpContext): Promise<CheckReport> { return this.byOp.get('drc')!.drc(pcb, opts, ctx) }
  erc(sch: string, ctx: OpContext): Promise<CheckReport> { return this.byOp.get('erc')!.erc(sch, ctx) }
  stats(pcb: string, ctx: OpContext): Promise<BoardStatsResult> { return this.byOp.get('stats')!.stats(pcb, ctx) }
}

// --------------------------------------------------------------------------- toolkit

/** Probe one install the way `backend` wants it driven. */
function probeInstall(i: KicadInstall, o: KicadOptions): Promise<ProbeResult> {
  if (i.kind === 'docker') return probeDocker(i, { cacheDir: o.cacheDir })
  if (o.backend === 'pcbnew-python' || !i.cli) {
    if (i.python) return probePython(i, { cacheDir: o.cacheDir })
    return Promise.resolve({
      install: i, version: null, help: {}, backend: 'pcbnew-python', ms: 0,
      error: 'no kicad-cli and no Python with pcbnew', capabilities: noCapabilities(),
    })
  }
  return probeCli(i, { cacheDir: o.cacheDir })
}

/** The docker images to consider: configured versions through the template, else the local kicad/kicad tags. */
async function dockerCandidates(o: KicadOptions): Promise<KicadInstall[]> {
  const d = o.docker
  if (!d?.enabled && o.backend !== 'docker') return []
  const template = d?.image ?? 'kicad/kicad:{version}'
  const images = d?.versions?.length ? dockerImages(template, d.versions) : await listDockerImages('docker', template.split(':')[0])
  return dockerInstalls(images)
}

/**
 * The backend driving a probe: docker images and pcbnew-Python probes keep theirs; a
 * kicad-cli probe takes a forced 'cli-modern' / 'cli-7-8'. ('pcbnew-python' is forced
 * at probe time, 'docker' by leaving natives out.)
 */
export function backendIdFor(p: ProbeResult, o: Pick<KicadOptions, 'backend'>): BackendId {
  if (p.install.kind === 'docker') return 'docker'
  if (p.backend === 'pcbnew-python') return 'pcbnew-python'
  if (o.backend === 'cli-modern' || o.backend === 'cli-7-8') return o.backend
  return p.backend
}

/** A toolkit over given probes (openKicad() after discovery; tests with fake probes). */
export function toolkitFromProbes(probes: ProbeResult[], o: KicadOptions = {},
                                  make: (p: ProbeResult, id: BackendId) => KicadBackend = createBackend): KicadToolkit {
  const sorted = [...probes].sort((a, b) => (b.version && a.version ? cmpVersion(b.version, a.version) : (b.version ? 1 : 0) - (a.version ? 1 : 0)))
  const cache = new Map<string, KicadBackend>()
  const backendOf = (p: ProbeResult): KicadBackend => {
    const id = backendIdFor(p, o)
    const key = `${p.install.id}\0${id}`
    let b = cache.get(key)
    if (!b) { b = make(p, id); cache.set(key, b) }
    return b
  }
  const sel: SelectionOptions = { version: o.version, prefer: o.prefer }
  const chains = new Map<string, KicadBackend | null>()
  const usable = sorted.filter(p => !p.error && p.version)
  return {
    installs: sorted,
    backendFor(formatVersion: number, kind: 'pcb' | 'sch' = 'pcb'): KicadBackend | null {
      const key = `${kind}:${formatVersion}`
      if (chains.has(key)) return chains.get(key)!
      const ranked = rankCandidates(sorted, formatVersion, kind, sel).map(backendOf)
      const b = ranked.length === 0 ? null : ranked.length === 1 ? ranked[0]! : new FallbackBackend(ranked)
      chains.set(key, b)
      return b
    },
    explain(formatVersion: number, kind: 'pcb' | 'sch' = 'pcb'): string {
      return explainNoFit(sorted, formatVersion, kind, sel)
    },
    describe(): string {
      if (!usable.length) {
        const why = sorted.map(p => `${p.install.cli ?? p.install.image ?? p.install.python}: ${p.error}`).join('; ')
        return `no usable KiCad found${why ? ` (${why})` : ''}; install KiCad or set kicad.cli / KICAD_CLI`
      }
      const name = (p: ProbeResult) => (p.install.kind === 'docker' ? `docker ${p.install.image}` : p.backend === 'pcbnew-python' ? 'pcbnew' : 'kicad-cli')
      const at = (p: ProbeResult) => p.install.cli && p.install.kind !== 'docker' && p.backend !== 'pcbnew-python' ? p.install.cli : p.install.python ?? ''
      const id = (p: ProbeResult) => backendIdFor(p, o)
      return usable.map(p => `${name(p)} ${p.version!.raw} (${id(p)})${at(p) ? ` at ${at(p)}` : ''}`).join(', ') +
        ` [prefer ${o.prefer ?? 'newest'}]`
    },
  }
}

export async function openKicad(o: KicadOptions = {}): Promise<KicadToolkit> {
  // backend 'docker' uses images only
  const natives = o.backend === 'docker' ? [] : await discoverInstalls(o)
  const installs = [...natives, ...await dockerCandidates(o)]
  if (o.modelDir) for (const i of installs) if (i.kind === 'native') i.modelDir = o.modelDir
  const probes = await Promise.all(installs.map(i => probeInstall(i, o)))
  // the Python of a kicad-cli without VRML (KiCad 7) as a fallback for the 3D model
  const extra = await Promise.all(probes
    .filter(p => p.install.kind === 'native' && p.install.cli && p.install.python && p.backend !== 'pcbnew-python'
      && !p.error && !p.capabilities.model3d.formats.includes('vrml'))
    .map(p => probePython(p.install, { cacheDir: o.cacheDir })))
  return toolkitFromProbes([...probes, ...extra.filter(p => !p.error)], o)
}

