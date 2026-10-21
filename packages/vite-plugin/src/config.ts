// The CONFIG SCHEMA: what `kiview.config.ts` may contain, its defaults, and
// resolution to absolute paths. The CLI loads the file; the Vite plugin consumes
// the resolved form. Documented in docs/config.md (keep both in sync).
//
// Markers: [phase 1] works now; [P2-x] accepted and validated, filled by phase 2.

import { availableParallelism } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

import type { KicadBackend, KicadOptions } from '@kiview/kicad'

import type { BoardRevision } from './contract.ts'

export interface ThemeConfig {
  /** Colour scheme. [phase 1: 'dark' only; P2-d: 'light' and 'auto'] Default 'dark'. */
  appearance?: 'dark' | 'light' | 'auto'
  /** Accent colour (links, focus, selection), any CSS colour. [phase 1] */
  accent?: string
  /** Raw CSS custom properties set on :root, e.g. { '--bg': '#000' }. [phase 1] */
  vars?: Record<string, string>
}

export interface ServerConfig {
  /** Interface to listen on; true = all interfaces. Default 'localhost'. [phase 1] */
  host?: string | boolean
  /** Default 5173 (dev) / 4173 (preview). [phase 1] */
  port?: number
  /** Fail instead of trying the next port. Default false. [phase 1] */
  strictPort?: boolean
  /** Host names the dev / preview server answers. Default true (any host); a list restricts it. [phase 1] */
  allowedHosts?: string[] | true
}

/** What a custom fab hook gets. All paths are absolute. */
export interface FabHookContext {
  /** Board name (the .kicad_pcb file stem). */
  name: string
  /** The project directory (the user's files: read only). */
  projectDir: string
  /** Snapshot copies of the project files, exactly what the rest of the export used. */
  pcb: string
  sch: string | null
  pro: string | null
  /** Scratch directory for the hook's output; removed afterwards. */
  workDir: string
  /** The KiCad backend selected for the board (null if none is usable). */
  backend: KicadBackend | null
  /** Short content hash of the board file (12 hex digits). */
  hash: string
  /** The board's revision (VERSION file, git, title block). [P2-c, additive] */
  rev?: BoardRevision
  log: (message: string) => void
}

export interface FabHookResult {
  /** The zip to publish (anywhere; it is copied into the cache). */
  zip: string
  /** Download name; default the zip's file name. */
  filename?: string
  /** 'incomplete' shows a badge listing `missing`. Default 'ok'. */
  status?: 'ok' | 'incomplete'
  missing?: string[]
  /** Names of the files inside, for the tooltip. */
  contents?: string[]
}

/** Return a zip path, a result, or null for "no download for this board". */
export type FabHook = (ctx: FabHookContext) => Promise<string | FabHookResult | null>

export interface FabHookConfig {
  build: FabHook
  /**
   * Part of the cache key besides the board content: change it (e.g. return a hash
   * of your tool's sources) to rebuild the bundles. Default: the hook's source text.
   */
  recipe?: () => string | Promise<string>
}

/** Which side of a two-sided board is assembled first. [assembly] */
export type AssemblySideOrder = 'back-first' | 'front-first'

/** A build variant of a board (e.g. bus master / slave): parts fitted or left off, values changed. [assembly] */
export interface AssemblyVariant {
  /** Shown in the variant picker; default the variant's key. */
  label?: string
  /** DNP parts that this variant fits (they become steps). */
  fit?: string[]
  /** Fitted parts that this variant leaves empty. */
  dnp?: string[]
  /** Value overrides by refdes, e.g. { R1: '100 Ω' } (the part gets a step of its own). */
  values?: Record<string, string>
  /** One line (markdown) shown under the picker while the variant is chosen. */
  note?: string
}

/** Assembly mode settings of a board (all optional). [assembly] */
export interface AssemblyBoardConfig {
  /** Side order of the step list. Default 'back-first'. */
  sideOrder?: AssemblySideOrder
  /** Notes (markdown) shown at the top of the assembly pane, after the notes file. */
  notes?: string
  /** Markdown file next to the board read as notes; false for none. Default 'ASSEMBLY.md'. */
  notesFile?: string | false
  /** Notes by refdes, shown on the part's step, e.g. { R1: '100 Ω on the bus master' }. */
  refNotes?: Record<string, string>
  /** Explicit step order: refdes; the step holding a ref comes in this order (within its side), before the others. */
  order?: string[]
  /** Build variants by id (e.g. { master: {...}, slave: {...} }). */
  variants?: Record<string, AssemblyVariant>
}

export interface UserConfig {
  /** Site title (top bar, page title). [phase 1] Default 'KiCad boards' (the board's title on a single-board site). */
  title?: string
  /** One line under the title on the home page. [phase 1] */
  description?: string
  /** Logo: a URL, a data: URI, or an image path relative to the root. [phase 1] */
  logo?: string
  theme?: ThemeConfig

  /**
   * Where the projects are, relative to the root: directories (each `<dir>/<Name>/<Name>.kicad_pcb`
   * and `<dir>/<Name>.kicad_pcb` is a board) and/or globs matching .kicad_pcb files
   * (`"hw/**\/*.kicad_pcb"`). [phase 1] Default ['.'].
   */
  boards?: string | string[]
  /**
   * Single-board site: the root URL is the board's viewer, with no home page, board list
   * or "all boards" link (the diff and report pages move to `/diff`, `/drc`, `/erc`).
   * 'auto' (the default): when the folder holds exactly one board; `true`: the only
   * board (the build fails with several); `false`: always the card home page; a name:
   * that board.
   */
  single?: boolean | 'auto' | string
  /** Public base path of the site, e.g. '/boards/'. [phase 1] Default '/'. */
  base?: string
  /** Build output, relative to the root. [phase 1] Default '.kiview/dist'. */
  outDir?: string
  /** Export cache, relative to the root. [phase 1] Default '.kiview/cache'. */
  cacheDir?: string

  /** Which KiCad to use and how to find it. [phase 1: cli, version, modelDir; P2-a: backend, docker] */
  kicad?: KicadOptions
  /** Extra KiCad path variables (and process env), e.g. { MYLIB_3D: '/libs/3d' }. [phase 1] */
  env?: Record<string, string>

  /**
   * Solder-mask colour for the 3D model and thumbnail. Default: the board's own
   * stackup colour. A string applies to every board; a record maps board names. [phase 1]
   */
  maskColor?: string | Record<string, string>
  /** 3D model format. [phase 1] Default 'vrml' (carries VRML-only part models; glb has refdes names). */
  modelFormat?: 'vrml' | 'glb'
  /** Card thumbnail size in px, or false to skip. [phase 1] Default 640 x 400. */
  thumbnail?: { width: number; height: number } | false
  /** Margin around the outline in the shared layer viewBox, mm. [phase 1] Default 1. */
  margin?: number
  /** Max KiCad processes at once. [phase 1] Default min(4, cores / 2). */
  concurrency?: number

  /**
   * Fabrication downloads: 'generic' (Gerbers, drills, position file, BOM, schematic PDF,
   * 3D model; [P2-c]), a custom hook ([phase 1]), or false. Default 'generic'.
   */
  fab?: false | 'generic' | FabHook | FabHookConfig

  /**
   * Revision sources. [P2-c] Default { git: true, versionFile: 'VERSION', diff: false }.
   * `diff` (opt-in) adds a layer diff and a "changes since" summary against an earlier
   * git revision: true / 'previous' (the version before the current one), 'previous-tag',
   * or any git revision ('HEAD~1', 'v1.0', a hash). Needs `git`.
   */
  revision?: { git?: boolean; versionFile?: string | false; diff?: boolean | string }

  /** Schematic pages. [P2-b] Default { drawingSheet: true }. */
  schematic?: {
    /** Draw the drawing sheet (frame, title block) on the sheet SVGs. Default true. */
    drawingSheet?: boolean
    /** kicad-cli colour theme for the sheets; default the project's own. */
    theme?: string
  }

  /** BOM pane. Default { showDnp: false }: DNP parts are left out of the BOM table. */
  bom?: {
    /** List DNP parts in the BOM table (in their own section); a record maps board names. Default false. */
    showDnp?: boolean | Record<string, boolean>
  }

  /**
   * Assembly mode (the board page's Assembly tab): site-wide defaults, `boards` per board name
   * (a board's entry wins key by key). `noteFields` are footprint / symbol fields read as
   * per-part notes. Default { sideOrder: 'back-first', notesFile: 'ASSEMBLY.md',
   * noteFields: ['Assembly Note', 'Assembly Notes', 'Assembly'] }.
   */
  assembly?: AssemblyBoardConfig & { noteFields?: string[]; boards?: Record<string, AssemblyBoardConfig> }

  server?: ServerConfig
}

/** defineConfig() is the identity; it only gives the editor the types. */
export function defineConfig(config: UserConfig): UserConfig {
  return config
}

/** UserConfig with defaults applied and paths absolute. */
export interface ResolvedConfig {
  root: string
  /** null: not configured (the plugin uses the single board's title, else 'KiCad boards'). */
  title: string | null
  description: string | null
  logo: string | null
  theme: Required<Pick<ThemeConfig, 'appearance'>> & { accent: string | null; vars: Record<string, string> }
  boards: string[]
  /** 'auto', false, true (the only board) or a board name; see pickSingle(). */
  single: boolean | 'auto' | string
  base: string
  outDir: string
  cacheDir: string
  kicad: KicadOptions
  env: Record<string, string>
  maskColor: (board: string) => string | null
  modelFormat: 'vrml' | 'glb'
  thumbnail: { width: number; height: number } | false
  margin: number
  concurrency: number
  fab: false | 'generic' | FabHookConfig
  revision: { git: boolean; versionFile: string | false; diff: string | null }
  schematic: { drawingSheet: boolean; theme: string | null }
  bom: { showDnp: (board: string) => boolean }
  /** A board's assembly settings, defaults applied (the board entry over the site-wide ones). */
  assembly: (board: string) => ResolvedAssembly
  server: ServerConfig
}

export interface ResolvedAssembly {
  sideOrder: AssemblySideOrder
  notes: string | null
  notesFile: string | false
  refNotes: Record<string, string>
  order: string[]
  variants: Record<string, AssemblyVariant>
  noteFields: string[]
}

export const DEFAULT_NOTE_FIELDS = ['Assembly Note', 'Assembly Notes', 'Assembly']

function resolveAssembly(a: UserConfig['assembly'], name: string): ResolvedAssembly {
  const b = a?.boards?.[name] ?? {}
  return {
    sideOrder: b.sideOrder ?? a?.sideOrder ?? 'back-first',
    notes: b.notes ?? a?.notes ?? null,
    notesFile: b.notesFile ?? a?.notesFile ?? 'ASSEMBLY.md',
    refNotes: { ...a?.refNotes, ...b.refNotes },
    order: b.order ?? a?.order ?? [],
    variants: b.variants ?? a?.variants ?? {},
    noteFields: a?.noteFields ?? DEFAULT_NOTE_FIELDS,
  }
}

const abs = (root: string, p: string) => (isAbsolute(p) ? p : resolve(root, p))

export const DEFAULT_TITLE = 'KiCad boards'

/**
 * The board a single-board site shows, from `single` and the discovered board names:
 * the named board, or the only one ('auto': only when there is exactly one). `problem`
 * says why the choice is doubtful (the build fails on it, the dev server warns and
 * shows `name`, or the home page when null).
 */
export function pickSingle(single: boolean | 'auto' | string, names: readonly string[]): { name: string | null; problem: string | null } {
  if (!single) return { name: null, problem: null }
  if (single === 'auto') return { name: names.length === 1 ? names[0]! : null, problem: null }
  const list = names.length ? names.join(', ') : 'none'
  if (typeof single === 'string') {
    return { name: single, problem: names.includes(single) ? null : `single: no board named "${single}" (boards: ${list})` }
  }
  if (names.length === 1) return { name: names[0]!, problem: null }
  if (names.length === 0) return { name: null, problem: 'single: no board found' }
  return { name: names[0]!, problem: `single: true needs exactly one board, found ${names.length} (${list}); name one with single: "${names[0]}" or narrow the boards option` }
}

export function resolveConfig(user: UserConfig, root: string): ResolvedConfig {
  const base = user.base ?? '/'
  if (!base.startsWith('/') || !base.endsWith('/')) throw new Error(`base must start and end with "/" (got "${base}")`)
  const mask = user.maskColor
  const cacheDir = abs(root, user.cacheDir ?? '.kiview/cache')
  return {
    root,
    title: user.title ?? null,
    description: user.description ?? null,
    logo: user.logo ?? null,
    theme: { appearance: user.theme?.appearance ?? 'dark', accent: user.theme?.accent ?? null, vars: user.theme?.vars ?? {} },
    boards: [user.boards ?? '.'].flat(),
    single: user.single ?? 'auto',
    base,
    outDir: abs(root, user.outDir ?? '.kiview/dist'),
    cacheDir,
    kicad: { cacheDir, ...user.kicad },
    env: user.env ?? {},
    maskColor: (name: string) => (typeof mask === 'string' ? mask : mask?.[name] ?? null),
    modelFormat: user.modelFormat ?? 'vrml',
    thumbnail: user.thumbnail ?? { width: 640, height: 400 },
    margin: user.margin ?? 1,
    concurrency: user.concurrency ?? Math.max(1, Math.min(4, availableParallelism() >> 1)),
    fab: typeof user.fab === 'function' ? { build: user.fab } : user.fab ?? 'generic',
    revision: {
      git: user.revision?.git ?? true,
      versionFile: user.revision?.versionFile ?? 'VERSION',
      diff: user.revision?.diff === true ? 'previous' : user.revision?.diff || null,
    },
    schematic: { drawingSheet: user.schematic?.drawingSheet ?? true, theme: user.schematic?.theme ?? null },
    bom: { showDnp: (name: string) => { const v = user.bom?.showDnp; return typeof v === 'boolean' ? v : v?.[name] ?? false } },
    assembly: (name: string) => resolveAssembly(user.assembly, name),
    server: user.server ?? {},
  }
}
