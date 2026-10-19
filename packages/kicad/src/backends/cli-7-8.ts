// cli-7-8: KiCad 7 and 8 through kicad-cli (works with any kicad-cli; selection uses it
// when the probe finds `pcb export svg` without --mode-multi).
//
//   layer SVGs  one `pcb export svg --layers <L> -o <file>` call per layer; 7.0.0 to 7.0.x
//               before --drill-shape-opt cannot cut holes (a warning says so)
//   3D model    KiCad 8: vrml (no --no-dnp before 9), glb, step; KiCad 7: step only,
//               so the VRML / GLB model is unavailable (the model stage says why)
//   thumbnail   no `pcb render` before 9: unavailable, the thumbnail stage falls back
//               to a layer composite (vite-plugin stages/thumbnail.ts)
//   schematic   `sch export svg` (7+); netlist and BOM from `sch export netlist` (7+)
//   DRC / ERC   `pcb drc` / `sch erc --format json` (8+; KiCad 7 has neither)
//   stats       the board file's numbers (`pcb export stats` only exists from 10)
//   fab         not implemented here (generic bundle: cli-modern)
// See cli-ops.ts for flags and layer naming.

import { UnsupportedError } from '../errors.ts'
import type {
  BoardInfo, BoardStatsResult, BomOptions, BomRow, Capabilities, CheckReport, Export3dOptions, FabOptions, FabResult,
  KicadBackend, KicadInstall, KicadVersion, LayerSvgFile, LayerSvgOptions, Model3dResult, Netlist, OpContext, Operation,
  ProbeResult, SchematicSheet, SchematicSvgOptions, ThumbnailOptions, ThumbnailResult,
} from '../types.ts'
import { CliOps, NativeRunner, withNetlistBom, type CliRunner } from './cli-ops.ts'
import { limitTo, parseBoardFile } from './common.ts'

/** Operations implemented here; each is on only where the probed help has the command (capabilitiesFromHelp). */
const IMPLEMENTED: ReadonlySet<Operation> = new Set<Operation>(['boardInfo', 'layerSvg', 'model3d', 'thumbnail',
  'schematicSvg', 'bom', 'netlist', 'drc', 'erc', 'stats'])

export class Cli78Backend implements KicadBackend {
  readonly id = 'cli-7-8' as const
  readonly install: KicadInstall
  readonly version: KicadVersion | null
  readonly capabilities: Capabilities
  private readonly ops: CliOps

  constructor(probe: ProbeResult, runner: CliRunner = new NativeRunner(probe.install.cli!)) {
    this.install = probe.install
    this.version = probe.version
    this.capabilities = withNetlistBom(limitTo(probe.capabilities, IMPLEMENTED), probe.help)
    this.ops = new CliOps(this.id, probe.install, probe.version, probe.help, runner)
  }

  private unsupported(op: Operation): never {
    throw new UnsupportedError(this.id, op, `not implemented for kicad-cli ${this.version?.raw ?? '7/8'}`)
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
