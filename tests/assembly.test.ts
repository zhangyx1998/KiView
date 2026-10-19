// [assembly] Assembly mode: step ordering, polarity / pin-1 detection, variants, the
// "leave empty" list, notes markdown, progress files, the BOM's DNP rule, the
// assembly stage and the contract additions. No KiCad needed.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Footprint, Pad } from '@kiview/kicad/types'
import type { BoardAssembly, BomRow, NetlistData } from '@kiview/vite-plugin/contract'

import { buildPlan, heightClass, packageOf, sortSteps, type Step } from '../packages/client/src/assembly/model.ts'
import { compass, detectPolarity, mirrored, pinName } from '../packages/client/src/assembly/polarity.ts'
import { renderMarkdown } from '../packages/client/src/assembly/markdown.ts'
import { exportProgress, parseProgress, progressKey } from '../packages/client/src/assembly/progress.ts'
import { visibleRows } from '../packages/client/src/bom/model.ts'
import { resolveConfig } from '../packages/vite-plugin/src/config.ts'
import { resolveAssembly } from '../packages/vite-plugin/src/stages/assembly.ts'
import { validateBoards } from './contract/schema.ts'
import { readFileSync } from 'node:fs'

// ---- fixtures: a Prototype-like two-sided board ------------------------------------------

function pad(number: string, x: number, y: number, o: Partial<Pad> = {}): Pad {
  return {
    number, type: 'smd', shape: 'rect', at: { x, y }, rotation: 0, size: { width: 0.8, height: 0.8 }, drill: null,
    layers: ['F.Cu'], net: null, ...o,
  }
}
function fp(ref: string, value: string, footprint: string, side: 'front' | 'back', pads: Pad[], o: Partial<Footprint> = {}): Footprint {
  const xs = pads.map(p => p.at.x), ys = pads.map(p => p.at.y)
  const x0 = Math.min(...xs) - 1, y0 = Math.min(...ys) - 1
  return {
    ref, value, footprint, side, at: { x: 0, y: 0 }, rotation: 0,
    bbox: { x: x0, y: y0, width: Math.max(...xs) + 1 - x0, height: Math.max(...ys) + 1 - y0 },
    pads, fields: {}, dnp: false, excludeFromBom: false, excludeFromPos: false, path: null, ...o,
  }
}
/** Pads relative to a centre (cx, cy): the footprint's box is centred there. */
const at = (cx: number, cy: number, list: [string, number, number, Partial<Pad>?][]) => list.map(([n, x, y, o]) => pad(n, cx + x, cy + y, o))
const soic = (n: number, cx: number, cy: number, tht = false) => at(cx, cy, Array.from({ length: n }, (_, i) => {
  const half = n / 2, left = i < half
  const k = left ? i : n - 1 - i
  return [String(i + 1), left ? -4.6 : 4.6, -((half - 1) * 1.27) / 2 + k * 1.27, tht ? { type: 'thru_hole', drill: { width: 1, height: 1 } } : {}] as [string, number, number, Partial<Pad>]
}))

const LED = 'MirrorLink:MirrorLink_LED_4014_HandSolder'
const R1206 = 'Resistor_SMD:R_1206_3216Metric_Pad1.30x1.75mm_HandSolder'
const footprints: Footprint[] = [
  // LED: long pad 1 (cathode) to the west
  ...[1, 2, 3].map(i => fp(`D${i}`, 'white 4014', LED, 'front', at(10 * i, 10, [['1', -1.2, 0, { size: { width: 3.35, height: 0.8 } }], ['2', 1.95, 0, { size: { width: 1.85, height: 0.8 } }]]))),
  fp('U1', 'TBD62083AFWG', 'Package_SO:SOIC-18W_7.5x11.6mm_P1.27mm', 'back', soic(18, 40, 24)),
  fp('U2', 'TBD62083AFWG', 'Package_SO:SOIC-18W_7.5x11.6mm_P1.27mm', 'back', soic(18, 106, 24)),
  fp('RN1', '8x470', 'MirrorLink:MirrorLink_Bourns_4816P_SOIC-16_5.59mm_P1.27mm_HandSolder', 'back', soic(16, 40, 10)),
  ...['R1', 'R2', 'R3', 'R6'].map((r, i) => fp(r, r === 'R1' ? '330 (100 master)' : r === 'R6' ? 'DNP 4k7 (master)' : '330', R1206, 'back',
    at(60 + 5 * i, 19, [['1', 0, -1.5], ['2', 0, 1.5]]), { dnp: r === 'R6' })),
  fp('A1', 'Arduino Nano ESP32', 'MirrorLink:MirrorLink_Arduino_Nano_ESP32_Castellated_THT', 'back', soic(30, 57, 40, true)),
  fp('J1', 'IDC 2x5', 'Connector_IDC:IDC-Header_2x05_P2.54mm_Vertical', 'back', soic(10, 29, 40, true)),
  fp('J3', 'XH 2P 9V', 'Connector_JST:JST_XH_B2B-XH-A_1x02_P2.50mm_Vertical', 'back',
    at(107, 37, [['1', -1.25, 0, { type: 'thru_hole' }], ['2', 1.25, 0, { type: 'thru_hole' }]])),
  fp('H1', 'M2', 'MountingHole:MountingHole_2.2mm_M2', 'front', [pad('', 6, 6, { type: 'np_thru_hole' })]),
]
const row = (refs: string[], value: string, footprint: string, o: Partial<BomRow> = {}): BomRow =>
  ({ refs, quantity: refs.length, value, footprint, fields: {}, dnp: false, excludeFromBom: false, ...o })
const rows: BomRow[] = [
  row(['D1', 'D2', 'D3'], 'white 4014', LED, { fields: { MPN: 'KW DPLS32.EC', Manufacturer: 'ams OSRAM' } }),
  row(['U1', 'U2'], 'TBD62083AFWG', 'Package_SO:SOIC-18W_7.5x11.6mm_P1.27mm'),
  row(['RN1'], '8x470', 'MirrorLink:MirrorLink_Bourns_4816P_SOIC-16_5.59mm_P1.27mm_HandSolder'),
  row(['R2', 'R3'], '330', R1206),
  row(['R1'], '330 (100 master)', R1206),
  row(['R6'], 'DNP 4k7 (master)', R1206, { dnp: true }),
  row(['A1'], 'Arduino Nano ESP32', 'MirrorLink:MirrorLink_Arduino_Nano_ESP32_Castellated_THT'),
  row(['J1'], 'IDC 2x5', 'Connector_IDC:IDC-Header_2x05_P2.54mm_Vertical'),
  row(['J3'], 'XH 2P 9V', 'Connector_JST:JST_XH_B2B-XH-A_1x02_P2.50mm_Vertical'),
  row(['H1'], 'M2', 'MountingHole:MountingHole_2.2mm_M2', { excludeFromBom: true }),
]
const netlist: NetlistData = {
  nets: [{ code: 1, name: 'K', nodes: [{ ref: 'D1', pin: '1', pinFunction: 'K_1', pinType: 'passive' }, { ref: 'D1', pin: '2', pinFunction: 'A_2', pinType: 'passive' }] }],
}
const assembly = (o: Partial<BoardAssembly> = {}): BoardAssembly => ({
  sideOrder: ['back', 'front'], notes: [], refNotes: {}, noteFields: ['Assembly Note'], order: [], variants: [], ...o,
})
const refsOf = (steps: Step[]) => steps.map(s => s.refs.join(','))

// ---- ordering ----------------------------------------------------------------------------------

test('steps: one per BOM line and side, back first, SMD before THT, low before tall, then package', () => {
  const plan = buildPlan({ rows, footprints, netlist, assembly: assembly() })
  assert.deepEqual(refsOf(plan.steps), [
    'R2,R3', 'R1',          // back SMD, chip resistors (height 0); 1206 = 1206, then value
    'RN1', 'U1,U2',         // back SMD ICs (height 2), by package: SOIC-16 < SOIC-18W
    'J1', 'J3',             // back THT connectors (5)
    'A1',                   // back THT module (6)
    'D1,D2,D3',             // front
  ])
  assert.equal(plan.total, 12)
  assert.deepEqual(plan.empty.map(e => e.ref), ['R6'])   // DNP: only to leave empty
  assert.ok(!plan.steps.some(s => s.refs.includes('H1')))   // mechanical: no step
  const leds = plan.steps.at(-1)!
  assert.equal(leds.side, 'front')
  assert.equal(leds.pkg, '4014')
  assert.equal(leds.mpn, 'KW DPLS32.EC')
  assert.equal(leds.manufacturer, 'ams OSRAM')
})

test('steps: side order front first, and an explicit order wins within a side', () => {
  const front = buildPlan({ rows, footprints, assembly: assembly({ sideOrder: ['front', 'back'] }) })
  assert.equal(front.steps[0]!.refs[0], 'D1')
  // specs.md section 9 of the Prototype: U, RN, R, then the Nano before the headers
  const explicit = buildPlan({ rows, footprints, assembly: assembly({ sideOrder: ['front', 'back'], order: ['D1', 'U1', 'RN1', 'R2', 'R1', 'A1', 'J1', 'J3'] }) })
  assert.deepEqual(refsOf(explicit.steps), ['D1,D2,D3', 'U1,U2', 'RN1', 'R2,R3', 'R1', 'A1', 'J1', 'J3'])
})

test('steps: a BOM line with parts on both sides becomes one step per side', () => {
  const fps = [fp('C1', '100n', 'Capacitor_SMD:C_0603_1608Metric', 'front', at(0, 0, [['1', -0.8, 0], ['2', 0.8, 0]])),
    fp('C2', '100n', 'Capacitor_SMD:C_0603_1608Metric', 'back', at(5, 0, [['1', -0.8, 0], ['2', 0.8, 0]]))]
  const plan = buildPlan({ rows: [row(['C1', 'C2'], '100n', 'Capacitor_SMD:C_0603_1608Metric')], footprints: fps, assembly: assembly() })
  assert.deepEqual(plan.steps.map(s => [s.side, s.refs.join()]), [['back', 'C2'], ['front', 'C1']])
})

test('steps: without a BOM the footprints are grouped by value and footprint', () => {
  const plan = buildPlan({ rows: null, footprints, assembly: assembly() })
  assert.ok(plan.steps.some(s => s.refs.join() === 'D1,D2,D3'))
  assert.deepEqual(plan.empty.map(e => e.ref), ['R6'])
})

test('sortSteps defaults to back first without settings', () => {
  const plan = buildPlan({ rows, footprints })
  assert.equal(sortSteps(plan.steps, null)[0]!.side, 'back')
})

test('package and height class', () => {
  assert.equal(packageOf('MirrorLink:MirrorLink_Bourns_4816P_SOIC-16_5.59mm_P1.27mm_HandSolder'), 'SOIC-16')
  assert.equal(packageOf('Package_SO:SOIC-18W_7.5x11.6mm_P1.27mm'), 'SOIC-18W')
  assert.equal(packageOf(R1206), '1206')
  assert.equal(packageOf(LED), '4014')
  assert.equal(packageOf('Package_TO_SOT_SMD:SOT-23-5'), 'SOT-23-5')
  assert.equal(packageOf('Package_DFN_QFN:QFN-32-1EP_5x5mm_P0.5mm'), 'QFN-32')
  assert.equal(packageOf('Connector_IDC:IDC-Header_2x05_P2.54mm_Vertical'), 'IDC-Header_2x05_P2.54mm_Vertical')
  const h = (f: string, r: string, m: 'smd' | 'tht' = 'smd') => heightClass(f, r, m)
  assert.ok(h(R1206, 'R1') < h(LED, 'D1'))
  assert.ok(h(LED, 'D1') < h('Package_SO:SOIC-18W_7.5x11.6mm_P1.27mm', 'U1'))
  assert.ok(h('Package_SO:SOIC-8', 'U1') < h('Capacitor_SMD:CP_Elec_6.3x5.4', 'C9'))
  assert.ok(h('Connector_JST:JST_XH_B2B', 'J3', 'tht') < h('MirrorLink_Arduino_Nano_ESP32_Castellated_THT', 'A1', 'tht'))
})

// ---- polarity -------------------------------------------------------------------------------

const pol = (ref: string, pins?: Map<string, { fn?: string; type?: string }>) => detectPolarity(footprints.find(f => f.ref === ref)!, pins)

test('polarity: LED cathode from the symbol pin (K_1), else pad 1; direction in board coordinates', () => {
  const byPin = pol('D1', new Map([['1', { fn: 'K_1', type: 'passive' }], ['2', { fn: 'A_2', type: 'passive' }]]))
  assert.deepEqual([byPin?.kind, byPin?.pad, byPin?.source, byPin?.dir, byPin?.label], ['cathode', '1', 'pin-function', 'W', 'Cathode (pad 1) W'])
  const byAnode = pol('D1', new Map([['2', { fn: 'A' }]]))
  assert.deepEqual([byAnode?.pad, byAnode?.source], ['1', 'pin-function'])
  const byConvention = pol('D2')
  assert.deepEqual([byConvention?.kind, byConvention?.pad, byConvention?.source], ['cathode', '1', 'pad-1'])
  // a reversed footprint whose pad 2 is the cathode, named on the pad itself
  const rev = fp('D9', 'red', 'LED_SMD:LED_0805_2012Metric', 'front', at(0, 0, [['1', -1, 0, { pinFunction: 'A' }], ['2', 1, 0, { pinFunction: 'K' }]]))
  assert.deepEqual([detectPolarity(rev)?.pad, detectPolarity(rev)?.dir], ['2', 'E'])
})

test('polarity: pin 1 of ICs, networks, modules and connectors; none for resistors and holes', () => {
  for (const r of ['U1', 'RN1', 'A1', 'J1', 'J3']) {
    const p = pol(r)
    assert.equal(p?.kind, 'pin1', r)
    assert.equal(p?.pad, '1', r)
  }
  assert.equal(pol('U1')?.dir, 'NW')
  assert.equal(pol('R2'), null)
  assert.equal(pol('H1'), null)
  // a two-pin part with non-passive symbol pins (e.g. a sensor) gets pin 1 from the pin type
  const two = fp('U9', 'TMP', 'Package_TO_SOT_SMD:SOD-323', 'front', at(0, 0, [['1', -1, 0], ['2', 1, 0]]))
  assert.equal(detectPolarity(two, new Map([['1', { type: 'power_in' }], ['2', { type: 'output' }]]))?.source, 'pin-type')
})

test('polarity: polarized capacitors mark the + pad', () => {
  const cp = fp('C5', '10u', 'Capacitor_SMD:CP_Elec_5x5.4', 'front', at(0, 0, [['1', 0, -2], ['2', 0, 2]]))
  assert.deepEqual([detectPolarity(cp)?.kind, detectPolarity(cp)?.pad, detectPolarity(cp)?.dir], ['plus', '1', 'N'])
  const tant = fp('C6', '22u', 'Capacitor_Tantalum_SMD:CP_EIA-3528-21_Kemet-B', 'front', at(0, 0, [['1', 1, 0], ['2', -1, 0]]))
  assert.equal(detectPolarity(tant, new Map([['2', { fn: '+' }]]))?.pad, '2')
  const plain = fp('C7', '100n', 'Capacitor_SMD:C_0603_1608Metric', 'front', at(0, 0, [['1', -1, 0], ['2', 1, 0]]))
  assert.equal(detectPolarity(plain), null)
})

test('polarity helpers', () => {
  assert.equal(pinName('K_1', '1'), 'K')
  assert.equal(pinName('SDA/A4_23', '23'), 'SDA/A4')
  assert.equal(pinName(undefined, '1'), '')
  assert.equal(compass(1, 0), 'E')
  assert.equal(compass(0, 1), 'S')          // y grows south
  assert.equal(compass(-1, -1), 'NW')
  assert.equal(compass(0.01, 0), null)
  assert.equal(compass(-2, 1, true), 'W')
  assert.equal(mirrored('NW'), 'NE')
  assert.equal(mirrored('S'), 'S')
})

test('steps carry the polarity summary; Blinky fixture: D1 cathode from the netlist', () => {
  const fixture = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/contract/merged/${n}`, import.meta.url), 'utf8'))
  const plan = buildPlan({ rows: fixture('bom-Blinky.json').rows, footprints: fixture('parts-Blinky.json').footprints, netlist: fixture('netlist-Blinky.json') })
  const d1 = plan.steps.find(s => s.refs.includes('D1'))!
  assert.deepEqual([d1.polarity?.kind, d1.polarity?.pad, d1.polarity?.source], ['cathode', '1', 'pin-function'])
  assert.equal(plan.steps.find(s => s.refs.includes('R1'))!.polarity, null)
  assert.equal(plan.steps.find(s => s.refs.includes('J1'))!.polarity?.kind, 'pin1')
  assert.equal(plan.steps[0]!.refs[0], 'C1')   // C1 is the only back part
  assert.ok(!plan.steps.some(s => s.refs.includes('H1')))
})

// ---- variants, notes ---------------------------------------------------------------------------

const variants: BoardAssembly['variants'] = [
  { id: 'master', label: 'Bus master', fit: ['R6'], dnp: [], values: { R1: '100' }, note: null },
  { id: 'slave', label: 'Slave', fit: [], dnp: [], values: { R1: '330' }, note: null },
]

test('variants: fit a DNP part, override a value (own step), notes on the step', () => {
  const a = assembly({ variants, refNotes: { R1: '100 Ω on the bus master, 330 Ω on slaves' } })
  const master = buildPlan({ rows, footprints, assembly: a, variant: 'master' })
  assert.deepEqual(master.empty, [])
  const r6 = master.steps.find(s => s.refs.includes('R6'))!
  assert.equal(r6.value, 'DNP 4k7 (master)')
  assert.match(r6.parts[0]!.notes.join(), /Bus master: fitted/)
  const r1 = master.steps.find(s => s.refs.includes('R1'))!
  assert.deepEqual([r1.value, r1.designValue, r1.refs], ['100', '330 (100 master)', ['R1']])
  assert.deepEqual(r1.parts[0]!.notes, ['100 Ω on the bus master, 330 Ω on slaves', 'Bus master: 100 (designed 330 (100 master))'])
  const slave = buildPlan({ rows, footprints, assembly: a, variant: 'slave' })
  assert.deepEqual(slave.empty.map(e => e.ref), ['R6'])
  assert.equal(slave.steps.find(s => s.refs.includes('R1'))!.value, '330')
  // as designed: R6 empty, R1 as in the schematic
  const base = buildPlan({ rows, footprints, assembly: a, variant: null })
  assert.equal(base.steps.find(s => s.refs.includes('R1'))!.value, '330 (100 master)')
})

test('notes: a footprint field named in noteFields is a part note', () => {
  const fps = footprints.map(f => (f.ref === 'U1' ? { ...f, fields: { 'Assembly Note': 'Check pin 1 against the silk dot' } } : f))
  const plan = buildPlan({ rows, footprints: fps, assembly: assembly() })
  assert.deepEqual(plan.steps.find(s => s.refs.includes('U1'))!.parts.find(p => p.ref === 'U1')!.notes, ['Check pin 1 against the silk dot'])
})

test('markdown: subset rendered, everything else escaped', () => {
  assert.equal(renderMarkdown('# Title\n\nSome **bold** and `x<y`.'), '<h3>Title</h3><p>Some <strong>bold</strong> and <code>x&lt;y</code>.</p>')
  assert.equal(renderMarkdown('- a\n- b\n  - c\n- d'), '<ul><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ul>')
  assert.equal(renderMarkdown('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>')
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  assert.equal(renderMarkdown('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>')
  assert.match(renderMarkdown('[spec](https://example.com/a?b=1&c=2)'), /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">spec<\/a>/)
  assert.equal(renderMarkdown('> quoted\n\n---'), '<blockquote><p>quoted</p></blockquote><hr>')
  assert.equal(renderMarkdown('R1: 100 Ω on the *master*'), '<p>R1: 100 Ω on the <em>master</em></p>')
})

// ---- progress --------------------------------------------------------------------------------

test('progress: key per board, revision and variant; export / import round trip with checks', () => {
  assert.equal(progressKey('Prototype', '0.1.0', null), 'kiview.assembly:Prototype@0.1.0')
  assert.equal(progressKey('Prototype', '0.1.0', 'master'), 'kiview.assembly:Prototype@0.1.0#master')
  const f = exportProgress({ board: 'Prototype', rev: '0.1.0', variant: 'master', placed: ['U2', 'D1'], current: 'x' }, new Date('2026-10-17T00:00:00Z'))
  assert.deepEqual(f.placed, ['D1', 'U2'])
  const known = new Set(['D1', 'U2', 'U1'])
  const ok = parseProgress(JSON.stringify(f), 'Prototype', '0.1.0', known)
  assert.ok(ok.ok && ok.warnings.length === 0 && ok.file.placed.join() === 'D1,U2' && ok.file.variant === 'master')
  const other = parseProgress(JSON.stringify({ ...f, rev: '0.0.9', placed: ['D1', 'Q7'] }), 'Prototype', '0.1.0', known)
  assert.ok(other.ok)
  assert.deepEqual(other.ok && other.file.placed, ['D1'])
  assert.equal(other.ok && other.warnings.length, 2)
  const wrong = parseProgress(JSON.stringify(f), 'Blinky', '0.1.0', known)
  assert.ok(!wrong.ok && /for board "Prototype"/.test(wrong.error))
  assert.ok(!parseProgress('{', 'Prototype', '0.1.0', known).ok)
  assert.ok(!parseProgress('{"kind":"other"}', 'Prototype', '0.1.0', known).ok)
})

// ---- BOM: DNP parts stay out by default -------------------------------------------------------

test('BOM table: DNP lines only with bom.showDnp', () => {
  assert.deepEqual(visibleRows(rows, false).flatMap(r => r.refs).includes('R6'), false)
  assert.deepEqual(visibleRows(rows, true).flatMap(r => r.refs).includes('R6'), true)
  const c = resolveConfig({ bom: { showDnp: { Prototype: true } } }, '/x')
  assert.deepEqual([c.bom.showDnp('Prototype'), c.bom.showDnp('Blinky')], [true, false])
  assert.equal(resolveConfig({}, '/x').bom.showDnp('Any'), false)
})

// ---- config, stage, contract -------------------------------------------------------------------

test('config: assembly defaults and per-board entries', () => {
  const c = resolveConfig({ assembly: { refNotes: { R9: 'site' }, boards: { Prototype: { sideOrder: 'front-first', refNotes: { R1: 'x' }, notesFile: false } } } }, '/x')
  const p = c.assembly('Prototype'), b = c.assembly('Blinky')
  assert.deepEqual([p.sideOrder, p.notesFile, p.refNotes], ['front-first', false, { R9: 'site', R1: 'x' }])
  assert.deepEqual([b.sideOrder, b.notesFile, b.noteFields], ['back-first', 'ASSEMBLY.md', ['Assembly Note', 'Assembly Notes', 'Assembly']])
})

test('assembly stage: notes file, then config notes; variants listed; payload valid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kwv-asm-'))
  try {
    const board = join(dir, 'Proto')
    writeFileSync(join(dir, 'ASSEMBLY.md'), '')   // not the board's dir: ignored
    const { mkdirSync } = await import('node:fs')
    mkdirSync(board)
    writeFileSync(join(board, 'ASSEMBLY.md'), '# Notes\n- one\n')
    const config = resolveConfig({ assembly: { boards: { Proto: { notes: 'From the config', variants: { master: { fit: ['R6'], values: { R1: '100' } } } } } } }, dir)
    const input = { src: { name: 'Proto', dir: board, pcb: join(board, 'Proto.kicad_pcb'), sch: null, pro: null }, config } as unknown as Parameters<typeof resolveAssembly>[0]
    const a = await resolveAssembly(input)
    assert.deepEqual(a.sideOrder, ['back', 'front'])
    assert.deepEqual(a.notes.map(n => n.source), ['Proto/ASSEMBLY.md', 'config'])
    assert.deepEqual(a.variants, [{ id: 'master', label: 'master', fit: ['R6'], dnp: [], values: { R1: '100' }, note: null }])

    // the board manifest with the additive fields still validates; a bad side order does not
    const b = JSON.parse(readFileSync(new URL('./fixtures/contract/merged/board-Blinky.json', import.meta.url), 'utf8'))
    assert.deepEqual(validateBoards([{ ...b, assembly: a, bomOptions: { showDnp: false } }]), [])
    assert.match(validateBoards([{ ...b, assembly: { ...a, sideOrder: ['back', 'back'] } }]).join(), /assembly\.sideOrder: expected both sides once/)
    assert.match(validateBoards([{ ...b, bomOptions: { showDnp: 'no' } }]).join(), /bomOptions\.showDnp: expected a boolean/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
