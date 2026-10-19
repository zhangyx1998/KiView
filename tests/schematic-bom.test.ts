// P2-b: sheet tree, BOM grouping / netlist parsing, footprint geometry. No KiCad needed.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  compareRefs, groupBom, parseNetlist, readBoard, readSchematicTree, schematicFileSet, schematicSvgName, symbolTransform,
  type BomRow,
} from '@kiview/kicad'

const blinky = fileURLToPath(new URL('../examples/boards/Blinky/', import.meta.url))
const ROOT_UUID = '2b34ee74-f238-5620-a2e1-ef38b68dd404'
const LED_SHEET = '883fe969-8fd0-54a8-8030-42762e96ca35'

// ---- sheet tree ---------------------------------------------------------------------

test('sheet tree of Blinky: root + one hierarchical sheet', async () => {
  const sheets = await readSchematicTree(join(blinky, 'Blinky.kicad_sch'))
  assert.deepEqual(sheets.map(s => [s.path, s.name, s.page, s.parent, s.source]), [
    ['/', 'Blinky', '1', null, 'Blinky.kicad_sch'],
    [`/${LED_SHEET}/`, 'LED driver', '2', '/', 'led_driver.kicad_sch'],
  ])
  const [root, led] = sheets as [typeof sheets[0], typeof sheets[0]]
  assert.equal(root.symbolBox, null)
  assert.deepEqual(led.symbolBox, { x: 88.9, y: 71.12, width: 25.4, height: 12.7 })
  assert.deepEqual(root.symbols.map(s => s.ref).sort(), ['C1', 'H1', 'J1'])   // power symbols (#PWR, #FLG) left out
  assert.deepEqual(led.symbols.map(s => s.ref).sort(), ['D1', 'R1'])
  assert.equal(root.titleBlock.title, 'Blinky')
  // R1 (Device:R at 63.5 80.01, unrotated): body 2.032 wide, pins reach +-3.81
  const r1 = led.symbols.find(s => s.ref === 'R1')!.bbox
  assert.ok(Math.abs(r1.width - 2.032) < 1e-3 && Math.abs(r1.height - 7.62) < 1e-3, JSON.stringify(r1))
})

test('sheet tree: nested sheet in a sub-directory, names with "/"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kwv-sheets-'))
  try {
    cpSync(blinky, dir, { recursive: true })
    const led = join(dir, 'led_driver.kicad_sch')
    const sheet = `\t(sheet (at 150 60) (size 20 10) (uuid "11111111-2222-3333-4444-555555555555")
\t\t(property "Sheetname" "Inner/Deep" (at 150 59 0)) (property "Sheetfile" "sub/inner.kicad_sch" (at 150 71 0))
\t\t(instances (project "" (path "/${ROOT_UUID}/${LED_SHEET}" (page "3")))))\n`
    const text = readFileSync(led, 'utf8')
    writeFileSync(led, text.slice(0, text.lastIndexOf(')')) + sheet + ')\n')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'inner.kicad_sch'), '(kicad_sch (version 20260306) (generator "eeschema") (uuid "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") (paper "A5"))\n')

    const sheets = await readSchematicTree(join(dir, 'Blinky.kicad_sch'))
    assert.equal(sheets.length, 3)
    const inner = sheets[2]!
    assert.equal(inner.path, `/${LED_SHEET}/11111111-2222-3333-4444-555555555555/`)
    assert.equal(inner.parent, `/${LED_SHEET}/`)
    assert.equal(inner.page, '3')
    assert.equal(inner.source, 'sub/inner.kicad_sch')
    assert.deepEqual(inner.names, ['LED driver', 'Inner/Deep'])
    assert.equal(schematicSvgName('Blinky', inner.names), 'Blinky-LED driver-Inner_Deep.svg')   // as kicad-cli names it

    const files = await schematicFileSet(join(dir, 'Blinky.kicad_sch'))
    assert.deepEqual([...files.keys()].sort(), ['Blinky.kicad_sch', 'led_driver.kicad_sch', 'sub/inner.kicad_sch'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('symbol transform: lib Y up, rotation counter-clockwise, then mirror', () => {
  const apply = (t: ReturnType<typeof symbolTransform>, x: number, y: number) =>
    [t.x1 * x + t.y1 * y, t.x2 * x + t.y2 * y].map(v => v + 0)   // -0 -> 0
  assert.deepEqual(apply(symbolTransform(0, ''), 0, 3.81), [0, -3.81])      // top pin stays on top (sheet y down)
  assert.deepEqual(apply(symbolTransform(90, ''), 0, 3.81), [-3.81, 0])     // turned left
  assert.deepEqual(apply(symbolTransform(180, ''), 0, 3.81), [0, 3.81])
  assert.deepEqual(apply(symbolTransform(270, ''), 0, 3.81), [3.81, 0])
  assert.deepEqual(apply(symbolTransform(0, 'y'), 2, 0), [-2, 0])          // mirror y: left-right
  assert.deepEqual(apply(symbolTransform(0, 'x'), 0, 3.81), [0, 3.81])     // mirror x: up-down
})

// ---- BOM -----------------------------------------------------------------------------

const row = (ref: string, value: string, fields: Record<string, string> = {}, extra: Partial<BomRow> = {}): BomRow =>
  ({ refs: [ref], quantity: 1, value, footprint: 'R_0603', fields, dnp: false, excludeFromBom: false, ...extra })

test('BOM grouping: value + footprint + fields, DNP apart, natural ref order, lossless', () => {
  const items = [
    row('R10', '10k', { MPN: 'A' }), row('R2', '10k', { MPN: 'A', Description: 'pull-up' }), row('R1', '10k', { MPN: 'B' }),
    row('R3', '10k', { MPN: 'A' }, { dnp: true }), row('C1', '100n', {}, { footprint: 'C_0603' }), row('R4', '1k', { MPN: 'A' }),
  ]
  const rows = groupBom(items)
  assert.deepEqual(rows.map(r => [r.refs.join(','), r.quantity]), [['C1', 1], ['R1', 1], ['R2,R10', 2], ['R3', 1], ['R4', 1]])
  const r2 = rows.find(r => r.refs[0] === 'R2')!
  assert.equal(r2.fields.Description, 'pull-up')   // Description does not split a group
  assert.equal(rows.find(r => r.refs[0] === 'R3')!.dnp, true)
  assert.equal(rows.reduce((n, r) => n + r.quantity, 0), items.length)
  assert.deepEqual(['R10', 'U1A', 'R2', 'C3', 'U1', 'RN1'].sort(compareRefs), ['C3', 'R2', 'R10', 'RN1', 'U1', 'U1A'])
})

test('netlist parsing: fields, DNP / exclude flags, symbol paths, nets', () => {
  const n = parseNetlist(`(export (version "E")
    (components
      (comp (ref "R1") (value "330") (footprint "R:R_0805")
        (fields (field (name "MPN") "RC0805") (field (name "Footprint") "R:R_0805") (field (name "Datasheet") "~"))
        (property (name "dnp")) (sheetpath (names "/LED/") (tstamps "/aa/")) (tstamps "bb"))
      (comp (ref "H1") (value "Hole") (footprint "M:H") (property (name "exclude_from_bom")) (sheetpath (names "/") (tstamps "/")) (tstamps "cc")))
    (nets (net (code "1") (name "GND") (class "Default") (node (ref "R1") (pin "2") (pinfunction "K") (pintype "passive")))))`)
  assert.deepEqual(n.components.map(c => [c.ref, c.dnp, c.excludeFromBom, c.path, c.fields]), [
    ['R1', true, false, '/aa/bb', { MPN: 'RC0805' }],
    ['H1', false, true, '/cc', {}],
  ])
  assert.deepEqual(n.nets, [{ code: 1, name: 'GND', netClass: 'Default', nodes: [{ ref: 'R1', pin: '2', pinFunction: 'K', pinType: 'passive' }] }])
})

// ---- footprints ---------------------------------------------------------------------------

test('footprint geometry of Blinky', () => {
  const info = readBoard(readFileSync(join(blinky, 'Blinky.kicad_pcb'), 'utf8'))
  const by = Object.fromEntries(info.footprints.map(f => [f.ref, f]))
  assert.deepEqual(Object.keys(by).sort(), ['C1', 'D1', 'H1', 'J1', 'R1'])

  const r1 = by.R1!
  assert.equal(r1.value, '330')
  assert.equal(r1.footprint, 'Resistor_SMD:R_0805_2012Metric')
  assert.equal(r1.side, 'front')
  assert.deepEqual(r1.at, { x: 115, y: 108.73 })
  assert.deepEqual(r1.bbox, { x: 113.32, y: 107.78, width: 3.36, height: 1.9 })   // the courtyard rectangle
  assert.deepEqual(r1.pads.map(p => [p.number, p.type, p.shape, p.at, p.size, p.net?.name]), [
    ['1', 'smd', 'roundrect', { x: 114.0875, y: 108.73 }, { width: 1.025, height: 1.4 }, '+5V'],
    ['2', 'smd', 'roundrect', { x: 115.9125, y: 108.73 }, { width: 1.025, height: 1.4 }, '/LED driver/LED_A'],
  ])
  assert.equal(r1.fields.MPN, 'RC0805FR-07330RL')
  assert.equal(r1.path, `/${LED_SHEET}/a75daf77-db42-5f7a-b40b-f4310621a2e7`)

  assert.equal(by.C1!.side, 'back')
  assert.ok(by.C1!.pads.every(p => p.layers.includes('B.Cu')))
  assert.equal(by.H1!.excludeFromBom, true)
  assert.equal(by.H1!.excludeFromPos, true)
  assert.deepEqual(by.H1!.pads[0]!.drill, { width: 3.2, height: 3.2 })
  const j1 = by.J1!
  assert.ok(j1.pads.every(p => p.type === 'thru_hole' && p.drill?.width === 1 && p.layers.includes('F.Cu') && p.layers.includes('B.Cu')))
  // pads of a net share one code
  const codes = new Set(info.footprints.flatMap(f => f.pads).filter(p => p.net?.name === '+5V').map(p => p.net!.code))
  assert.equal(codes.size, 1)
  // every pad lies inside its footprint's box
  for (const f of info.footprints) for (const p of f.pads)
    assert.ok(p.at.x >= f.bbox.x - 1e-6 && p.at.x <= f.bbox.x + f.bbox.width + 1e-6 && p.at.y >= f.bbox.y - 1e-6 && p.at.y <= f.bbox.y + f.bbox.height + 1e-6, `${f.ref} pad ${p.number}`)
})
