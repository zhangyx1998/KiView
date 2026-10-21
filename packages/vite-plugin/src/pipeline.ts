// The export pipeline, independent of Vite: discovers boards, runs every stage of
// every board through the stage cache (stages/types.ts), keeps the last good
// result when a run fails, and assembles the client Boards (contract.ts).
// The Vite plugin (index.ts) drives it; tests can drive it directly.

import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { readBoard, schematicFileSet, Semaphore, type KicadToolkit, type OpContext } from '@kiview/kicad'

import { assembleBoard } from './board.ts'
import type { ResolvedConfig } from './config.ts'
import type { Board } from './contract.ts'
import { discoverBoards } from './discover.ts'
import { STAGES } from './stages/index.ts'
import type { BoardSource, Snapshot, Stage, StageContext, StageInput, StageRecord } from './stages/types.ts'

export const ASSET_DIR = 'board-assets'
const STAGE_JSON = 'stage.json'

export interface Logger {
  info(m: string): void
  warn(m: string): void
  error(m: string): void
}

/** Outcome of one stage for one board. */
export interface StageState {
  stage: string
  /** Served result (fresh or stale), null if none. */
  record: StageRecord | null
  dir: string | null
  /** Why the stage did not run for this board. */
  skipped: string | null
  /** Why the last run failed (the record, if any, is then an older one: stale). */
  error: string | null
  stale: boolean
}

export interface BoardEntry {
  src: BoardSource
  input: StageInput | null
  stages: Map<string, StageState>
  /** Reading the board failed (truncated file, ...); stages are from an earlier refresh. */
  error: string | null
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The published files' content hashes, the asset ids (StageRecord.hashes). */
async function hashFiles(dir: string, files: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const f of files) out[f] = sha256(await readFile(join(dir, f))).slice(0, 16)
  return out
}

/** stage.json of a result dir; a record from before content hashes gets them now (and is rewritten). */
async function loadRecord(dir: string): Promise<StageRecord | null> {
  let record: StageRecord
  try { record = JSON.parse(await readFile(join(dir, STAGE_JSON), 'utf8')) as StageRecord } catch { return null }
  if (!record.hashes) {
    try {
      record.hashes = await hashFiles(dir, record.files)
      await writeFile(join(dir, STAGE_JSON), JSON.stringify(record, null, 2))
    } catch { return null }
  }
  return record
}

/** Newest complete result of a stage, whatever its key (fallback when a run fails). */
async function latestRecord(stageDir: string): Promise<{ dir: string; record: StageRecord } | null> {
  let best: { dir: string; record: StageRecord; t: number } | null = null
  for (const k of await readdir(stageDir).catch(() => [] as string[])) {
    if (k.startsWith('.')) continue
    const dir = join(stageDir, k)
    const record = await loadRecord(dir)
    if (!record) continue
    const t = (await stat(join(dir, STAGE_JSON))).mtimeMs
    if (!best || t > best.t) best = { dir, record, t }
  }
  return best && { dir: best.dir, record: best.record }
}

/**
 * Every .kicad_sch of the project, name (relative to the project dir, posix
 * separators) + content: the files next to the board plus every sheet file the
 * hierarchy references, also in sub-directories. Sheet files outside the project dir
 * are not snapshotted (KiCad then cannot find them in the snapshot either).
 */
async function schematicFiles(src: BoardSource, log?: Logger): Promise<Record<string, string>> {
  if (!src.sch) return {}
  const files = (await readdir(src.dir)).filter(f => f.endsWith('.kicad_sch')).sort()
  const out = new Map<string, string>(await Promise.all(files.map(async f => [f, await readFile(join(src.dir, f), 'utf8')] as const)))
  const tree = await schematicFileSet(src.sch, undefined, f => log?.warn(`${src.name}: sheet file outside the project dir is ignored: ${f}`))
  for (const [name, text] of tree) out.set(name, text)
  return Object.fromEntries([...out].sort(([a], [b]) => a.localeCompare(b)))
}

export class Pipeline {
  readonly entries = new Map<string, BoardEntry>()
  readonly sem: Semaphore
  /** Called when a late stage of a board finished after the board was served (dev push). */
  onLate: ((name: string) => void) | null = null
  private ready: Promise<void> | null = null

  constructor(readonly config: ResolvedConfig, readonly kit: KicadToolkit, readonly log: Logger) {
    this.sem = new Semaphore(config.concurrency)
  }

  discover(): Promise<BoardSource[]> {
    return discoverBoards(this.config.root, this.config.boards, m => this.log.warn(m))
  }

  /** First full refresh (memoised). */
  ensureReady(waitLate = false): Promise<void> {
    this.ready ??= this.refreshAll(waitLate).then(() => undefined)
    return this.ready
  }

  /** Discover and refresh every board. Returns true when what is served changed. */
  async refreshAll(waitLate = false): Promise<boolean> {
    const t0 = performance.now()
    const sources = await this.discover()
    let changed = false
    for (const name of [...this.entries.keys()])
      if (!sources.some(s => s.name === name)) { this.entries.delete(name); changed = true }
    const results = await Promise.all(sources.map(s => this.refresh(s, waitLate)))
    changed ||= results.some(Boolean)
    const ok = this.boards().length
    this.log.info(`${ok}/${sources.length} boards ready in ${((performance.now() - t0) / 1000).toFixed(2)} s`)
    return changed
  }

  /**
   * Re-export one board (or reuse the cache). Never throws. Core stages are awaited;
   * late ones too when `waitLate` (a build), else they finish in the background and
   * call onLate. Returns true when the core of what is served changed.
   */
  async refresh(src: BoardSource, waitLate = false): Promise<boolean> {
    const prev = this.entries.get(src.name)
    const before = prev ? this.coreSignature(prev) : null
    const entry: BoardEntry = { src, input: null, stages: new Map(prev?.stages), error: null }
    this.entries.set(src.name, entry)

    try {
      const pcb = await readFile(src.pcb, 'utf8')
      const pro = src.pro ? await readFile(src.pro, 'utf8').catch(() => null) : null
      const schFiles = await schematicFiles(src, this.log)
      const sch = src.sch ? Object.entries(schFiles).map(([f, t]) => `${f}\0${t}`).join('\0') : null
      const info = readBoard(pcb)   // throws on a truncated / invalid file
      const backend = this.kit.backendFor(info.formatVersion, 'pcb')
      if (!backend) {
        // explain() names the KiCad version the file needs and the installs found (P2-a)
        const why = this.kit.explain?.(info.formatVersion, 'pcb')
          ?? `format ${info.formatVersion} needs KiCad ${info.minKicad}+; ${this.kit.describe()}`
        this.log.warn(`${src.name}: no KiCad install can open it: ${why}`)
      }
      entry.input = { src, info, hash: sha256(pcb).slice(0, 12), contents: { pcb, pro, sch }, schFiles, backend, config: this.config }
    } catch (e) {
      entry.error = errorText(e)
      // keep serving the previous results, or the newest cached ones after a restart
      for (const stage of STAGES) {
        if (entry.stages.get(stage.name)?.record) continue
        const last = await latestRecord(join(this.config.cacheDir, src.name, stage.name))
        if (last) entry.stages.set(stage.name, { stage: stage.name, record: last.record, dir: last.dir, skipped: null, error: null, stale: true })
      }
      this.log.error(`${src.name}: cannot read the board: ${entry.error}` +
                     (this.hasCore(entry) ? ' (serving the previous export)' : ' (board skipped)'))
      return before !== this.coreSignature(entry)
    }

    const input = entry.input
    let snapshot: Promise<Snapshot> | null = null
    const work = join(this.config.cacheDir, src.name, `.snap-${randomBytes(4).toString('hex')}`)
    const getSnapshot = () => (snapshot ??= this.makeSnapshot(input, work))

    const run = (stage: Stage) => this.runStage(entry, stage, getSnapshot).then(s => {
      if (this.entries.get(src.name) === entry) entry.stages.set(stage.name, s)
    })
    const core = Promise.all(STAGES.filter(s => !s.late).map(run))
    const late = Promise.all(STAGES.filter(s => s.late).map(run))
    const cleanup = Promise.all([core, late]).finally(() => rm(work, { recursive: true, force: true }))

    await core
    if (waitLate) await cleanup
    else void cleanup.then(() => { if (this.entries.get(src.name) === entry) this.onLate?.(src.name) })
    return before !== this.coreSignature(entry)
  }

  private async makeSnapshot(input: StageInput, dir: string): Promise<Snapshot> {
    const { src, contents } = input
    await mkdir(dir, { recursive: true })
    const pcb = join(dir, `${src.name}.kicad_pcb`)
    await writeFile(pcb, contents.pcb)
    let pro: string | null = null
    if (contents.pro !== null) { pro = join(dir, `${src.name}.kicad_pro`); await writeFile(pro, contents.pro) }
    let sch: string | null = null
    for (const [name, text] of Object.entries(input.schFiles)) {
      await mkdir(dirname(join(dir, name)), { recursive: true })
      await writeFile(join(dir, name), text)
    }
    if (src.sch) sch = join(dir, `${src.name}.kicad_sch`)
    return { dir, pcb, sch, pro }
  }

  private async runStage(entry: BoardEntry, stage: Stage, snapshot: () => Promise<Snapshot>): Promise<StageState> {
    const input = entry.input!
    const { src } = input
    const state: StageState = { stage: stage.name, record: null, dir: null, skipped: null, error: null, stale: false }
    const skipped = stage.skip?.(input) ?? null
    if (skipped) return { ...state, skipped }

    const stageDir = join(this.config.cacheDir, src.name, stage.name)
    const key = sha256(JSON.stringify([
      stage.name, stage.version, await stage.recipe(input),
      input.backend?.id ?? null, input.backend?.version?.raw ?? null,
      ...stage.inputs.map(i => input.contents[i]),
    ])).slice(0, 16)
    const dir = join(stageDir, key)
    const hit = await loadRecord(dir)
    if (hit) return { ...state, record: hit, dir }

    const work = join(stageDir, `.work-${key}-${randomBytes(4).toString('hex')}`)
    const outDir = join(work, 'out')
    const workDir = join(work, 'tmp')
    const warnings: string[] = []
    const warn = (m: string) => { warnings.push(m); this.log.warn(`${src.name}: ${stage.name}: ${m}`) }
    const op = (wd?: string): OpContext => ({
      workDir: wd ?? workDir,
      vars: { KIPRJMOD: src.dir, ...this.config.env },
      timeoutMs: 180_000,
      warn,
    })
    const t0 = performance.now()
    try {
      await mkdir(outDir, { recursive: true })
      await mkdir(workDir, { recursive: true })
      const ctx: StageContext = { ...input, snapshot, outDir, workDir, sem: this.sem, op, warn }
      const out = await stage.run(ctx)
      const record: StageRecord = {
        stage: stage.name, key, result: out.result, files: out.files, hashes: await hashFiles(outDir, out.files), warnings,
        seconds: Math.round((performance.now() - t0) / 10) / 100,
        kicad: input.backend ? `${input.backend.version?.raw ?? '?'} ${input.backend.id}` : null,
      }
      await writeFile(join(outDir, STAGE_JSON), JSON.stringify(record, null, 2))
      if (existsSync(dir)) await rm(dir, { recursive: true, force: true })
      await rename(outDir, dir)
      // older results of this stage are no longer needed
      for (const k of await readdir(stageDir))
        if (k !== key && !k.startsWith('.')) await rm(join(stageDir, k), { recursive: true, force: true })
      this.log.info(`${src.name}: ${stage.name} in ${record.seconds.toFixed(2)} s`)
      return { ...state, record, dir }
    } catch (e) {
      const error = errorText(e)
      const last = entry.stages.get(stage.name)?.record ? entry.stages.get(stage.name)! : await latestRecord(stageDir)
      const fallback = last && last.record && last.dir ? { record: last.record, dir: last.dir } : null
      this.log.error(`${src.name}: ${stage.name} failed: ${error}` +
                     (fallback ? ' (serving the previous result)' : ''))
      return { ...state, error, record: fallback?.record ?? null, dir: fallback?.dir ?? null, stale: !!fallback }
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  private hasCore(e: BoardEntry): boolean {
    return !!(e.stages.get('layers')?.record || e.stages.get('model')?.record)
  }

  /** Changes when a core stage serves something else (full reload in dev). */
  private coreSignature(e: BoardEntry): string {
    return JSON.stringify([e.input?.hash ?? null, ...STAGES.filter(s => !s.late).map(s => e.stages.get(s.name)?.record?.key ?? null)])
  }

  /** The asset path (under ASSET_DIR) of a stage's file: addressed by the file's content hash. */
  assetPath(name: string, stage: string, record: StageRecord, file: string): string {
    return `${name}/${stage}/${record.hashes?.[file] ?? record.key}/${file}`
  }

  assetUrl(name: string, stage: string, record: StageRecord, file: string): string {
    return `${this.config.base}${ASSET_DIR}/${this.assetPath(name, stage, record, file).split('/').map(encodeURIComponent).join('/')}`
  }

  /** Dev: the cache file an asset path (as assetPath() makes them, decoded) is served from. */
  assetFile(path: string): string | null {
    for (const [p, file] of this.assetFiles(false)) if (p === `${ASSET_DIR}/${path}`) return file
    return null
  }

  board(name: string): Board | null {
    const e = this.entries.get(name)
    if (!e || !this.hasCore(e)) return null
    return assembleBoard(e, this)
  }

  /** The manifest: every board with at least a layer set or a model, sorted by name. */
  boards(): Board[] {
    return [...this.entries.keys()].map(n => this.board(n)).filter((b): b is Board => !!b)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Files to publish in a build: [asset path under the out dir, source path]. `served`: only boards in the manifest. */
  assetFiles(served = true): [string, string][] {
    const out: [string, string][] = []
    for (const e of this.entries.values()) {
      if (served && !this.board(e.src.name)) continue
      for (const s of e.stages.values()) {
        if (!s.record || !s.dir) continue
        for (const f of s.record.files) out.push([`${ASSET_DIR}/${this.assetPath(e.src.name, s.stage, s.record, f)}`, join(s.dir, f)])
      }
    }
    return out
  }

  /** Debug view: per board and stage, what is served and why. */
  status(): unknown {
    return [...this.entries.values()].map(e => ({
      name: e.src.name,
      pcb: relative(this.config.root, e.src.pcb),
      error: e.error,
      formatVersion: e.input?.info.formatVersion ?? null,
      backend: e.input?.backend ? `${e.input.backend.id} ${e.input.backend.version?.raw}` : null,
      stages: Object.fromEntries([...e.stages.values()].map(s => [s.stage, {
        key: s.record?.key ?? null, seconds: s.record?.seconds ?? null, warnings: s.record?.warnings ?? [],
        skipped: s.skipped, error: s.error, stale: s.stale,
      }])),
    }))
  }
}
