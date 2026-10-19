// The STAGE contract: one export step of a board (layers, 3D model, thumbnail,
// fab bundle; phase 2 adds schematic, bom, parts, netlist, revision, stats, drc,
// erc). Each stage is one module in this directory, registered in stages/index.ts;
// adding a stage touches no other file.
//
// Caching: a stage's result lives in <cacheDir>/<Name>/<stage>/<key>/ with its files
// and a stage.json. <key> hashes the stage name and version, its recipe (settings),
// the KiCad backend and version, and the content of the project files it reads, so
// an entry never changes once written and its files are served as immutable. A
// stage whose key already has a stage.json is not run again. If a run fails, the
// newest earlier result of that stage is served (marked stale).

import type { BoardInfo, FeatureId, KicadBackend, OpContext, Semaphore } from '@kiview/kicad'

import type { ResolvedConfig } from '../config.ts'
import type { Board } from '../contract.ts'

/** A discovered project. Paths are absolute. */
export interface BoardSource {
  /** The .kicad_pcb stem, unique across the site. */
  name: string
  dir: string
  pcb: string
  sch: string | null
  pro: string | null
}

/** Snapshot copies of the project files, taken once per refresh (what every stage reads). */
export interface Snapshot {
  dir: string
  /** <dir>/<Name>.kicad_pcb */
  pcb: string
  sch: string | null
  pro: string | null
}

/** What a stage knows about the board before running. */
export interface StageInput {
  src: BoardSource
  info: BoardInfo
  /** First 12 hex of the SHA-256 of the board file. */
  hash: string
  /** File contents the key is computed from (pcb, pro, every .kicad_sch of the project). */
  contents: { pcb: string; pro: string | null; sch: string | null }
  /** The project's .kicad_sch files by name (the snapshot holds exactly these). */
  schFiles: Record<string, string>
  backend: KicadBackend | null
  config: ResolvedConfig
}

export interface StageContext extends StageInput {
  /** Snapshot of the project files; created on first use. */
  snapshot(): Promise<Snapshot>
  /** Write published files here (they become <stage>/<key>/<file> assets). */
  outDir: string
  /** Scratch space, removed after the run. */
  workDir: string
  /** Bounds the number of KiCad processes; wrap every backend call. */
  sem: Semaphore
  /** OpContext for backend calls (work dir, path variables incl. KIPRJMOD and config.env, timeout). */
  op(workDir?: string): OpContext
  warn(message: string): void
}

export interface StageOutput<R> {
  result: R
  /** Published files, relative to outDir (posix separators). */
  files: string[]
}

export interface Stage<R = unknown> {
  /** Directory and asset-path name, e.g. "layers". */
  name: string
  /** Bump when the stage's output changes for the same inputs. */
  version: string
  /** Project files whose content is part of the key. */
  inputs: ('pcb' | 'sch' | 'pro')[]
  /** Features this stage provides (their status follows the stage's outcome). */
  provides: FeatureId[]
  /** Late stages do not hold back the board: in dev their result is pushed when ready. */
  late?: boolean
  /** A reason not to run for this board (feature then unavailable), or null to run. */
  skip?(input: StageInput): string | null
  /** Settings that shape the output (JSON-serialisable); part of the key. */
  recipe(input: StageInput): unknown | Promise<unknown>
  run(ctx: StageContext): Promise<StageOutput<R>>
  /** Fold the result into the client Board. `url(file)` gives a file's asset URL. */
  apply(board: Board, result: R, url: (file: string) => string): void
}

/** What stage.json holds. */
export interface StageRecord<R = unknown> {
  stage: string
  key: string
  result: R
  files: string[]
  warnings: string[]
  seconds: number
  /** "10.0.6 cli-modern", for the status page. */
  kicad: string | null
}
