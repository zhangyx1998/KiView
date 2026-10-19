// [P2-c] zip determinism, revision resolution (with and without git), the layer
// diff helpers, and the generic fab item list against the Blinky example (the last
// one needs a KiCad 9+ kicad-cli and is skipped without one).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { listZip, openKicad, readBoard, zipBuffer, type Footprint } from '@kiview/kicad'

import { archive, gitState, resolveBase } from '../packages/vite-plugin/src/git.ts'
import { revisionOf } from '../packages/vite-plugin/src/stages/revision.ts'
import { diffParts, summarise } from '../packages/vite-plugin/src/stages/diff.ts'

const blinky = fileURLToPath(new URL('../examples/boards/Blinky/', import.meta.url))
const temps: string[] = []
const temp = (p: string) => { const d = mkdtempSync(join(process.env.KWV_TEST_TMP ?? tmpdir(), p)); temps.push(d); return d }
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }) })

// ---- zip ----------------------------------------------------------------------------

test('zip: same entries in any order give the same bytes, and read back', () => {
  const a = [
    { name: 'gerbers/b.gbl', data: 'G04 back*\n'.repeat(50) },
    { name: 'a.txt', data: Buffer.from([0, 1, 2, 3]) },
    { name: 'docs/ü.pdf', data: '%PDF' },
  ]
  const z1 = zipBuffer(a)
  const z2 = zipBuffer([...a].reverse())
  assert.ok(z1.equals(z2))
  const list = listZip(z1)
  assert.deepEqual(list.map(e => e.name), ['a.txt', 'docs/ü.pdf', 'gerbers/b.gbl'])
  assert.equal(list[2]!.data().toString(), 'G04 back*\n'.repeat(50))
  assert.ok(list[2]!.compressed < list[2]!.size)          // deflated
  assert.deepEqual([...list[0]!.data()], [0, 1, 2, 3])    // stored
  assert.throws(() => zipBuffer([{ name: 'x', data: '' }, { name: 'x', data: '' }]), /duplicate/)
  assert.throws(() => zipBuffer([{ name: '../x', data: '' }]), /bad entry/)
  assert.equal(listZip(zipBuffer([])).length, 0)
})

test('zip: the system unzip accepts it', { skip: !hasCmd('unzip', '-v') }, () => {
  const d = temp('kwv-zip-')
  const f = join(d, 'x.zip')
  writeFileSync(f, zipBuffer([{ name: 'a/b.txt', data: 'hello' }, { name: 'c.bin', data: Buffer.alloc(5000, 7) }]))
  const out = execFileSync('unzip', ['-t', f], { encoding: 'utf8' })
  assert.match(out, /No errors detected/)
})

// ---- revision ---------------------------------------------------------------------

function hasCmd(cmd: string, arg = '--version'): boolean {
  try { execFileSync(cmd, [arg], { stdio: 'ignore' }); return true } catch { return false }
}
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const g = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { env: GIT_ENV, encoding: 'utf8' })

test('revision without git: VERSION, else title-block rev, else hash', async () => {
  const d = temp('kwv-rev-')
  const base = { dir: d, hash: 'abcdef0123456789', titleBlockRev: 'B', versionFile: 'VERSION' as const, git: true }
  let r = await revisionOf(base)
  assert.equal(r.git, null)
  assert.equal(r.version, null)
  assert.equal(r.label, 'B')
  assert.equal((await revisionOf({ ...base, titleBlockRev: null })).label, 'abcdef0')

  writeFileSync(join(d, 'VERSION'), '\n1.2.3\n')
  r = await revisionOf(base)
  assert.equal(r.version, '1.2.3')
  assert.equal(r.label, '1.2.3')
  assert.deepEqual(r.warnings, [])
  writeFileSync(join(d, 'VERSION'), 'banana')
  assert.match((await revisionOf(base)).warnings[0]!, /not a semantic version/)
  assert.equal((await revisionOf({ ...base, versionFile: false })).version, null)
})

test('revision with git: commit, tag, describe, dirty; diff bases; archive', { skip: !hasCmd('git') }, async () => {
  const repo = temp('kwv-git-')
  const dir = join(repo, 'hw', 'Board')
  cpSync(blinky, dir, { recursive: true })
  g(repo, 'init', '-q')
  g(repo, 'add', '.')
  g(repo, 'commit', '-q', '-m', 'first')
  g(repo, 'tag', '-m', 'v0.1.0', 'v0.1.0')
  const first = g(repo, 'rev-parse', 'HEAD').trim()

  let s = await gitState(dir)
  assert.ok(s)
  assert.equal(s.commit, first)
  assert.equal(s.tag, 'v0.1.0')
  assert.equal(s.describe, 'v0.1.0')
  assert.equal(s.dirty, false)
  assert.equal(s.prefix, 'hw/Board/')
  // label: VERSION wins over the tag; without VERSION the tag wins over the title block
  const opts = { dir, hash: '0123456789ab', titleBlockRev: 'A', versionFile: 'VERSION' as const, git: true }
  assert.equal((await revisionOf(opts)).label, '0.1.0')
  assert.equal((await revisionOf({ ...opts, versionFile: false })).label, 'v0.1.0')
  assert.equal((await revisionOf({ ...opts, git: false })).git, null)
  assert.equal(await resolveBase(dir, 'previous', s), 'no earlier commit touches the board')

  // a second commit touching the board, one elsewhere, then a dirty working copy
  writeFileSync(join(dir, 'VERSION'), '0.2.0\n')
  g(repo, 'commit', '-q', '-am', 'second')
  const second = g(repo, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(repo, 'README'), 'x')
  g(repo, 'add', 'README')
  g(repo, 'commit', '-q', '-m', 'unrelated')
  s = (await gitState(dir))!
  assert.equal(s.commit, second)          // last commit touching the board, not HEAD
  assert.equal(s.tag, null)
  assert.match(s.describe!, /^v0\.1\.0-1-g/)
  const base = await resolveBase(dir, 'previous', s)
  assert.ok(typeof base !== 'string' && base.commit === first && base.tag === 'v0.1.0')
  const tagBase = await resolveBase(dir, 'previous-tag', s)
  assert.ok(typeof tagBase !== 'string' && tagBase.commit === first)
  const head1 = await resolveBase(dir, 'HEAD~1', s)
  assert.ok(typeof head1 !== 'string' && head1.commit === second)
  assert.match(String(await resolveBase(dir, 'no-such-ref', s)), /unknown git revision/)

  writeFileSync(join(dir, 'notes.txt'), 'wip')
  s = (await gitState(dir))!
  assert.equal(s.dirty, true)
  const dirtyBase = await resolveBase(dir, 'previous', s)   // dirty: compare with the last commit
  assert.ok(typeof dirtyBase !== 'string' && dirtyBase.commit === second)

  const out = temp('kwv-archive-')
  await archive(s.top, first, ['hw/Board'], out)
  assert.equal(readFileSync(join(out, 'hw/Board/VERSION'), 'utf8').trim(), '0.1.0')
  assert.ok(existsSync(join(out, 'hw/Board/Blinky.kicad_pcb')))
  assert.ok(!existsSync(join(out, 'README')))
  // read-only: the repo's working copy is untouched
  assert.equal(readFileSync(join(dir, 'VERSION'), 'utf8').trim(), '0.2.0')
})

// ---- diff helpers -----------------------------------------------------------------

test('parts diff and summary', () => {
  const fp = (ref: string, x: number, value = '1k'): Footprint => ({
    ref, value, footprint: 'R_0603', side: 'front', at: { x, y: 0 }, rotation: 0, bbox: { x, y: 0, width: 1, height: 1 },
    pads: [], fields: {}, dnp: false, excludeFromBom: false, excludeFromPos: false, path: null,
  })
  assert.equal(diffParts([], []), null)
  const d = diffParts([fp('R1', 0), fp('R2', 0), fp('R10', 0)], [fp('R1', 0), fp('R2', 1), fp('R10', 0, '2k'), fp('C1', 0)])!
  assert.deepEqual(d, { added: ['C1'], removed: [], moved: ['R2'], changed: ['R10'] })
  const layer = (status: 'changed' | 'unchanged') =>
    ({ id: 'F.Cu', name: '', kind: 'copper' as const, side: 'front' as const, color: '', order: 0, status, before: null, after: null })
  assert.equal(summarise({ layers: [layer('changed'), layer('unchanged')], parts: d, outlineChanged: false, note: null }),
               '1 layer changed, 1 part added, 1 part moved, 1 part changed')
  assert.equal(summarise({ layers: [layer('unchanged')], parts: null, outlineChanged: false, note: null }), 'no changes')
})

// ---- generic fab against Blinky ------------------------------------------------------

const kit = await openKicad({}).catch(() => null)
const pcbFile = join(blinky, 'Blinky.kicad_pcb')
const backend = kit?.backendFor(readBoard(readFileSync(pcbFile, 'utf8')).formatVersion) ?? null

test('generic fab bundle of Blinky: items, layout, determinism of the zip', { skip: !backend?.capabilities.ops.fab && 'no KiCad with fab support' }, async () => {
  const snap = temp('kwv-fab-snap-')
  cpSync(blinky, snap, { recursive: true })
  const work = temp('kwv-fab-work-')
  const r = await backend!.exportFab(join(snap, 'Blinky.kicad_pcb'), { sch: join(snap, 'Blinky.kicad_sch'), zipName: 'Blinky-fab-test.zip' },
                                     { workDir: work, vars: { KIPRJMOD: blinky }, timeoutMs: 300_000 })
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.missing, [])
  assert.equal(r.zip, join(work, 'Blinky-fab-test.zip'))
  const byId = Object.fromEntries(r.items.map(i => [i.id, i]))
  assert.deepEqual(r.items.map(i => i.id), ['gerbers', 'drill', 'ipcd356', 'pos', 'bom', 'schematicPdf', 'drillMap', 'model'])
  for (const i of r.items) assert.equal(i.status, 'ok', `${i.id}: ${i.reason}`)
  assert.ok(byId.gerbers!.required && byId.drill!.required && !byId.bom!.required)
  const gerbers = byId.gerbers!.files
  for (const l of ['F_Cu', 'B_Cu', 'F_Mask', 'B_Mask', 'Edge_Cuts', 'F_Silkscreen', 'B_Silkscreen', 'F_Paste', 'B_Paste'])
    assert.ok(gerbers.some(f => f.startsWith(`gerbers/Blinky-${l}.`)), `no ${l} Gerber`)
  assert.ok(gerbers.includes('gerbers/Blinky-job.gbrjob'))
  assert.deepEqual(byId.drill!.files, ['gerbers/Blinky-NPTH.drl', 'gerbers/Blinky-PTH.drl'])
  assert.deepEqual(byId.ipcd356!.files, ['gerbers/Blinky.d356'])
  assert.deepEqual(byId.pos!.files, ['assembly/Blinky-pos-front.csv', 'assembly/Blinky-pos-back.csv'])
  assert.deepEqual(byId.bom!.files, ['assembly/Blinky-bom.csv'])
  assert.deepEqual(byId.schematicPdf!.files, ['docs/Blinky-schematic.pdf'])
  assert.ok(/^3d\/Blinky\.(step|glb)$/.test(byId.model!.files[0]!))

  const zip = readFileSync(r.zip)
  const names = listZip(zip).map(e => e.name)
  assert.deepEqual(names, [...names].sort())
  assert.deepEqual(names, [...r.contents])
  assert.deepEqual(new Set(names), new Set(r.items.flatMap(i => i.files)))
  const bom = listZip(zip).find(e => e.name === 'assembly/Blinky-bom.csv')!.data().toString()
  assert.match(bom, /^"Refs","Value","Footprint","Qty"/)
  assert.match(bom, /"R1","330"/)
  // the same files give the same archive
  assert.ok(zipBuffer(listZip(zip).map(e => ({ name: e.name, data: e.data() }))).equals(zip))
})

test('generic fab without a schematic skips BOM and PDF, still orderable', { skip: !backend?.capabilities.ops.fab && 'no KiCad with fab support' }, async () => {
  const snap = temp('kwv-fab-snap-')
  cpSync(pcbFile, join(snap, 'Blinky.kicad_pcb'))
  const r = await backend!.exportFab(join(snap, 'Blinky.kicad_pcb'), { model: false }, { workDir: temp('kwv-fab-work-'), vars: {}, timeoutMs: 300_000 })
  assert.equal(r.status, 'ok')
  const byId = Object.fromEntries(r.items.map(i => [i.id, i]))
  assert.equal(byId.bom!.status, 'skipped')
  assert.equal(byId.bom!.reason, 'the project has no schematic')
  assert.equal(byId.schematicPdf!.status, 'skipped')
  assert.equal(byId.model!.status, 'skipped')
  assert.ok(!r.contents.some(f => f.startsWith('docs/Blinky-schematic') || f.startsWith('3d/')))
})
