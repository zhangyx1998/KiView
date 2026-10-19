// [P2-d] board statistics, copper geometry and DRC / ERC report parsing (no KiCad needed).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { computeBoardStats, mergeStats, parseCheckReport, parseKicadStatsJson, parseSExpr, readGeometry, type SExpr } from '@kiview/kicad'

const dir = new URL('../examples/boards/Blinky/', import.meta.url)
const pcb = readFileSync(new URL('Blinky.kicad_pcb', dir), 'utf8')
const pro = readFileSync(new URL('Blinky.kicad_pro', dir), 'utf8')

test('stats from the Blinky board file', () => {
  const s = computeBoardStats(pcb, pro)
  assert.deepEqual(s.size, { width: 30, height: 20 })
  assert.equal(s.copperLayers, 2)
  assert.equal(s.thickness, 1.6)
  assert.equal(s.layerCount, 24)
  // matches `kicad-cli pcb export stats` for this board: 4 front / 1 back, 3 SMD, 1 THT, 1 unspecified
  assert.deepEqual(s.footprints, { front: 4, back: 1, smd: 3, tht: 1 })
  assert.deepEqual(s.parts, { front: { smd: 2, tht: 1, other: 1 }, back: { smd: 1, tht: 0, other: 0 } })
  assert.equal(s.pads, 9)
  assert.deepEqual(s.padTypes, { smd: 6, tht: 2, npth: 1 })
  assert.equal(s.vias, 1)
  assert.deepEqual(s.viaSizes, [{ size: 0.6, drill: 0.3, type: 'through', count: 1 }])
  assert.deepEqual(s.holes, { plated: 3, nonPlated: 1, minDiameter: 0.3 })
  assert.deepEqual(s.drills?.map(d => [d.width, d.plated, d.source, d.count]),
    [[0.3, true, 'via', 1], [1, true, 'pad', 2], [3.2, false, 'pad', 1]])
  assert.equal(s.minTrack, 0.3)
  assert.equal(s.minAnnularRing, 0.15)
  assert.equal(s.tracks?.count, 4)
  assert.equal(s.rules?.minTrackWidth, 0.2)
  assert.equal(s.rules?.minClearance, 0.2)
  assert.deepEqual(s.stackup?.layers.filter(l => l.type === 'copper').map(l => l.name), ['F.Cu', 'B.Cu'])
  assert.equal(s.stackup?.layers.find(l => l.type === 'core')?.material, 'FR4')
  assert.equal(s.source, 'file')
})

test('kicad-cli stats JSON is merged over the file numbers', () => {
  const cli = parseKicadStatsJson(JSON.stringify({
    board: { width: '30.0000 mm', height: '20.0000 mm', area: '599.138 mm²', min_track_clearance: '1.4750 mm',
             min_track_width: '0.3000 mm', min_drill_diameter: '0.3000 mm', board_thickness: '1.6000 mm' },
    vias: { through: 1, blind: 0, buried: 0, micro: 0 },
    components: { smd: { front: 2, back: 1 }, tht: { front: 1, back: 0 }, unspecified: { front: 1, back: 0 } },
  }))
  assert.equal(cli.minClearance, 1.475)
  assert.equal(cli.area, 599.138)
  assert.deepEqual(cli.parts?.front, { smd: 2, tht: 1, other: 1 })
  const s = mergeStats(computeBoardStats(pcb, pro), cli)
  assert.equal(s.minClearance, 1.475)
  assert.equal(s.area, 599.14)
  assert.equal(s.source, 'file+kicad-cli')
})

test('copper geometry by net', () => {
  const root = parseSExpr(pcb).find(e => Array.isArray(e) && e[0] === 'kicad_pcb') as SExpr[]
  const g = readGeometry(root)
  assert.deepEqual(g.copper, ['F.Cu', 'B.Cu'])
  assert.ok(g.nets.includes('GND') && g.nets.includes('+5V'))
  const gnd = g.nets.indexOf('GND')
  assert.equal(g.vias.length, 1)
  assert.equal(g.vias[0]!.net, gnd)
  assert.deepEqual(g.vias[0]!.at, { x: 123, y: 108.73 })
  assert.equal(g.tracks.length, 4)
  assert.ok(g.zones.some(z => z.net === gnd))
  assert.equal(g.pads.length, 9)
  const thPads = g.pads.filter(p => p.drill && p.layers.length === 2)
  assert.ok(thPads.length >= 2, 'through-hole pads span both copper layers (wildcards expanded)')
})

const drcJson = JSON.stringify({
  $schema: 'https://schemas.kicad.org/drc.v1.json', coordinate_units: 'mm', date: '2026-10-09T00:06:09', kicad_version: '10.0.6',
  violations: [
    { type: 'clearance', severity: 'error', description: 'Clearance violation (netclass Default clearance 0.2000 mm; actual 0.1000 mm)',
      items: [{ description: 'Track [GND] on F.Cu, length 2.0 mm', pos: { x: 120.5, y: 108.7 }, uuid: 'a' },
              { description: 'Pad 1 [+5V] of C1 on F.Cu', pos: { x: 121, y: 108.8 }, uuid: 'b' }] },
    { type: 'silk_overlap', severity: 'warning', description: 'Silkscreen overlap', items: [{ description: 'Footprint R1', pos: { x: 1, y: 2 } }] },
    { type: 'lib_footprint_mismatch', severity: 'exclusion', description: 'excluded', items: [] },
  ],
  unconnected_items: [{ type: 'unconnected_items', severity: 'error', description: 'Missing connection',
                        items: [{ description: 'Pad 2 [GND] of J1', pos: { x: 3, y: 4 } }] }],
  schematic_parity: [{ type: 'missing_footprint', severity: 'warning', description: 'Missing footprint R9', items: [] }],
})

test('DRC JSON parsing', () => {
  const r = parseCheckReport(drcJson, 'drc')
  assert.equal(r.kind, 'drc')
  assert.equal(r.kicadVersion, '10.0.6')
  assert.equal(r.violations.length, 3)
  assert.equal(r.unconnected.length, 1)
  assert.equal(r.parity.length, 1)
  assert.deepEqual(r.counts, { error: 2, warning: 2, exclusion: 1, info: 0 })
  const v = r.violations[0]!
  assert.equal(v.type, 'clearance')
  assert.deepEqual(v.items[0]!.pos, { x: 120.5, y: 108.7 })
  assert.equal(v.items[1]!.ref, 'C1')
  assert.equal(r.violations[1]!.items[0]!.ref, 'R1')
  assert.equal(r.unconnected[0]!.items[0]!.ref, 'J1')
})

test('DRC JSON in inches is converted to mm', () => {
  const r = parseCheckReport(JSON.stringify({ coordinate_units: 'in', violations: [
    { type: 'x', severity: 'error', description: '', items: [{ description: '', pos: { x: 1, y: 2 } }] }] }), 'drc')
  assert.deepEqual(r.violations[0]!.items[0]!.pos, { x: 25.4, y: 50.8 })
})

test('ERC JSON: sheets flattened, the 1/100 position scale corrected', () => {
  const r = parseCheckReport(JSON.stringify({
    coordinate_units: 'mm', kicad_version: '10.0.6',
    sheets: [
      { path: '/', violations: [{ type: 'pin_not_connected', severity: 'error', description: 'Pin not connected',
                                  items: [{ description: 'Symbol U1 Pin 3 [NC, Passive, Line]', pos: { x: 0.3683, y: 0.9779 } }] }] },
      { path: '/LED driver/', violations: [{ type: 'lib_symbol_mismatch', severity: 'warning', description: 'mismatch',
                                             items: [{ description: 'Symbol C2 [C_Small]', pos: { x: 1.27, y: 0.5715 } }] }] },
    ],
  }), 'erc')
  assert.equal(r.violations.length, 2)
  assert.deepEqual(r.counts, { error: 1, warning: 1, exclusion: 0, info: 0 })
  assert.deepEqual(r.violations[0]!.items[0], { description: 'Symbol U1 Pin 3 [NC, Passive, Line]', pos: { x: 36.83, y: 97.79 }, sheet: '/', ref: 'U1' })
  assert.equal(r.violations[1]!.items[0]!.sheet, '/LED driver/')
  assert.deepEqual(r.violations[1]!.items[0]!.pos, { x: 127, y: 57.15 })
})

test('ERC positions already in mm are kept', () => {
  const r = parseCheckReport(JSON.stringify({ coordinate_units: 'mm', sheets: [{ path: '/', violations: [
    { type: 'x', severity: 'warning', description: '', items: [{ description: '', pos: { x: 36.83, y: 97.79 } }] }] }] }), 'erc')
  assert.deepEqual(r.violations[0]!.items[0]!.pos, { x: 36.83, y: 97.79 })
})
