// Feature probing. Never a version table: what an install can do comes from
//
//   kicad-cli    `kicad-cli version` plus the `--help` text of every command path we
//                use, parsed into HelpFacts (subcommands, long flags) -> Capabilities;
//   pcbnew       `python kwv_pcbnew.py probe` (pcbnew.Version() and which plot / export
//                APIs exist) plus a VRML self-test in its own process;
//   docker       the same help walk, run inside the image (one container for all paths).
//
// Results are cached in memory per install and, with a cache dir, on disk keyed by the
// binary's path, size and mtime (a KiCad update invalidates it) or by the image id.
// Help texts of KiCad 7.0 to 10.0 are in tests/fixtures/help/<ver>/ (tests/probe.test.ts).

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { run, type RunResult } from './process.ts'
import type { BackendId, Capabilities, HelpFacts, KicadInstall, KicadVersion, Operation, ProbeResult } from './types.ts'

/**
 * Command paths whose help is read. A path is read only when its parent lists it, so
 * an old kicad-cli is never asked about a command it lacks (argparse would print the
 * parent's help for an unknown subcommand).
 */
export const HELP_PATHS = [
  'pcb', 'sch',
  'pcb export', 'sch export', 'pcb render', 'pcb drc', 'sch erc',
  'pcb export svg', 'pcb export vrml', 'pcb export glb', 'pcb export step',
  'pcb export gerbers', 'pcb export drill', 'pcb export pos', 'pcb export ipcd356', 'pcb export stats',
  'sch export svg', 'sch export pdf', 'sch export bom', 'sch export netlist',
]

/** Bump when HelpFacts parsing or the probed paths change, to invalidate disk caches. */
const PROBE_FORMAT = 'p2'

/**
 * The version in `kicad-cli version` / `pcbnew.Version()` output: "10.0.6",
 * "9.0.1-rc1", "(5.1.9)-1", "7.0.11-7.0.11~ubuntu22.04.1". A line that is only a
 * version wins over a number elsewhere (GTK warnings carry timestamps).
 */
export function parseVersion(text: string): KicadVersion | null {
  const exact = /^\s*\(?(\d+)\.(\d+)(?:\.(\d+))?\)?([-+~][^\s]*)?\s*$/
  for (const line of text.split(/\r?\n/)) {
    const m = exact.exec(line)
    if (m) return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0), raw: line.trim() }
  }
  const m = /(?<![\d:.])(\d+)\.(\d+)(?:\.(\d+))?([^\s]*)/.exec(text)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0), raw: m[0] }
}

/**
 * Subcommands and long flags out of an argparse `--help` text. Subcommands come from
 * the "Subcommands:" block, else from the `{a,b,c}` list ending the Usage line.
 */
export function parseHelp(text: string): HelpFacts {
  const subcommands: string[] = []
  const lines = text.split(/\r?\n/)
  const i = lines.findIndex(l => /^Subcommands:/i.test(l.trim()))
  if (i >= 0) {
    for (const l of lines.slice(i + 1)) {
      const m = /^\s{1,8}([a-z0-9][\w-]*)\b/.exec(l)
      if (m) subcommands.push(m[1]!)
      else if (l.trim() && !/^\s/.test(l)) break
    }
  }
  if (!subcommands.length) {
    const usage = lines.find(l => /^Usage:/.test(l.trim()))
    const braces = usage && /\{([\w,-]+)\}\s*$/.exec(usage.trim())
    if (braces) subcommands.push(...braces[1]!.split(','))
  }
  const flags = [...new Set(text.match(/--[a-zA-Z][\w-]*/g) ?? [])].sort()
  return { subcommands, flags }
}

const has = (help: Record<string, HelpFacts>, path: string, sub: string) => help[path]?.subcommands.includes(sub) ?? false

/** Does `<path> --help` list the long flag `f`? Backends use it for version-dependent flags. */
export function helpHasFlag(help: Record<string, HelpFacts>, path: string, f: string): boolean {
  return help[path]?.flags.includes(f) ?? false
}
const flag = helpHasFlag

/** Capabilities of a kicad-cli, from its help facts. */
export function capabilitiesFromHelp(help: Record<string, HelpFacts>): Capabilities {
  const formats = (['vrml', 'glb', 'step'] as const).filter(f => has(help, 'pcb export', f))
  const render = has(help, 'pcb', 'render')
  const ops: Record<Operation, boolean> = {
    boardInfo: true,
    layerSvg: has(help, 'pcb export', 'svg'),
    model3d: formats.length > 0,
    thumbnail: render,
    schematicSvg: has(help, 'sch export', 'svg'),
    bom: has(help, 'sch export', 'bom'),
    netlist: has(help, 'sch export', 'netlist'),
    fab: has(help, 'pcb export', 'gerbers') && has(help, 'pcb export', 'drill'),
    drc: has(help, 'pcb', 'drc'),
    erc: has(help, 'sch', 'erc'),
    stats: has(help, 'pcb export', 'stats'),
  }
  // --no-dnp of the first format there is: vrml has it from KiCad 9, glb / step from 8
  const first = formats[0]
  return {
    ops,
    layerSvg: {
      multiFile: flag(help, 'pcb export svg', '--mode-multi'),
      drillShape: flag(help, 'pcb export svg', '--drill-shape-opt'),
      pageSizeMode: flag(help, 'pcb export svg', '--page-size-mode'),
    },
    model3d: { formats: [...formats], noDnp: first ? flag(help, `pcb export ${first}`, '--no-dnp') : false },
    thumbnail: { render },
    fab: {
      gerbers: has(help, 'pcb export', 'gerbers'),
      drill: has(help, 'pcb export', 'drill'),
      pos: has(help, 'pcb export', 'pos'),
      ipcd356: has(help, 'pcb export', 'ipcd356'),
      schematicPdf: has(help, 'sch export', 'pdf'),
    },
  }
}

/** Nothing available (an unusable install). */
export function noCapabilities(): Capabilities {
  return capabilitiesFromHelp({})
}

/** Which backend drives a kicad-cli with these capabilities. */
export function backendForCaps(c: Capabilities): BackendId {
  if (c.ops.layerSvg && c.layerSvg.multiFile) return 'cli-modern'
  if (c.ops.layerSvg) return 'cli-7-8'
  return 'pcbnew-python'
}

/**
 * Walk HELP_PATHS level by level; a deeper path is read only when its parent's help
 * lists it. `read` returns the help text of a command path, or null.
 */
export async function readHelpTree(read: (path: string) => Promise<string | null>): Promise<Record<string, HelpFacts>> {
  const help: Record<string, HelpFacts> = {}
  const depth = (p: string) => p.split(' ').length
  const maxDepth = Math.max(...HELP_PATHS.map(depth))
  for (let d = 1; d <= maxDepth; d++) {
    const level = HELP_PATHS.filter(p => depth(p) === d).filter(p => {
      if (d === 1) return true
      const parts = p.split(' ')
      return has(help, parts.slice(0, -1).join(' '), parts[parts.length - 1]!)
    })
    await Promise.all(level.map(async p => {
      const text = await read(p)
      if (text !== null) help[p] = parseHelp(text)
    }))
  }
  return help
}

/** The help text of a `--help` run, or null when the command does not exist. */
export function helpText(r: RunResult): string | null {
  const text = r.out.join('\n')
  // argparse exits 0 after printing help; accept any exit code as long as help came out
  return /^\s*Usage:/m.test(text) ? text : null
}

// ---------------------------------------------------------------------------- caching

interface CachedProbe { format: string; version: KicadVersion | null; help: Record<string, HelpFacts>; python?: PythonFacts }

const memory = new Map<string, Promise<ProbeResult>>()

function cacheFile(cacheDir: string, ...key: string[]): string {
  const h = createHash('sha256').update([...key, PROBE_FORMAT].join('\0')).digest('hex').slice(0, 16)
  return join(cacheDir, `probe-${h}.json`)
}

/** Path + size + mtime: changes when the file is replaced (a KiCad update). */
async function fileKey(file: string): Promise<string | null> {
  try {
    const s = await stat(file)
    return `${file}\0${s.size}\0${s.mtimeMs}`
  } catch { return null }
}

async function readCache(file: string | null): Promise<CachedProbe | null> {
  if (!file) return null
  try {
    const c = JSON.parse(await readFile(file, 'utf8')) as CachedProbe
    return c.format === PROBE_FORMAT ? c : null
  } catch { return null }
}

async function writeCache(file: string | null, cacheDir: string | undefined, c: Omit<CachedProbe, 'format'>) {
  if (!file || !cacheDir) return
  await mkdir(cacheDir, { recursive: true })
  await writeFile(file, JSON.stringify({ format: PROBE_FORMAT, ...c } satisfies CachedProbe, null, 2))
}

function memo(key: string, fn: () => Promise<ProbeResult>): Promise<ProbeResult> {
  let p = memory.get(key)
  if (!p) { p = fn(); memory.set(key, p) }
  return p
}

export function probeResult(install: KicadInstall, version: KicadVersion | null, help: Record<string, HelpFacts>,
                            error: string | null, ms: number, backend?: BackendId): ProbeResult {
  const capabilities = capabilitiesFromHelp(help)
  return { install, version, help, capabilities, backend: backend ?? backendForCaps(capabilities), error, ms: Math.round(ms) }
}

// ------------------------------------------------------------------------- kicad-cli

/** Probe a native kicad-cli install (memoised per binary for the process lifetime). */
export function probeCli(install: KicadInstall, o: { cacheDir?: string } = {}): Promise<ProbeResult> {
  return memo(`cli:${install.cli}`, () => probeCliUncached(install, o))
}

async function probeCliUncached(install: KicadInstall, o: { cacheDir?: string }): Promise<ProbeResult> {
  const t0 = performance.now()
  const cli = install.cli!
  const key = o.cacheDir ? await fileKey(cli) : null
  const file = key && o.cacheDir ? cacheFile(o.cacheDir, key) : null
  const cached = await readCache(file)
  if (cached) return probeResult(install, cached.version, cached.help, null, 0)

  const v = await run(cli, ['version'], { timeoutMs: 60_000 })
  if (v.code !== 0) return probeResult(install, null, {}, `cannot run ${cli}: ${v.out.slice(-2).join(' ')}`, performance.now() - t0)
  const version = parseVersion(v.out.join('\n'))
  const help = await readHelpTree(async path =>
    helpText(await run(cli, [...path.split(' '), '--help'], { timeoutMs: 60_000, noise: /^\s*$/ })))
  if (version) await writeCache(file, o.cacheDir, { version, help })
  return probeResult(install, version, help, version ? null : `unrecognised version output: ${v.out.join(' ')}`, performance.now() - t0)
}

// ---------------------------------------------------------------------------- pcbnew

/** What `kwv_pcbnew.py probe` (plus the VRML self-test) reports. */
export interface PythonFacts {
  version: string
  python: string
  svg: boolean
  gerber: boolean
  drill: boolean
  pos: boolean
  vrml: boolean
}

/** The bundled script, packages/kicad/python/kwv_pcbnew.py (same path from src/ and dist/). */
export const PCBNEW_SCRIPT = fileURLToPath(new URL('../python/kwv_pcbnew.py', import.meta.url))

/** The `@@KWV <json>` result line of the script; throws its error. */
export function scriptResult<T>(r: RunResult): T {
  const line = [...r.out].reverse().find(l => l.startsWith('@@KWV '))
  if (!line) throw new Error(`pcbnew script failed (exit ${r.code}): ${r.out.filter(l => l.trim()).slice(-3).join(' | ') || 'no output'}`)
  const v = JSON.parse(line.slice(6)) as T
  const err = v && typeof v === 'object' && !Array.isArray(v) ? (v as { error?: string }).error : undefined
  if (err) throw new Error(`pcbnew script: ${err}`)
  return v
}

/** Help facts under which capabilitiesFromHelp() describes what the pcbnew script can do. */
export function pythonHelp(f: PythonFacts): Record<string, HelpFacts> {
  const subs = [f.svg && 'svg', f.vrml && 'vrml', f.gerber && 'gerbers', f.drill && 'drill', f.pos && 'pos']
    .filter((s): s is string => !!s)
  return {
    'pcb': { subcommands: ['export'], flags: [] },
    'pcb export': { subcommands: subs, flags: [] },
    ...(f.svg ? { 'pcb export svg': { subcommands: [], flags: ['--drill-shape-opt', '--page-size-mode'] } } : {}),
    ...(f.vrml ? { 'pcb export vrml': { subcommands: [], flags: ['--no-dnp'] } } : {}),
  }
}

/** Probe KiCad's Python (`install.python`) for the pcbnew module (memoised per interpreter). */
export function probePython(install: KicadInstall, o: { cacheDir?: string } = {}): Promise<ProbeResult> {
  return memo(`py:${install.python}`, () => probePythonUncached(install, o))
}

async function probePythonUncached(install: KicadInstall, o: { cacheDir?: string }): Promise<ProbeResult> {
  const t0 = performance.now()
  const py = install.python!
  const key = o.cacheDir ? await fileKey(py) : null
  const file = key && o.cacheDir ? cacheFile(o.cacheDir, 'python', key, (await fileKey(PCBNEW_SCRIPT)) ?? '') : null
  const cached = await readCache(file)
  if (cached?.python) return probeResult(install, cached.version, pythonHelp(cached.python), null, 0, 'pcbnew-python')

  const fail = (why: string) => probeResult(install, null, {}, why, performance.now() - t0, 'pcbnew-python')
  let facts: PythonFacts
  try {
    facts = scriptResult<PythonFacts>(await run(py, [PCBNEW_SCRIPT, 'probe'], { timeoutMs: 60_000 }))
  } catch (e) {
    return fail(`no usable pcbnew module in ${py}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (facts.vrml) {
    // EXPORTER_VRML exists, but standalone exports abort in some builds: try it once
    const out = join(tmpdir(), `kwv-vrml-selftest-${process.pid}-${Date.now()}.wrl`)
    try {
      facts.vrml = scriptResult<{ ok: boolean }>(await run(py, [PCBNEW_SCRIPT, 'vrml-selftest', out], { timeoutMs: 60_000 })).ok
    } catch { facts.vrml = false }
    await rm(out, { force: true })
  }
  const version = parseVersion(facts.version)
  if (!version) return fail(`unrecognised pcbnew.Version(): ${facts.version}`)
  await writeCache(file, o.cacheDir, { version, help: {}, python: facts })
  return probeResult(install, version, pythonHelp(facts), null, performance.now() - t0, 'pcbnew-python')
}

// ---------------------------------------------------------------------------- docker

/**
 * A shell script for one container that prints `kicad-cli version` and the help of
 * every HELP_PATHS entry between marker lines (parseDockerProbe splits them).
 */
export function dockerProbeScript(): string {
  const parts = ['echo "@@KWV-VERSION"', 'kicad-cli version']
  for (const p of HELP_PATHS) parts.push(`echo "@@KWV-HELP ${p}"`, `kicad-cli ${p} --help 2>&1`)
  return parts.join('; ')
}

export function parseDockerProbe(lines: string[]): { version: string; help: Map<string, string> } {
  const help = new Map<string, string>()
  let version = ''
  let current: string | null = null
  let buf: string[] = []
  const flush = () => {
    if (current === '\0version') version = buf.join('\n')
    else if (current) help.set(current, buf.join('\n'))
    buf = []
  }
  for (const l of lines) {
    if (l === '@@KWV-VERSION') { flush(); current = '\0version'; continue }
    const m = /^@@KWV-HELP (.+)$/.exec(l)
    if (m) { flush(); current = m[1]!; continue }
    buf.push(l)
  }
  flush()
  return { version, help }
}

/** Probe a kicad/kicad:<ver> image (memoised per image, cached on disk per image id). */
export function probeDocker(install: KicadInstall, o: { cacheDir?: string; docker?: string } = {}): Promise<ProbeResult> {
  return memo(`docker:${install.image}`, () => probeDockerUncached(install, o))
}

async function probeDockerUncached(install: KicadInstall, o: { cacheDir?: string; docker?: string }): Promise<ProbeResult> {
  const t0 = performance.now()
  const docker = o.docker ?? 'docker'
  const image = install.image!
  const fail = (why: string) => probeResult(install, null, {}, why, performance.now() - t0, 'docker')
  const id = await run(docker, ['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: 30_000 })
  if (id.code !== 0) return fail(`docker image ${image} is not available: ${id.out.slice(-1).join(' ')}`)
  const file = o.cacheDir ? cacheFile(o.cacheDir, 'docker', image, id.out.join('').trim()) : null
  const cached = await readCache(file)
  if (cached) return probeResult(install, cached.version, cached.help, null, 0, 'docker')

  const r = await run(docker, ['run', '--rm', '--network', 'none', '-e', 'HOME=/tmp', '--entrypoint', 'sh', image, '-c', dockerProbeScript()],
                      { timeoutMs: 300_000, noise: /^\s*$/ })
  const { version: vText, help: texts } = parseDockerProbe(r.out)
  const version = parseVersion(vText)
  if (!version) return fail(`cannot run kicad-cli in ${image}: ${r.out.slice(-2).join(' ')}`)
  const help = await readHelpTree(async p => {
    const t = texts.get(p)
    return t !== undefined && /^\s*Usage:/m.test(t) ? t : null
  })
  await writeCache(file, o.cacheDir, { version, help })
  return probeResult(install, version, help, null, performance.now() - t0, 'docker')
}
