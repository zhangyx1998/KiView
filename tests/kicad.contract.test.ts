// Contract tests for @kiview/kicad that need no KiCad install.
// [P2-e] extend: help-text fixtures per KiCad version (tests/fixtures/help/<ver>/),
// selection with fake probes, and the CI matrix that runs live exports.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { capabilitiesFromHelp, minKicadFor, parseHelp, parseVersion, readBoard, versionMatches } from '@kiview/kicad'

const example = new URL('../examples/boards/Blinky/Blinky.kicad_pcb', import.meta.url)

test('parseVersion', () => {
  assert.deepEqual(parseVersion('10.0.6\n'), { major: 10, minor: 0, patch: 6, raw: '10.0.6' })
  assert.equal(parseVersion('9.0.1-rc1')?.major, 9)
  assert.equal(parseVersion('nonsense'), null)
})

test('parseHelp reads subcommands and flags', () => {
  const help = parseHelp(`Usage: pcb export [--help] {svg,vrml}

Optional arguments:
  -h, --help  Shows help message and exits

Subcommands:
  svg        Generate SVG outputs
  vrml       Export VRML
`)
  assert.deepEqual(help.subcommands, ['svg', 'vrml'])
  assert.ok(help.flags.includes('--help'))
})

test('capabilities come from help facts', () => {
  const caps = capabilitiesFromHelp({
    'pcb': { subcommands: ['export'], flags: [] },
    'pcb export': { subcommands: ['svg', 'vrml'], flags: [] },
    'pcb export svg': { subcommands: [], flags: ['--drill-shape-opt'] },
  })
  assert.equal(caps.ops.layerSvg, true)
  assert.equal(caps.layerSvg.multiFile, false)
  assert.equal(caps.ops.thumbnail, false)
  assert.deepEqual(caps.model3d.formats, ['vrml'])
})

test('file format version -> minimum KiCad', () => {
  assert.equal(minKicadFor(20171130, 'pcb'), 5)
  assert.equal(minKicadFor(20221018, 'pcb'), 7)
  assert.equal(minKicadFor(20240108, 'pcb'), 8)
  assert.equal(minKicadFor(20260206, 'pcb'), 10)
  assert.equal(minKicadFor(20270101, 'pcb'), 11)
  assert.equal(minKicadFor(20250114, 'sch'), 9)
})

test('version constraints', () => {
  assert.ok(versionMatches(9, 'auto'))
  assert.ok(versionMatches(9, '>=8 <10'))
  assert.ok(!versionMatches(10, '<10'))
  assert.ok(versionMatches(8, '8'))
})

test('readBoard on the example project', () => {
  const info = readBoard(readFileSync(example, 'utf8'))
  assert.equal(info.formatVersion, 20260206)
  assert.equal(info.minKicad, 10)
  assert.equal(info.titleBlock.title, 'Blinky')
  assert.equal(info.titleBlock.rev, 'A')
  assert.equal(info.stackup.copperLayers, 2)
  assert.ok(info.stackup.maskColor.front)
  assert.ok(info.outline && Math.abs(info.outline.width - 30) < 0.01 && Math.abs(info.outline.height - 20) < 0.01)
  assert.ok(info.layers.some(l => l.name === 'Edge.Cuts'))
})
