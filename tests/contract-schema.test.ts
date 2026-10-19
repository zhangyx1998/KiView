// Schema validation of the virtual-module JSON (Board[] and SiteData) on fixtures; no
// KiCad needed. tests/fixtures/contract/boards-kicad10.json is the manifest of
// examples/boards exported with KiCad 10.0.6 (refresh it from .contract-out/boards.json
// after `node tests/contract/run.ts` when the contract changes); board-phase2.json is
// the same Hierarchy board with every phase-2 field filled, so the schema of those
// fields is pinned before the streams land. merged/ holds the Blinky board of the merged
// phase-2 export (KiCad 10.0.6) and the JSON payloads behind its asset URLs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  bomDataSchema, checkReportSchema, geometryDataSchema, netlistDataSchema, partsDataSchema, validateBoards, validatePayload, validateSite,
} from './contract/schema.ts'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/contract/${name}`, import.meta.url), 'utf8'))
const boards = () => fixture('boards-kicad10.json') as Record<string, any>[]
const phase2 = () => fixture('board-phase2.json') as Record<string, any>

test('the KiCad 10 manifest of examples/boards is valid', () => {
  const b = boards()
  assert.deepEqual(b.map(x => x.name), ['Blinky', 'FourLayer', 'Hierarchy', 'Legacy7', 'Legacy8'])
  assert.deepEqual(validateBoards(b), [])
})

test('a board with every phase-2 field filled is valid', () => {
  assert.deepEqual(validateBoards([phase2()]), [])
})

test('the merged phase-2 export (Blinky, KiCad 10) and its payloads are valid', () => {
  const b = fixture('merged/board-Blinky.json')
  assert.deepEqual(validateBoards([b]), [])
  assert.ok(b.geometry && b.download.items.length && b.rev.git.subject !== undefined && b.stats.stackup)
  assert.ok(b.schematic.sheets.some((s: { symbolBox?: unknown }) => s.symbolBox))
  const payloads = [['bom', bomDataSchema], ['parts', partsDataSchema], ['netlist', netlistDataSchema],
    ['geometry', geometryDataSchema], ['drc', checkReportSchema], ['erc', checkReportSchema]] as const
  for (const [k, schema] of payloads) assert.deepEqual(validatePayload(schema, fixture(`merged/${k}-Blinky.json`), k), [], k)
  assert.equal(typeof fixture('merged/parts-Blinky.json').thickness, 'number')
  // closed: an unknown field in a payload is reported
  const parts = fixture('merged/parts-Blinky.json')
  parts.footprints[0].extra = 1
  assert.match(validatePayload(partsDataSchema, parts, 'parts').join(), /parts\.footprints\[0\]\.extra: unexpected field/)
})

test('the site payload is valid', () => {
  assert.deepEqual(validateSite(fixture('site.json')), [])
})

/** Applies a mutation to a copy of the first fixture board and returns the problems. */
function problemsAfter(mutate: (b: Record<string, any>) => void, base = boards()[0]!): string[] {
  const b = structuredClone(base)
  mutate(b)
  return validateBoards([b])
}

test('schema: missing, extra and mistyped fields are reported', () => {
  assert.match(problemsAfter(b => { delete b.bounds }).join('\n'), /boards\[0\]\.bounds: expected an object/)
  assert.match(problemsAfter(b => { b.surprise = 1 }).join('\n'), /boards\[0\]\.surprise: unexpected field/)
  assert.match(problemsAfter(b => { b.copperLayers = '2' }).join('\n'), /copperLayers: expected an integer/)
  assert.match(problemsAfter(b => { b.layers[0].kind = 'glue' }).join('\n'), /layers\[0\]\.kind: expected one of/)
  assert.match(problemsAfter(b => { b.layers[0].url = 'board-assets/x.svg' }).join('\n'), /layers\[0\]\.url: expected a URL/)
  assert.match(problemsAfter(b => { b.model.format = 'step' }).join('\n'), /model\.format/)
  assert.match(problemsAfter(b => { b.revision = 'xyz' }).join('\n'), /revision: expected 12 hex digits/)
  assert.match(problemsAfter(b => { b.kicad.backend = 'kicad-cli' }).join('\n'), /kicad\.backend/)
  assert.match(problemsAfter(b => { b.files.pcb = 'Blinky.brd' }).join('\n'), /files\.pcb/)
})

test('schema: features list every FeatureId with a valid status', () => {
  assert.match(problemsAfter(b => { delete b.features.stats }).join('\n'), /features\.stats: missing feature/)
  assert.match(problemsAfter(b => { b.features.teleport = { available: true } }).join('\n'), /features\.teleport: unknown feature/)
  assert.match(problemsAfter(b => { b.features.drc = { available: false } }).join('\n'), /features\.drc\.reason: expected a non-empty string/)
  assert.match(problemsAfter(b => { b.features.drc = { available: true, reason: 'x' } }).join('\n'), /features\.drc\.reason: unexpected field/)
  assert.match(problemsAfter(b => { b.features.drc = { available: 'yes' } }).join('\n'), /features\.drc\.available/)
})

test('schema: phase-2 fields are checked by shape', () => {
  const p = phase2()
  assert.match(problemsAfter(b => { b.schematic.sheets[0].parent = 3 }, p).join('\n'), /schematic\.sheets\[0\]\.parent/)
  assert.match(problemsAfter(b => { b.reports.drc.counts = { error: 1 } }, p).join('\n'), /reports\.drc\.counts\.warning/)
  assert.match(problemsAfter(b => { b.download.status = 'partial' }, p).join('\n'), /download\.status/)
  assert.match(problemsAfter(b => { b.rev.git.commit = 'main' }, p).join('\n'), /rev\.git\.commit/)
  assert.match(problemsAfter(b => { b.stats.holes = {} }, p).join('\n'), /stats\.holes\.plated/)
})

test('schema: the manifest is sorted by name without duplicates', () => {
  const b = boards()
  assert.match(validateBoards([b[1], b[0]]).join('\n'), /not sorted by name/)
  assert.match(validateBoards([b[0], b[0]]).join('\n'), /duplicate board names/)
})

test('schema: site payload problems are reported', () => {
  const site = fixture('site.json')
  assert.match(validateSite({ ...site, theme: { ...site.theme, appearance: 'neon' } }).join('\n'), /site\.theme\.appearance/)
  assert.match(validateSite({ ...site, generator: { name: 'vitepress', version: '1' } }).join('\n'), /site\.generator\.name/)
  const { kicad: _, ...noKicad } = site
  assert.match(validateSite(noKicad).join('\n'), /site\.kicad: expected a string/)
})
