// @kiview/kicad: the KiCad abstraction-layer CONTRACT.
//
// Everything a caller (the Vite plugin, tests, other tools) may rely on is declared
// here. This file has no runtime code and no Node imports, so the browser client can
// `import type` from it (`@kiview/kicad/types`) for the JSON payloads
// (footprints, BOM rows, netlist, schematic sheets) that the plugin ships as assets.
//
// Stability: names and shapes here are the phase-1 contract. Phase-2 work FILLS IN
// implementations behind it; changes to shapes go through docs/architecture.md.
// Markers used below:
//   [phase 1]  implemented in phase 1
//   [P2-a]     backends, probing, docker, version selection
//   [P2-b]     schematic, BOM, netlist, footprints for cross-probing
//   [P2-c]     fabrication bundle, revision / diff
//   [P2-d]     stats, DRC/ERC
//
// Units: millimetres, KiCad board coordinates (x right, y DOWN), angles in degrees
// counter-clockwise as KiCad stores them, unless stated otherwise.

// =====================================================================================
// Installs, versions, backends
// =====================================================================================

export type BackendId =
  | 'cli-modern'     // KiCad 9+: kicad-cli with --mode-multi SVG, pcb render, glb/vrml       [phase 1]
  | 'cli-7-8'        // KiCad 7/8: kicad-cli, one SVG call per layer, VRML only, no render    [P2-a]
  | 'pcbnew-python'  // KiCad 5/6 (and a fallback): KiCad's Python with the pcbnew module     [P2-a]
  | 'docker'         // any of the above run inside kicad/kicad:<ver>                          [P2-a]

export interface KicadVersion {
  major: number
  minor: number
  patch: number
  /** Exactly what the tool printed, e.g. "10.0.6" or "9.0.1-rc1". */
  raw: string
}

/** Where an install was found. */
export type InstallSource = 'config' | 'env' | 'env-versioned' | 'macos-bundle' | 'linux' | 'windows' | 'path' | 'docker'

/** One KiCad installation (native or a Docker image), before or after probing. */
export interface KicadInstall {
  /** Stable id, e.g. "cli:/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli" or "docker:kicad/kicad:9.0". */
  id: string
  kind: 'native' | 'docker'
  source: InstallSource
  /** kicad-cli executable (native) or the path inside the container (docker). */
  cli?: string
  /** A Python 3 that can `import pcbnew` (bundled with the install when known). */
  python?: string
  /** Docker image, e.g. "kicad/kicad:9.0".  [P2-a] */
  image?: string
  /** Stock 3D model library of this install (sets KICAD<n>_3DMODEL_DIR). */
  modelDir?: string
  /** Version hint from discovery (env var suffix, bundle name); the probe is authoritative. */
  versionHint?: string
}

/** Operations of a backend; also the unit capabilities are declared in. */
export type Operation =
  | 'boardInfo'
  | 'layerSvg'
  | 'model3d'
  | 'thumbnail'
  | 'schematicSvg'
  | 'bom'
  | 'netlist'
  | 'fab'
  | 'drc'
  | 'erc'
  | 'stats'

export type ModelFormat = 'vrml' | 'glb' | 'step'

/**
 * What a probed install can do. Derived from `kicad-cli version` and from parsing
 * `--help` of each subcommand (see probe.ts), never from a hard-coded version table.
 */
export interface Capabilities {
  /** Whether each operation is available at all. */
  ops: Record<Operation, boolean>
  layerSvg: {
    /** One call plots many layers into one file each (`--mode-multi`, KiCad 9+). */
    multiFile: boolean
    /** `--drill-shape-opt` (needed to cut drill holes out of layers). */
    drillShape: boolean
    /** `--page-size-mode` (absolute board coordinates). */
    pageSizeMode: boolean
  }
  model3d: {
    formats: ModelFormat[]
    /** `--no-dnp` (leave unfitted parts out). */
    noDnp: boolean
  }
  thumbnail: {
    /** `pcb render` (KiCad 9+). Without it the caller falls back (client-side render or copper SVG). */
    render: boolean
  }
  fab: {
    gerbers: boolean
    drill: boolean
    pos: boolean
    ipcd356: boolean
    schematicPdf: boolean
  }
}

/** Raw `--help` facts per command path ("pcb export svg") the capabilities were derived from. */
export interface HelpFacts {
  /** Subcommands listed under "Subcommands:" (empty for leaf commands). */
  subcommands: string[]
  /** Long flags mentioned in the help text, e.g. "--mode-multi". */
  flags: string[]
}

export interface ProbeResult {
  install: KicadInstall
  version: KicadVersion | null
  /** Facts per command path; the probe cache stores these. */
  help: Record<string, HelpFacts>
  capabilities: Capabilities
  /** Backend this install is driven by. */
  backend: BackendId
  /** Why the install is unusable, if it is. */
  error: string | null
  /** Milliseconds the probe took (0 when it came from the cache). */
  ms: number
}

// =====================================================================================
// Operation inputs
// =====================================================================================

/** Passed to every operation. */
export interface OpContext {
  /** Scratch directory owned by the caller; outputs are written inside it. */
  workDir: string
  /**
   * Path variables handed to KiCad (`-D NAME=value` for kicad-cli): KIPRJMOD,
   * KICAD<n>_3DMODEL_DIR and user variables from the config (`env`).
   */
  vars: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  /** Non-fatal notes (missing 3D models, ...). */
  warn?: (message: string) => void
}

export interface LayerSvgOptions {
  /** true: plot drill shapes (holes) into the layers; false: plot without them. */
  holes: boolean
}

export interface Export3dOptions {
  format: ModelFormat
  /** Leave DNP / unfitted parts out. Default true. */
  noDnp?: boolean
}

export interface ThumbnailOptions {
  /** Pixel size of the image to produce (callers usually ask for 2x and shrink). */
  width: number
  height: number
  side?: 'top' | 'bottom'
  /** Use the board's stackup colours (mask, silk). Default true. */
  stackupColors?: boolean
}

export interface BomOptions {
  /** Extra symbol fields to report besides the standard ones (MPN, Manufacturer, ...). Default: all fields. */
  fields?: string[]
  /** Group identical parts into one row. Default true. */
  group?: boolean
}

/** [P2-b, additive] */
export interface SchematicSvgOptions {
  /** Draw the drawing sheet (frame and title block). Default true. */
  drawingSheet?: boolean
  /** kicad-cli colour theme name; default: the schematic's own settings. */
  theme?: string
}

export interface FabOptions {
  /** The schematic, for the schematic PDF and the BOM CSV. */
  sch?: string
  /** Include the 3D model (STEP) in the bundle. Default true. */
  model?: boolean
  /** File name of the zip inside the work dir. Default `<board stem>-fab.zip`. [P2-c, additive] */
  zipName?: string
}

// =====================================================================================
// Operation outputs
// =====================================================================================

export type LayerKind = 'copper' | 'silkscreen' | 'mask' | 'paste' | 'fab' | 'courtyard' | 'edge' | 'other'
export type LayerSide = 'front' | 'back' | 'inner' | 'both'

export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

/** One entry of the board's layer table. */
export interface LayerEntry {
  number: number
  /** Canonical name, e.g. "F.SilkS". */
  name: string
  /** signal / power / mixed / jumper / user ... */
  type: string
  /** User name, e.g. "F.Silkscreen". */
  userName?: string
}

export interface TitleBlock {
  title: string | null
  rev: string | null
  date: string | null
  company: string | null
  comments: string[]
}

export interface Stackup {
  /** Solder-mask colour from the stackup, e.g. "Black", "Green" or "#2B4E2FD4". Null when unset. */
  maskColor: { front: string | null; back: string | null }
  silkColor: { front: string | null; back: string | null }
  /** e.g. "ENIG", "HAL lead-free". */
  finish: string | null
  /** Board thickness in mm, from (general (thickness)). */
  thickness: number | null
  copperLayers: number
}

export interface Pad {
  /** Pad number / name, e.g. "1", "A3", "" for mechanical pads. */
  number: string
  type: 'smd' | 'thru_hole' | 'np_thru_hole' | 'connect'
  shape: 'circle' | 'rect' | 'oval' | 'trapezoid' | 'roundrect' | 'chamfered_rect' | 'custom'
  /** Centre in board coordinates. */
  at: Point
  /** Absolute rotation in degrees. */
  rotation: number
  size: { width: number; height: number }
  drill: { width: number; height: number } | null
  /** Layers the pad is on, e.g. ["F.Cu", "F.Mask", "F.Paste"] (wildcards expanded). */
  layers: string[]
  net: { code: number; name: string } | null
  pinFunction?: string
  pinType?: string
}

/** A placed footprint, enough for cross-probing between BOM, 2D, 3D and schematic. */
export interface Footprint {
  /** Reference designator, e.g. "R12". */
  ref: string
  value: string
  /** Library id, e.g. "Resistor_SMD:R_0603_1608Metric". */
  footprint: string
  side: 'front' | 'back'
  at: Point
  rotation: number
  /** Axis-aligned box in board coordinates: courtyard if present, else pads + fab/silk graphics. */
  bbox: Rect
  pads: Pad[]
  /** All properties (Datasheet, MPN, Manufacturer, user fields). */
  fields: Record<string, string>
  dnp: boolean
  excludeFromBom: boolean
  excludeFromPos: boolean
  /** Schematic symbol path ("/<sheet uuid>/<symbol uuid>"), links the footprint to its symbol. */
  path: string | null
}

export interface BoardInfo {
  /** The file's `(version YYYYMMDD)`. */
  formatVersion: number
  /** Oldest KiCad major release that can open the file (from versions.ts). */
  minKicad: number
  generator: string | null
  generatorVersion: string | null
  titleBlock: TitleBlock
  layers: LayerEntry[]
  /** Layer names some item is actually drawn on. */
  usedLayers: string[]
  /** Extent of the Edge.Cuts outline, null when the board has none. */
  outline: Rect | null
  stackup: Stackup
  /** Placed footprints. [P2-b] phase 1 returns []. */
  footprints: Footprint[]
}

export interface LayerSvgFile {
  /** Canonical layer name. */
  layer: string
  /** Absolute path of the raw SVG in absolute board coordinates (not yet normalised). */
  file: string
}

export interface Model3dResult {
  file: string
  format: ModelFormat
  bytes: number
  warnings: string[]
}

export interface ThumbnailResult {
  /** PNG file (transparent background) as rendered, not yet cropped or shrunk. */
  file: string
  width: number
  height: number
}

/** One schematic sheet instance (hierarchical). [P2-b] */
export interface SchematicSheet {
  /** Instance path: "/" for the root, "/<uuid>/" ... for sub-sheets. */
  path: string
  /** Sheet name as shown in the hierarchy (root: the project name). */
  name: string
  /** Source file, relative to the project dir, e.g. "power.kicad_sch". */
  source: string
  /** Page number as printed. */
  page: string
  /** Path of the parent sheet, null for the root. */
  parent: string | null
  /** SVG of the sheet (absolute path while exporting; the plugin turns it into a URL). */
  file: string
  titleBlock: TitleBlock
  /** Symbols on this sheet, for cross-probing: ref -> bbox in sheet units (mm). */
  symbols: { ref: string; bbox: Rect }[]
  /** Box of this sheet's symbol on the parent sheet (parent sheet mm), for click-to-open; null for the root. [P2-b, additive] */
  symbolBox?: Rect | null
}

/** One BOM row (grouped by value + footprint + fields unless `group: false`). [P2-b] */
export interface BomRow {
  refs: string[]
  quantity: number
  value: string
  /** Library id of the footprint. */
  footprint: string
  /** Datasheet, MPN, Manufacturer, user fields (all, or those asked for). */
  fields: Record<string, string>
  dnp: boolean
  excludeFromBom: boolean
}

export interface NetNode {
  ref: string
  pin: string
  pinFunction?: string
  pinType?: string
}

export interface Net {
  code: number
  name: string
  netClass?: string
  nodes: NetNode[]
}

/** [P2-b] */
export interface Netlist {
  nets: Net[]
}

/** One deliverable of the generic fabrication bundle. [P2-c, additive] */
export type FabItemId = 'gerbers' | 'drill' | 'drillMap' | 'ipcd356' | 'pos' | 'bom' | 'schematicPdf' | 'model'

/** What became of one fab deliverable: produced, skipped (with the reason: capability, no schematic, ...) or failed. [P2-c, additive] */
export interface FabItem {
  id: FabItemId
  label: string
  /** Needed for a bare-board order (Gerbers, drill); a required item that is not ok makes the bundle incomplete. */
  required: boolean
  status: 'ok' | 'skipped' | 'failed'
  /** Paths inside the zip. */
  files: string[]
  reason: string | null
}

/** Generic fabrication bundle. [P2-c] */
export interface FabResult {
  /** The zip, absolute path inside the work dir. */
  zip: string
  /** Names of the files inside the zip. */
  contents: string[]
  /** 'incomplete' when something an order needs could not be produced. */
  status: 'ok' | 'incomplete'
  missing: string[]
  warnings: string[]
  /** Every deliverable with its outcome. [P2-c, additive] */
  items: FabItem[]
}

export type Severity = 'error' | 'warning' | 'exclusion' | 'info'

export interface CheckViolation {
  type: string
  severity: Severity
  description: string
  /** Items involved, with positions (board mm, or sheet mm plus sheet path for ERC). */
  items: { description: string; pos: Point | null; sheet?: string; ref?: string }[]
}

/** DRC / ERC report. [P2-d] */
export interface CheckReport {
  kind: 'drc' | 'erc'
  kicadVersion: string | null
  date: string | null
  violations: CheckViolation[]
  /** Unconnected items (DRC only). */
  unconnected: CheckViolation[]
  /** Schematic parity issues (DRC only, when run with the schematic). */
  parity: CheckViolation[]
  counts: Record<Severity, number>
}

/** Board statistics. [P2-d] */
export interface BoardStatsResult {
  size: { width: number; height: number }
  copperLayers: number
  thickness: number | null
  footprints: { front: number; back: number; smd: number; tht: number }
  pads: number
  vias: number
  holes: { plated: number; nonPlated: number; minDiameter: number | null }
  minTrack: number | null
  minClearance: number | null

  // ---- [P2-d] additive: everything below is optional (older results lack it) ----------
  /** Layers in the board's layer table (copper, technical and user). */
  layerCount?: number
  /** Board area in mm² (kicad-cli; null when only the file was parsed). */
  area?: number | null
  /** Footprints by side and mounting type ('other': neither smd nor through_hole attribute). */
  parts?: { front: { smd: number; tht: number; other: number }; back: { smd: number; tht: number; other: number } }
  /** Pads by type. */
  padTypes?: { smd: number; tht: number; npth: number }
  /** Track segments (arcs count as one), their total length in mm and the widths used. */
  tracks?: { count: number; length: number; widths: { width: number; count: number }[] }
  /** Via (copper diameter, drill) sizes, most used first. */
  viaSizes?: { size: number; drill: number; type: 'through' | 'blind' | 'buried' | 'micro'; count: number }[]
  /** Drill sizes (slots: width != height), smallest first. */
  drills?: { width: number; height: number; plated: boolean; source: 'pad' | 'via'; count: number }[]
  /** Smallest copper ring around a plated hole, (size - drill) / 2, vias and pads. */
  minAnnularRing?: number | null
  /** Design-rule minimums from the project file (fab constraints), null when unknown. */
  rules?: {
    minClearance: number | null; minTrackWidth: number | null; minViaDiameter: number | null
    minViaAnnularRing: number | null; minHoleDiameter: number | null; minHoleToHole: number | null; minCopperEdgeClearance: number | null
  }
  /** The stackup: summary plus its physical layers from top to bottom. */
  stackup?: Stackup & { layers: StackupLayer[] }
  /** Where the numbers come from: the file parse, enriched by `kicad-cli pcb export stats` when available. */
  source?: 'file' | 'file+kicad-cli'
}

/** One physical layer of the stackup. [P2-d] */
export interface StackupLayer {
  name: string
  /** "copper", "core", "prepreg", "Top Solder Mask", ... */
  type: string
  thickness: number | null
  material: string | null
  epsilonR: number | null
  color: string | null
}

/** A pad of the copper geometry. [P2-d] */
export interface GeometryPad {
  /** Index into BoardGeometry.nets (0: no net). */
  net: number
  ref: string
  number: string
  at: Point
  /** Absolute rotation, degrees counter-clockwise. */
  rotation: number
  shape: 'circle' | 'oval' | 'rect' | 'roundrect'
  size: { width: number; height: number }
  drill: { width: number; height: number } | null
  /** Copper layers only. */
  layers: string[]
}

/**
 * Copper geometry by net, for net highlight and measuring. [P2-d]
 * Net references are indices into `nets` (index 0 is "no net"); point lists are
 * flat [x0, y0, x1, y1, ...] in board mm.
 */
export interface BoardGeometry {
  nets: string[]
  /** Copper layer names, front to back. */
  copper: string[]
  tracks: { net: number; layer: string; width: number; pts: number[] }[]
  vias: { net: number; at: Point; size: number; drill: number; layers: string[] }[]
  pads: GeometryPad[]
  /** Zone outlines (not the fill), one entry per copper layer of the zone. */
  zones: { net: number; layer: string; pts: number[] }[]
}

// =====================================================================================
// The backend interface
// =====================================================================================

/**
 * One way of driving KiCad. All paths are absolute. Inputs are snapshots the caller
 * owns (the backend must not modify them); outputs go inside `ctx.workDir`.
 *
 * An operation the backend cannot do throws `UnsupportedError` (errors.ts); callers
 * check `capabilities.ops` first, so that is a programming error, not a user error.
 * Other failures throw `Error` with a short, user-facing message.
 */
export interface KicadBackend {
  readonly id: BackendId
  readonly install: KicadInstall
  readonly version: KicadVersion | null
  readonly capabilities: Capabilities

  /** Board facts from the file (pure parse; backends may enrich). [phase 1; footprints P2-b] */
  boardInfo(pcb: string): Promise<BoardInfo>

  /** Raw SVG per layer in absolute board coordinates, one file each. [phase 1: cli-modern] */
  exportLayerSvgs(pcb: string, layers: string[], opts: LayerSvgOptions, ctx: OpContext): Promise<LayerSvgFile[]>

  /** 3D model of the board. [phase 1: cli-modern] */
  export3d(pcb: string, opts: Export3dOptions, ctx: OpContext): Promise<Model3dResult>

  /** Rendered picture of the board (front, isometric). [phase 1: cli-modern] */
  renderThumbnail(pcb: string, opts: ThumbnailOptions, ctx: OpContext): Promise<ThumbnailResult>

  /** One SVG per sheet instance, with the hierarchy. [P2-b] */
  exportSchematicSvgs(sch: string, ctx: OpContext, opts?: SchematicSvgOptions): Promise<SchematicSheet[]>

  /** BOM rows from the schematic (preferred) or the board. [P2-b] */
  exportBom(input: { sch?: string; pcb?: string }, opts: BomOptions, ctx: OpContext): Promise<BomRow[]>

  /** Nets and their nodes. [P2-b] */
  netlist(sch: string, ctx: OpContext): Promise<Netlist>

  /** Generic fabrication zip: Gerbers, drills, position file, BOM CSV, schematic PDF, 3D model. [P2-c] */
  exportFab(pcb: string, opts: FabOptions, ctx: OpContext): Promise<FabResult>

  /** Design-rule check (with schematic parity when `sch` is given). [P2-d] */
  drc(pcb: string, opts: { sch?: string }, ctx: OpContext): Promise<CheckReport>

  /** Electrical-rule check. [P2-d] */
  erc(sch: string, ctx: OpContext): Promise<CheckReport>

  /** Board statistics. [P2-d] */
  stats(pcb: string, ctx: OpContext): Promise<BoardStatsResult>
}

/** Chooses installs and backends; created once per run by `openKicad()` (select.ts). */
export interface KicadToolkit {
  /** Every install found and probed, newest first; unusable ones carry `error`. */
  readonly installs: ProbeResult[]
  /**
   * The backend to use for a file with this `(version YYYYMMDD)`; null when no
   * install can open it. Honours `KicadOptions.version` / `backend`.
   */
  backendFor(formatVersion: number, kind?: 'pcb' | 'sch'): KicadBackend | null
  /** One line for the log, e.g. "kicad-cli 10.0.6 (cli-modern) at /Applications/...". */
  describe(): string
  /**
   * Why backendFor() returns null for this format: the KiCad version the file needs and
   * the installs found, e.g. "the file (format 20260206) needs KiCad 10 or newer; found
   * KiCad 9.0.7 (/usr/bin/kicad-cli). Install KiCad 10+ ...". [P2-a]
   */
  explain?(formatVersion: number, kind?: 'pcb' | 'sch'): string
}

/** Options of `openKicad()`; the `kicad` section of kiview.config.ts. */
export interface KicadOptions {
  /** An explicit kicad-cli executable. Wins over discovery. */
  cli?: string
  /**
   * Which installed KiCad to use: "auto" (default: any install that can open the file;
   * `prefer` picks among them), a major version ("9"), or a range (">=8", "<10").
   */
  version?: string
  /**
   * Among the installs that can open a file, use the newest (default: the most
   * capable, the richest features) or the oldest (the export matches the KiCad the
   * file was saved with). Operations the chosen install lacks fall back to the next
   * one (select.ts). [P2-a]
   */
  prefer?: 'oldest' | 'newest'
  /** Force a backend instead of the one the probe suggests. */
  backend?: BackendId | 'auto'
  /** Docker settings for the docker backend. [P2-a] */
  docker?: {
    /** Use Docker images when no native install fits (or for operations natives lack). Default false. */
    enabled?: boolean
    /** Image name template; "{version}" is replaced. Default "kicad/kicad:{version}". */
    image?: string
    /** Versions to consider, e.g. ["7.0", "8.0", "9.0"]; default: the kicad/kicad images present locally (never pulled). */
    versions?: string[]
  }
  /** Stock 3D model library; default: the install's own (macOS bundle / /usr/share/kicad/3dmodels). */
  modelDir?: string
  /** Where probe results are cached (per binary path + mtime). Default: none (memory only). */
  cacheDir?: string
  /** Extra directories to search for installs. */
  searchPaths?: string[]
}

// =====================================================================================
// Features: what the UI can offer, derived from capabilities
// =====================================================================================

export type FeatureId =
  | 'layers'      // 2D layer browser
  | 'model3d'     // 3D viewer
  | 'thumbnail'   // rendered card image
  | 'schematic'   // [P2-b]
  | 'bom'         // [P2-b]
  | 'crossProbe'  // [P2-b]
  | 'netlist'     // [P2-b] / net highlight [P2-d]
  | 'fab'         // [P2-c]
  | 'drc'         // [P2-d]
  | 'erc'         // [P2-d]
  | 'stats'       // [P2-d]

/** Each feature declares the operations it needs (features.ts holds the table). */
export interface FeatureRequirement {
  requires: Operation[]
  /** Also needs these project files. */
  needsFiles?: ('pcb' | 'sch')[]
}
