// The CLIENT DATA CONTRACT: what the Vite plugin hands the browser app.
//
//   import { boards } from 'virtual:kiview/boards'   // Board[], sorted by name
//   import { site } from 'virtual:kiview/site'       // SiteData
//
// Metadata and URLs only: heavy data (SVGs, models, BOM / parts / netlist JSON)
// are separate assets under <base>board-assets/<Name>/<stage>/<key>/..., fetched on
// demand. Asset keys are content hashes, so every asset URL is immutable.
//
// Dev: when a board's data changed (a re-export after an edit, a late stage such as
// the fab bundle finishing, a board added or removed) the plugin sends the HMR event
// BOARD_EVENT with the new Board (null: removed); the page is not reloaded.
//
// Types only (no runtime code besides constants), so the client can import them.
// Markers: [phase 1] filled now; [P2-x] the field exists, phase 2 fills it (until
// then it is null and the matching `features` entry says why).

import type {
  BackendId, BoardGeometry, BomRow, CheckReport, FabItem, FeatureId, Footprint, LayerKind, LayerSide, Netlist, SchematicSheet, Severity,
  TitleBlock, BoardStatsResult,
} from '@kiview/kicad/types'

export type { BoardGeometry, BomRow, CheckReport, FabItem, FeatureId, Footprint, LayerKind, LayerSide, Netlist, Severity, TitleBlock }
export type BoardStats = BoardStatsResult

export const BOARDS_MODULE = 'virtual:kiview/boards'
export const SITE_MODULE = 'virtual:kiview/site'
/** HMR event: data is BoardEvent. */
export const BOARD_EVENT = 'kiview:board'
/** Dev only: JSON status of every board (manifest, per-stage errors, timings). */
export const STATUS_PATH = '__kiview.json'

export interface BoardEvent { name: string; board: Board | null }

export interface SiteData {
  title: string
  description: string | null
  /** Single-board site (config `single`): the board the root URL shows, or null for the card home page. */
  single: string | null
  /** Logo URL (resolved against base), or null. */
  logo: string | null
  theme: { appearance: 'dark' | 'light' | 'auto'; accent: string | null; vars: Record<string, string> }
  generator: { name: 'kiview'; version: string }
  /** The KiCad installs used, for the footer / about box. */
  kicad: string
}

export interface BoardLayer {
  id: string          // KiCad layer name, e.g. "F.Cu"
  name: string        // display name, e.g. "Front copper"
  kind: LayerKind
  side: LayerSide
  url: string         // SVG asset URL (see docs/architecture.md, "Layer SVGs")
  color: string       // suggested display colour (CSS)
  order: number       // stacking order, 0 = bottom-most when viewed from the front
}

export interface BoardModel { url: string; format: 'glb' | 'vrml'; bytes: number }

/** A downloadable fabrication bundle. [phase 1: custom hook; P2-c: generic] */
export interface BoardDownload {
  url: string
  filename: string
  bytes: number
  status: 'ok' | 'incomplete'
  /** What is missing for an order (empty when ok). */
  missing: string[]
  /** Files in the zip, for the tooltip. */
  contents: string[]
  /** Generic bundle: every deliverable with its outcome (produced / skipped / failed + reason). [P2-c, additive] */
  items?: FabItem[]
}

export type FeatureStatus = { available: true } | { available: false; reason: string }

/** A JSON (or other) asset with its size. */
export interface AssetRef { url: string; bytes: number }

/** [P2-c] */
export interface BoardRevision {
  /** First 12 hex digits of the SHA-256 of the board file. [phase 1] */
  hash: string
  /** Title-block `rev`. [phase 1] */
  titleBlock: string | null
  /** Content of the project's VERSION file. [P2-c] */
  version: string | null
  /** Last commit touching the project dir. [P2-c] */
  git: {
    commit: string; short: string; tag: string | null; dirty: boolean; date: string
    /** `git describe --tags --always`, e.g. "v1.2.0-3-gabc1234". [P2-c, additive] */
    describe?: string | null
    /** Subject line of the commit. [P2-c, additive] */
    subject?: string
  } | null
  /** What to show: version, else tag, else title-block rev, else the short hash. [phase 1: rev or hash] */
  label: string
}

/** One layer of a revision diff. Before / after SVGs share `BoardDiff.bounds`. [P2-c, additive] */
export interface LayerDiff {
  id: string
  name: string
  kind: LayerKind
  side: LayerSide
  color: string
  order: number
  status: 'changed' | 'added' | 'removed' | 'unchanged'
  /** SVG of the layer at the base revision / now (null when absent or unchanged). */
  before: string | null
  after: string | null
}

/** Footprints that differ between the base revision and now, by reference. [P2-c, additive; needs P2-b footprints] */
export interface PartsDiff {
  added: string[]
  removed: string[]
  /** Position, rotation or side changed. */
  moved: string[]
  /** Value or footprint changed. */
  changed: string[]
}

/** "Changes since <ref>": the board now against an earlier git revision. [P2-c, additive; config revision.diff] */
export interface BoardDiff {
  /** The configured ref, e.g. "previous", "previous-tag", "HEAD~1". */
  ref: string
  /** The commit compared against; null when there is none (see note). */
  base: { commit: string; short: string; tag: string | null; date: string; subject: string } | null
  /** Why there is nothing to compare (no earlier commit, the board did not exist, ...). */
  note: string | null
  /** viewBox of every before / after SVG (union of both outlines plus margin). */
  bounds: { x: number; y: number; width: number; height: number }
  outlineChanged: boolean
  layers: LayerDiff[]
  /** null until footprints are parsed (P2-b). */
  parts: PartsDiff | null
  /** One line, e.g. "3 layers changed, 2 parts moved". */
  summary: string
}

/** A schematic sheet as shipped: the export record with its SVG as a URL. [P2-b] */
export type SchematicSheetRef = Omit<SchematicSheet, 'file'> & { url: string }

/** [P2-b] */
export interface BoardSchematic {
  /** Sheets in page order; `path` / `parent` give the hierarchy, the first is the root. */
  sheets: SchematicSheetRef[]
}

/** Payload of Board.bom.url. [P2-b] */
export interface BomData { rows: BomRow[]; fields: string[] }
/** Payload of Board.parts.url: placed footprints for cross-probing. [P2-b] */
export interface PartsData {
  footprints: Footprint[]
  /** Board thickness in mm (stackup), for 3D markers. [P2-b, additive] */
  thickness?: number | null
}
/** Payload of Board.netlist.url. [P2-b] */
export type NetlistData = Netlist

/** One build variant of a board in assembly mode. [assembly, additive] */
export interface AssemblyVariantInfo {
  id: string
  label: string
  /** DNP parts this variant fits. */
  fit: string[]
  /** Fitted parts this variant leaves empty. */
  dnp: string[]
  /** Value overrides by refdes. */
  values: Record<string, string>
  note: string | null
}

/** Assembly-mode settings and notes of a board (config `assembly`, the notes file). [assembly, additive] */
export interface BoardAssembly {
  /** Sides in step order, e.g. ['back', 'front']. */
  sideOrder: ('front' | 'back')[]
  /** Board notes, markdown: the notes file (source: its path relative to the root), then the config's (source 'config'). */
  notes: { source: string; markdown: string }[]
  /** Notes by refdes from the config (fields named in `noteFields` add to them on the client). */
  refNotes: Record<string, string>
  /** Footprint / symbol fields read as per-part notes. */
  noteFields: string[]
  /** Explicit step order (refdes). */
  order: string[]
  variants: AssemblyVariantInfo[]
}

export interface ReportSummary { url: string; counts: Record<Severity, number> }

/** Payload of Board.geometry.url: copper by net (tracks, vias, pads, zone outlines). [P2-d] */
export type GeometryData = BoardGeometry

export interface Board {
  // ---- [phase 1] carried over from the MirrorLinkPCB viewer -------------------------
  name: string        // the .kicad_pcb stem; used in routes (/board/<name>)
  title: string       // title-block title, else the split name ("LEDStrip" -> "LED Strip")
  model: BoardModel | null
  layers: BoardLayer[]
  bounds: { x: number; y: number; width: number; height: number }  // mm, the shared SVG viewBox
  size: { width: number; height: number }                           // mm, extent of the outline
  thumbnail: { url: string; width: number; height: number } | null  // small preview of the front
  copperLayers: number
  /** Content hash of the board file (12 hex). Prefer rev.label for display. */
  revision: string
  /** Fabrication bundle; absent when there is none. */
  download?: BoardDownload

  // ---- [phase 1] new ----------------------------------------------------------------
  /** Effective solder-mask colour (config override, else the stackup's front mask), as KiCad names it. */
  maskColor: string | null
  titleBlock: TitleBlock
  kicad: {
    formatVersion: number
    minKicad: number
    /** Version of the KiCad that exported this board, e.g. "10.0.6". */
    exportedWith: string | null
    backend: BackendId | null
  }
  /** Project files, relative to the root (for display / source links). */
  files: { pcb: string; sch: string | null; pro: string | null }
  /** What the UI may offer for this board; hide what is unavailable. */
  features: Record<FeatureId, FeatureStatus>
  rev: BoardRevision

  // ---- [P2-b] schematic, BOM, cross-probing -----------------------------------------
  schematic: BoardSchematic | null
  bom: AssetRef | null        // BomData
  parts: AssetRef | null      // PartsData
  netlist: AssetRef | null    // NetlistData

  // ---- [P2-c] revision diff (opt-in: config revision.diff) ---------------------------
  /** Changes since an earlier revision; absent when the diff is off or unavailable. [additive] */
  diff?: BoardDiff | null

  // ---- [P2-d] stats, reports --------------------------------------------------------
  stats: BoardStats | null
  reports: { drc: ReportSummary | null; erc: ReportSummary | null }
  /** Copper geometry by net (GeometryData) for net highlight / measure; absent until the stats stage ran. [P2-d] */
  geometry?: AssetRef | null

  // ---- [assembly] assembly mode, BOM options (additive) ------------------------------
  /** Assembly-mode settings and notes; absent before the assembly stage ran. */
  assembly?: BoardAssembly | null
  /** BOM pane options from the config: `showDnp` lists DNP parts in the BOM table (default false). */
  bomOptions?: { showDnp: boolean }
}
