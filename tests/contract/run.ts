// The contract runner: builds the examples site with whatever KiCad the probe finds,
// then checks every board against the contract. Used by the CI export matrix (one run
// per kicad/kicad image) and locally:
//
//   npm run build && node tests/contract/run.ts [options]
//
//   --root <dir>           projects folder (default examples/boards)
//   --out <dir>            output folder (default .contract-out): dist/, cache/,
//                          boards.json, status.json, contract-report.{json,md}
//   --kicad-cli <path>     use this kicad-cli (default: discovery, as the CLI does)
//   --kicad-version <spec> only use installs matching this (kicad.version), e.g. "<10"
//   --expect-kicad <spec>  fail unless a usable install matches, e.g. "9" or ">=10"
//   --expectations <file>  default tests/contract/expectations.json
//   --skip-build           reuse <out>/dist (only re-run the checks)
//   --clean                remove <out> first (cold cache)
//
// Checks (docs/ci.md):
//   - the site builds; the boards manifest validates against the schema (schema.ts);
//   - every board's format version / minimum KiCad / copper count is as expected, and a
//     backend is selected exactly when an install can open the file;
//   - every asset the manifest points at exists in dist/ (sizes, layer viewBox = bounds,
//     PNG dimensions), and the built JS embeds every board;
//   - features match the capabilities and stage outcomes (features.ts), plus the per-
//     backend floor in expectations.json; unavailable features are listed with reasons.
// Exit code 1 on any error. Notes (fallbacks, skipped stages) do not fail the run.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { openKicad, readBoard, versionMatches, type FeatureId } from '@kiview/kicad'
import { Pipeline } from '@kiview/vite-plugin'
import type { Board } from '@kiview/vite-plugin/contract'
import { build, loadConfig } from '@zdv/kiview'

import { STAGES } from '../../packages/vite-plugin/dist/stages/index.js'
import { checkFeatures, FEATURE_IDS, type FeatureFinding } from './features.ts'
import {
  bomDataSchema, checkReportSchema, geometryDataSchema, netlistDataSchema, partsDataSchema, validateBoards, validatePayload, type Check,
} from './schema.ts'

const REPO = resolve(import.meta.dirname, '../..')

const { values: opt } = parseArgs({
  options: {
    root: { type: 'string', default: join(REPO, 'examples/boards') },
    out: { type: 'string', default: join(REPO, '.contract-out') },
    'kicad-cli': { type: 'string' },
    'kicad-version': { type: 'string' },
    'expect-kicad': { type: 'string' },
    expectations: { type: 'string', default: join(REPO, 'tests/contract/expectations.json') },
    'skip-build': { type: 'boolean' },
    clean: { type: 'boolean' },
  },
})

interface BoardExpectation { formatVersion: number; minKicad: number; copperLayers: number }
interface Expectations { boards: Record<string, BoardExpectation>; require: Record<string, FeatureId[]> }
interface StageStatus { key: string | null; warnings: string[]; skipped: string | null; error: string | null; stale: boolean }
interface BoardStatus { name: string; error: string | null; stages: Record<string, StageStatus> }

interface BoardReport {
  name: string
  formatVersion: number | null
  minKicad: number | null
  backend: string | null
  inManifest: boolean
  available: FeatureId[]
  unavailable: { feature: FeatureId; reason: string }[]
  errors: string[]
  notes: string[]
}

const root = resolve(opt.root!)
const out = resolve(opt.out!)
const expectations: Expectations = JSON.parse(readFileSync(resolve(opt.expectations!), 'utf8'))
if (opt.clean) rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const globalErrors: string[] = []
const logLines: string[] = []
const log = {
  info: (m: string) => logLines.push(`info: ${m}`),
  warn: (m: string) => logLines.push(`warn: ${m}`),
  error: (m: string) => logLines.push(`error: ${m}`),
}

// ---- build ------------------------------------------------------------------------

const overrides = { outDir: join(out, 'dist'), cacheDir: join(out, 'cache') }
const { resolved } = await loadConfig(root, { command: 'build', overrides })
if (opt['kicad-cli']) resolved.kicad = { ...resolved.kicad, cli: resolve(opt['kicad-cli']) }
if (opt['kicad-version']) resolved.kicad = { ...resolved.kicad, version: opt['kicad-version'] }

const t0 = performance.now()
if (!opt['skip-build']) {
  console.log(`contract: building ${root} -> ${resolved.outDir}`)
  try {
    await build(resolved, { logLevel: 'warn' })
  } catch (e) {
    globalErrors.push(`site build failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
  }
}
const buildSeconds = (performance.now() - t0) / 1000

// ---- re-open the pipeline (warm cache: every stage is a cache hit) ---------------

const kit = await openKicad(resolved.kicad)
const usable = kit.installs.filter(i => !i.error && i.version && versionMatches(i.version.major, resolved.kicad.version))
console.log(`contract: ${kit.describe()}`)
if (opt['expect-kicad'] && !usable.some(i => versionMatches(i.version!.major, opt['expect-kicad']))) {
  globalErrors.push(`no usable KiCad install matches --expect-kicad "${opt['expect-kicad']}" (found: ${usable.map(i => i.version!.raw).join(', ') || 'none'})`)
}

const pipeline = new Pipeline(resolved, kit, log)
await pipeline.ensureReady(true)
const boards = pipeline.boards()
const status = pipeline.status() as BoardStatus[]
writeFileSync(join(out, 'boards.json'), JSON.stringify(boards, null, 2))
writeFileSync(join(out, 'status.json'), JSON.stringify({ kicad: kit.installs.map(i => ({ ...i, help: undefined })), boards: status }, null, 2))

for (const p of validateBoards(boards)) globalErrors.push(`schema: ${p}`)

// stage name -> features, and the set of features any stage provides
const stageFeatures = new Map(STAGES.map(s => [s.name, s.provides as FeatureId[]]))
const provided = new Set<FeatureId>(STAGES.flatMap(s => s.provides as FeatureId[]))

// ---- the built site -----------------------------------------------------------------

const dist = resolved.outDir
const jsText = (() => {
  const dir = join(dist, 'assets')
  if (!existsSync(dir)) return ''
  return readdirSync(dir).filter(f => f.endsWith('.js')).map(f => readFileSync(join(dir, f), 'utf8')).join('\n')
})()
if (!opt['skip-build'] && !existsSync(join(dist, 'index.html'))) globalErrors.push('dist/index.html is missing')

/** The dist file an asset URL points at. */
function assetFile(url: string): string | null {
  if (!url.startsWith(resolved.base)) return null
  return join(dist, ...url.slice(resolved.base.length).split('/').map(decodeURIComponent))
}

function checkAssets(b: Board, errors: string[]): void {
  const need = (url: string, what: string, bytes?: number): string | null => {
    const file = assetFile(url)
    if (!file) { errors.push(`${what}: URL ${url} is outside the base ${resolved.base}`); return null }
    if (!existsSync(file)) { errors.push(`${what}: ${url} is not in dist/`); return null }
    const size = statSync(file).size
    if (size === 0) errors.push(`${what}: ${url} is empty`)
    if (bytes !== undefined && bytes !== size) errors.push(`${what}: ${url} is ${size} bytes, the manifest says ${bytes}`)
    return file
  }
  for (const l of b.layers) {
    const file = need(l.url, `layer ${l.id}`)
    if (!file) continue
    const svg = readFileSync(file, 'utf8')
    const vb = /<svg[^>]*\bviewBox="([^"]+)"/.exec(svg)?.[1]?.trim().split(/[\s,]+/).map(Number)
    const want = [b.bounds.x, b.bounds.y, b.bounds.width, b.bounds.height]
    if (!vb || vb.length !== 4 || vb.some((v, i) => Math.abs(v - want[i]!) > 1e-3))
      errors.push(`layer ${l.id}: viewBox ${vb?.join(' ') ?? 'missing'} differs from bounds ${want.join(' ')}`)
  }
  if (new Set(b.layers.map(l => l.id)).size !== b.layers.length) errors.push('layers: duplicate layer ids')
  if (b.layers.length && b.layers.filter(l => l.kind === 'copper').length !== b.copperLayers)
    errors.push(`layers: ${b.layers.filter(l => l.kind === 'copper').length} copper layers exported, copperLayers says ${b.copperLayers}`)
  if (b.model) need(b.model.url, 'model', b.model.bytes)
  if (b.thumbnail) {
    const file = need(b.thumbnail.url, 'thumbnail')
    if (file) {
      const png = readFileSync(file)
      // the layer-composite fallback (P2-a, no `pcb render`) is an SVG
      if (b.thumbnail.url.endsWith('.svg')) { if (!/<svg[\s>]/.test(png.toString('utf8', 0, 512))) errors.push('thumbnail: not an SVG') }
      else if (png.readUInt32BE(0) !== 0x89504e47) errors.push('thumbnail: not a PNG')
      else if (png.readUInt32BE(16) !== b.thumbnail.width || png.readUInt32BE(20) !== b.thumbnail.height)
        errors.push(`thumbnail: PNG is ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}, the manifest says ${b.thumbnail.width}x${b.thumbnail.height}`)
    }
  }
  if (b.download) need(b.download.url, 'fab download', b.download.bytes)
  for (const s of b.schematic?.sheets ?? []) need(s.url, `schematic sheet ${s.path}`)
  // JSON payloads: present, the size the manifest says, and valid against their schema
  const payload = (url: string, what: string, schema: Check, bytes?: number): unknown => {
    const file = need(url, what, bytes)
    if (!file) return null
    try {
      const v = JSON.parse(readFileSync(file, 'utf8'))
      errors.push(...validatePayload(schema, v, what).map(p => `schema: ${p}`))
      return v
    } catch (e) { errors.push(`${what}: ${url} is not JSON (${e instanceof Error ? e.message : e})`); return null }
  }
  if (b.bom) payload(b.bom.url, 'bom', bomDataSchema, b.bom.bytes)
  if (b.parts) payload(b.parts.url, 'parts', partsDataSchema, b.parts.bytes)
  if (b.netlist) payload(b.netlist.url, 'netlist', netlistDataSchema, b.netlist.bytes)
  if (b.geometry) payload(b.geometry.url, 'geometry', geometryDataSchema, b.geometry.bytes)
  for (const [k, r] of [['drc', b.reports.drc], ['erc', b.reports.erc]] as const) {
    const rep = r ? payload(r.url, `${k} report`, checkReportSchema) as { counts?: unknown } | null : null
    if (r && rep && JSON.stringify(rep.counts) !== JSON.stringify(r.counts)) errors.push(`${k} report: counts differ from the manifest`)
  }
  for (const l of b.diff?.layers ?? []) for (const u of [l.before, l.after]) if (u) need(u, `diff layer ${l.id}`)
  // [assembly] the assembly stage needs no KiCad: every listed board has its settings; the sample's notes file is read
  if (!b.assembly) errors.push('assembly: missing (the assembly stage always runs)')
  else if (b.name === 'Blinky' && !b.assembly.notes.some(n => n.source.endsWith('Blinky/ASSEMBLY.md'))) errors.push('assembly: Blinky/ASSEMBLY.md not read')
  if (!b.bomOptions) errors.push('bomOptions: missing')
  if (!opt['skip-build'] && !(jsText.includes(b.name) && jsText.includes(b.revision)))
    errors.push('the built JS does not embed this board (name / revision not found)')
}

// ---- per board --------------------------------------------------------------------

const reports: BoardReport[] = []
const sources = await pipeline.discover()
for (const name of Object.keys(expectations.boards))
  if (!sources.some(s => s.name === name)) globalErrors.push(`${name}: expected board not found under ${root}`)

for (const src of sources) {
  const r: BoardReport = { name: src.name, formatVersion: null, minKicad: null, backend: null, inManifest: false, available: [], unavailable: [], errors: [], notes: [] }
  reports.push(r)
  const exp = expectations.boards[src.name]
  if (!exp) r.errors.push('not listed in tests/contract/expectations.json')

  const info = readBoard(readFileSync(src.pcb, 'utf8'))
  r.formatVersion = info.formatVersion
  r.minKicad = info.minKicad
  if (exp) {
    if (info.formatVersion !== exp.formatVersion) r.errors.push(`format version ${info.formatVersion}, expected ${exp.formatVersion}`)
    if (info.minKicad !== exp.minKicad) r.errors.push(`minimum KiCad ${info.minKicad}, expected ${exp.minKicad}`)
    if (info.stackup.copperLayers !== exp.copperLayers) r.errors.push(`${info.stackup.copperLayers} copper layers, expected ${exp.copperLayers}`)
  }

  // selection: a backend exactly when some usable install can open the file
  const backend = kit.backendFor(info.formatVersion, 'pcb')
  const canOpen = usable.some(i => i.version!.major >= info.minKicad && versionMatches(i.version!.major, resolved.kicad.version))
  r.backend = backend ? `${backend.id} ${backend.version?.raw ?? '?'}` : null
  if (canOpen && !backend) r.errors.push(`no backend selected although an install can open format ${info.formatVersion}`)
  if (!canOpen && backend) r.errors.push(`backend ${r.backend} selected although no install is new enough (KiCad ${info.minKicad}+)`)
  if (backend && backend.version && backend.version.major < info.minKicad) r.errors.push(`selected KiCad ${backend.version.raw} cannot open KiCad ${info.minKicad} files`)

  const st = status.find(s => s.name === src.name)
  if (st?.error) r.errors.push(`cannot read the board: ${st.error}`)
  const stages: Partial<Record<FeatureId, { skipped: string | null; error: string | null }>> = {}
  for (const [stage, s] of Object.entries(st?.stages ?? {})) {
    for (const f of stageFeatures.get(stage) ?? []) stages[f] = { skipped: s.skipped, error: s.error }
    for (const w of s.warnings) r.notes.push(`${stage}: ${w}`)
  }

  const b = boards.find(x => x.name === src.name)
  if (!b) {
    // not in the manifest: fine only when neither layers nor model could be exported
    const core = (['layers', 'model'] as const).map(n => st?.stages[n])
    const failed = core.filter(s => s?.error).map(s => s!.error)
    if (failed.length) r.errors.push(`not in the manifest, export failed: ${failed.join('; ')}`)
    const why = backend ? core.map(s => s?.skipped).filter(Boolean).join('; ') : `no install can open format ${info.formatVersion} (KiCad ${info.minKicad}+ needed)`
    for (const f of FEATURE_IDS) r.unavailable.push({ feature: f, reason: why || 'not exported' })
    if (backend) for (const f of expectations.require[backend.id] ?? []) r.errors.push(`${f}: required for ${backend.id}, but the board is not in the manifest`)
    continue
  }
  r.inManifest = true
  if (b.kicad.backend !== (backend?.id ?? null)) r.errors.push(`Board.kicad.backend is ${b.kicad.backend}, selection says ${backend?.id ?? null}`)
  if (b.kicad.exportedWith !== (backend?.version?.raw ?? null)) r.errors.push(`Board.kicad.exportedWith is ${b.kicad.exportedWith}, selection says ${backend?.version?.raw ?? null}`)
  if (b.copperLayers !== info.stackup.copperLayers) r.errors.push(`Board.copperLayers ${b.copperLayers} != board file ${info.stackup.copperLayers}`)

  checkAssets(b, r.errors)
  const findings: FeatureFinding[] = checkFeatures(b, { caps: backend?.capabilities ?? null, provided, stages })
  for (const f of findings) (f.level === 'error' ? r.errors : r.notes).push(`${f.feature}: ${f.message}`)
  for (const f of expectations.require[backend?.id ?? ''] ?? [])
    if (!b.features[f]?.available) r.errors.push(`${f}: required for ${backend!.id}, but unavailable`)
  for (const f of FEATURE_IDS) {
    const s = b.features[f]
    if (s?.available) r.available.push(f)
    else if (s) r.unavailable.push({ feature: f, reason: s.reason })
  }
}

// ---- report -------------------------------------------------------------------------

const errorCount = globalErrors.length + reports.reduce((n, r) => n + r.errors.length, 0)
const kicadLine = usable.map(i => `${i.version!.raw} (${i.backend})`).join(', ') || 'none'
const report = {
  ok: errorCount === 0,
  kicad: kicadLine,
  root, buildSeconds: Math.round(buildSeconds * 10) / 10,
  errors: globalErrors,
  boards: reports,
}
writeFileSync(join(out, 'contract-report.json'), JSON.stringify(report, null, 2))
writeFileSync(join(out, 'pipeline.log'), logLines.join('\n') + '\n')

const md: string[] = []
md.push(`## Contract: KiCad ${kicadLine}`, '')
md.push(errorCount ? `**${errorCount} error(s)**` : '**OK**', '')
md.push('| board | format | min KiCad | backend | manifest | available | errors |', '| --- | --- | --- | --- | --- | --- | --- |')
for (const r of reports)
  md.push(`| ${r.name} | ${r.formatVersion} | ${r.minKicad} | ${r.backend ?? '-'} | ${r.inManifest ? 'yes' : 'no'} | ${r.available.join(', ') || '-'} | ${r.errors.length} |`)
md.push('')
for (const e of globalErrors) md.push(`- error: ${e}`)
for (const r of reports) {
  if (!r.errors.length && !r.unavailable.length && !r.notes.length) continue
  md.push('', `### ${r.name}`, '')
  for (const e of r.errors) md.push(`- error: ${e}`)
  const byReason = new Map<string, FeatureId[]>()
  for (const u of r.unavailable) byReason.set(u.reason, [...(byReason.get(u.reason) ?? []), u.feature])
  for (const [reason, fs] of byReason) md.push(`- unavailable: ${fs.join(', ')}: ${reason}`)
  for (const n of r.notes) md.push(`- note: ${n}`)
}
const text = md.join('\n') + '\n'
writeFileSync(join(out, 'contract-report.md'), text)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
console.log(text)
console.log(`contract: ${errorCount ? `FAILED with ${errorCount} error(s)` : 'passed'}; report in ${out}`)
process.exitCode = errorCount ? 1 : 0
