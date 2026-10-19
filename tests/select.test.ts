// Version selection with fake probes: format table, prefer oldest / newest,
// kicad.version, docker after natives, the fallback chain and the "needs KiCad N" error.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  capabilitiesFromHelp, explainNoFit, FallbackBackend, FORMAT_VERSIONS, minKicadFor, noCapabilities, rankCandidates,
  toolkitFromProbes, type BackendId, type HelpFacts, type KicadBackend, type ProbeResult,
} from '@kiview/kicad'

const PCB = Object.fromEntries(FORMAT_VERSIONS.pcb) as Record<number, number>

const modernHelp: Record<string, HelpFacts> = {
  'pcb': { subcommands: ['export', 'render'], flags: [] },
  'pcb export': { subcommands: ['svg', 'vrml', 'glb'], flags: [] },
  'pcb export svg': { subcommands: [], flags: ['--mode-multi', '--drill-shape-opt'] },
}
const oldHelp: Record<string, HelpFacts> = {
  'pcb': { subcommands: ['export'], flags: [] },
  'pcb export': { subcommands: ['svg', 'vrml'], flags: [] },
  'pcb export svg': { subcommands: [], flags: ['--drill-shape-opt'] },
}

function probe(ver: string, o: { docker?: boolean; error?: string; help?: Record<string, HelpFacts> } = {}): ProbeResult {
  const [major, minor, patch] = ver.split('.').map(Number) as [number, number, number]
  const help = o.help ?? (major >= 9 ? modernHelp : oldHelp)
  const capabilities = capabilitiesFromHelp(help)
  return {
    install: o.docker
      ? { id: `docker:kicad/kicad:${ver}`, kind: 'docker', source: 'docker', image: `kicad/kicad:${ver}`, cli: 'kicad-cli' }
      : { id: `cli:/kicad${ver}/kicad-cli`, kind: 'native', source: 'path', cli: `/kicad${ver}/kicad-cli` },
    version: o.error ? null : { major, minor, patch, raw: ver },
    help, capabilities, backend: o.docker ? 'docker' : major >= 9 ? 'cli-modern' : 'cli-7-8', error: o.error ?? null, ms: 0,
  }
}

/** Fake backends that record which install served an operation. */
const fake = (p: ProbeResult, id: BackendId): KicadBackend => {
  const tag = (op: string) => async () => `${op}@${p.version!.raw}` as never
  return {
    id, install: p.install, version: p.version, capabilities: p.capabilities,
    boardInfo: tag('boardInfo'), exportLayerSvgs: tag('layerSvg'), export3d: tag('model3d'), renderThumbnail: tag('thumbnail'),
    exportSchematicSvgs: tag('schematicSvg'), exportBom: tag('bom'), netlist: tag('netlist'), exportFab: tag('fab'),
    drc: tag('drc'), erc: tag('erc'), stats: tag('stats'),
  }
}

test('format versions: first release at or above the file, nightlies to the next', () => {
  assert.equal(minKicadFor(4, 'pcb'), 5)                 // KiCad 4 s-expression boards
  assert.equal(minKicadFor(20171130, 'pcb'), 5)
  assert.equal(minKicadFor(20211014, 'pcb'), 6)
  assert.equal(minKicadFor(20221018, 'pcb'), 7)
  assert.equal(minKicadFor(20231007, 'pcb'), 8)          // a KiCad 7.99 nightly file
  assert.equal(minKicadFor(20240108, 'pcb'), 8)
  assert.equal(minKicadFor(20241229, 'pcb'), 9)
  assert.equal(minKicadFor(20260206, 'pcb'), 10)
  assert.equal(minKicadFor(20260301, 'pcb'), 11)         // newer than 10: a nightly
  assert.equal(minKicadFor(20230121, 'sch'), 7)
  assert.equal(minKicadFor(20231120, 'sch'), 8)
  assert.equal(minKicadFor(20250114, 'sch'), 9)
  assert.equal(minKicadFor(20260306, 'sch'), 10)
})

test('prefer newest (default) and oldest among installs that open the file', () => {
  const probes = [probe('10.0.6'), probe('8.0.9'), probe('9.0.7'), probe('7.0.11')]
  const ids = (ps: ProbeResult[]) => ps.map(p => p.version!.raw)
  assert.deepEqual(ids(rankCandidates(probes, PCB[8]!, 'pcb')), ['10.0.6', '9.0.7', '8.0.9'])
  assert.deepEqual(ids(rankCandidates(probes, PCB[8]!, 'pcb', { prefer: 'oldest' })), ['8.0.9', '9.0.7', '10.0.6'])
  assert.deepEqual(ids(rankCandidates(probes, PCB[5]!, 'pcb', { version: '<10', prefer: 'oldest' })), ['7.0.11', '8.0.9', '9.0.7'])
  assert.deepEqual(ids(rankCandidates(probes, PCB[10]!, 'pcb', { version: '9' })), [])
})

test('unusable installs never qualify; docker images rank after every native', () => {
  const probes = [probe('9.0.7', { docker: true }), probe('10.0.6'), probe('8.0.9', { error: 'cannot run' }), probe('8.0.9', { docker: true })]
  const r = rankCandidates(probes, PCB[8]!, 'pcb')
  assert.deepEqual(r.map(p => p.install.id), ['cli:/kicad10.0.6/kicad-cli', 'docker:kicad/kicad:9.0.7', 'docker:kicad/kicad:8.0.9'])
  const old = rankCandidates(probes, PCB[8]!, 'pcb', { prefer: 'oldest' })
  assert.deepEqual(old.map(p => p.install.id), ['cli:/kicad10.0.6/kicad-cli', 'docker:kicad/kicad:8.0.9', 'docker:kicad/kicad:9.0.7'])
})

test('toolkit: backend per format, the fallback chain, and a clear error', async () => {
  // the default (newest) takes KiCad 10 for a KiCad 8 file
  assert.equal(toolkitFromProbes([probe('8.0.9'), probe('10.0.6')], {}, fake).backendFor(PCB[8]!)!.version?.raw, '10.0.6')
  // with prefer 'oldest' KiCad 8 is chosen and the operations it lacks go to KiCad 10
  const kit = toolkitFromProbes([probe('8.0.9'), probe('10.0.6')], { prefer: 'oldest' }, fake)
  const b = kit.backendFor(PCB[8]!)!
  assert.ok(b instanceof FallbackBackend)
  assert.equal(b.id, 'cli-7-8')
  assert.equal(b.version?.raw, '8.0.9')
  // KiCad 8 plots, KiCad 10 renders (no `pcb render` before 9)
  assert.equal(b.capabilities.ops.thumbnail, true)
  assert.equal(await b.exportLayerSvgs('x', [], { holes: true }, { workDir: '', vars: {} }), 'layerSvg@8.0.9' as never)
  assert.equal(await b.renderThumbnail('x', { width: 1, height: 1 }, { workDir: '', vars: {} }), 'thumbnail@10.0.6' as never)
  assert.deepEqual(b.capabilities.model3d.formats, ['vrml', 'glb'])
  assert.equal(await b.export3d('x', { format: 'glb' }, { workDir: '', vars: {} }), 'model3d@10.0.6' as never)
  assert.equal(await b.export3d('x', { format: 'vrml' }, { workDir: '', vars: {} }), 'model3d@8.0.9' as never)

  // a KiCad 10 file only opens in 10: no chain
  const b10 = kit.backendFor(PCB[10]!)!
  assert.equal(b10.id, 'cli-modern')
  assert.ok(!(b10 instanceof FallbackBackend))

  assert.equal(kit.backendFor(20270101), null)
  assert.match(kit.explain!(20270101), /needs KiCad 11 or a nightly build; found KiCad 10\.0\.6 \(\/kicad10\.0\.6\/kicad-cli\), KiCad 8\.0\.9/)
  const only8 = toolkitFromProbes([probe('8.0.9')], { version: '8' }, fake)
  assert.equal(only8.backendFor(PCB[10]!), null)
  assert.match(only8.explain!(PCB[10]!), /needs KiCad 10 or newer; found KiCad 8\.0\.9 .*kicad\.version is "8"/)
  assert.match(explainNoFit([], PCB[9]!, 'pcb'), /needs KiCad 9 or newer; no usable KiCad install found/)
})

test('a forced backend applies to native installs, docker images keep theirs', () => {
  const seen: string[] = []
  const kit = toolkitFromProbes([probe('10.0.6'), probe('9.0.7', { docker: true })], { backend: 'cli-7-8', prefer: 'newest' },
    (p, id) => { seen.push(`${p.install.id}=${id}`); return fake(p, id) })
  kit.backendFor(PCB[9]!)
  assert.deepEqual(seen, ['cli:/kicad10.0.6/kicad-cli=cli-7-8', 'docker:kicad/kicad:9.0.7=docker'])
  assert.match(kit.describe(), /kicad-cli 10\.0\.6 \(cli-7-8\).*docker kicad\/kicad:9\.0\.7 9\.0\.7 \(docker\).*\[prefer newest\]/)
})

test('no usable install: describe says so', () => {
  const p = probe('9.0.0', { error: 'cannot run /x' })
  p.capabilities = noCapabilities()
  const kit = toolkitFromProbes([p], {}, fake)
  assert.equal(kit.backendFor(PCB[9]!), null)
  assert.match(kit.describe(), /no usable KiCad found/)
})

test('tiers: kicad-cli installs, then pcbnew Python (KiCad 7 VRML), then docker', async () => {
  const k7help: Record<string, HelpFacts> = {
    'pcb': { subcommands: ['export'], flags: [] },
    'pcb export': { subcommands: ['svg', 'step'], flags: [] },
  }
  const cli7 = probe('7.0.11', { help: k7help })
  const py7: ProbeResult = { ...probe('7.0.11', { help: {
    'pcb': { subcommands: ['export'], flags: [] }, 'pcb export': { subcommands: ['svg', 'vrml'], flags: [] } } }),
  backend: 'pcbnew-python' }
  const r = rankCandidates([py7, probe('10.0.6'), cli7, probe('9.0.7', { docker: true })], PCB[7]!, 'pcb')
  assert.deepEqual(r.map(p => `${p.backend}@${p.version!.raw}`), ['cli-modern@10.0.6', 'cli-7-8@7.0.11', 'pcbnew-python@7.0.11', 'docker@9.0.7'])

  const kit = toolkitFromProbes([cli7, py7], { backend: 'cli-modern' }, fake)
  const b = kit.backendFor(PCB[7]!)!
  assert.equal(b.id, 'cli-modern')                  // forced on the kicad-cli install only
  assert.equal(await b.export3d('x', { format: 'vrml' }, { workDir: '', vars: {} }), 'model3d@7.0.11' as never)
  assert.deepEqual(b.capabilities.model3d.formats, ['step', 'vrml'])   // step from kicad-cli 7, vrml from its Python
})
