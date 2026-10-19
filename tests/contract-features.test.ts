// Features consistency without KiCad: the feature table, the stages that provide
// features, featureBlocker(), and checkFeatures() (tests/contract/features.ts, also
// used by the CI export matrix) on fixtures and mutated fixtures.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { capabilitiesFromHelp, featureBlocker, FEATURES, type Capabilities, type FeatureId, type Operation } from '@kiview/kicad'
import type { Board } from '@kiview/vite-plugin/contract'

import { STAGES } from '../packages/vite-plugin/dist/stages/index.js'
import { checkFeatures, FEATURE_DATA, FEATURE_IDS, type FeatureContext } from './contract/features.ts'

const boards = JSON.parse(readFileSync(new URL('./fixtures/contract/boards-kicad10.json', import.meta.url), 'utf8')) as Board[]
const phase2 = JSON.parse(readFileSync(new URL('./fixtures/contract/board-phase2.json', import.meta.url), 'utf8')) as Board

/** Capabilities with exactly these operations on (detail flags from a KiCad 10-like probe). */
function caps(ops: Operation[]): Capabilities {
  const c = capabilitiesFromHelp({})
  for (const op of ops) c.ops[op] = true
  c.model3d.formats = ['vrml', 'glb']
  return c
}
/** What the cli-modern backend reports in phase 1 (IMPLEMENTED in cli-modern.ts). */
const phase1 = caps(['boardInfo', 'layerSvg', 'model3d', 'thumbnail'])
const allOps = caps(['boardInfo', 'layerSvg', 'model3d', 'thumbnail', 'schematicSvg', 'bom', 'netlist', 'fab', 'drc', 'erc', 'stats'])
const provided = new Set(STAGES.flatMap(s => s.provides as FeatureId[]))
const ctx = (c: Capabilities | null, extra: Partial<FeatureContext> = {}): FeatureContext => ({ caps: c, provided, ...extra })
const errors = (b: Board, c: FeatureContext) => checkFeatures(b, c).filter(f => f.level === 'error')

test('every feature has a requirement and a data field, and nothing else does', () => {
  assert.deepEqual(Object.keys(FEATURE_DATA).sort(), Object.keys(FEATURES).sort())
  assert.equal(FEATURE_IDS.length, 11)
  for (const id of FEATURE_IDS) assert.ok(FEATURES[id].requires.length > 0, `${id} requires no operation`)
})

test('stages provide known features, each feature at most once', () => {
  const seen = new Map<string, string>()
  for (const s of STAGES) {
    for (const f of s.provides) {
      assert.ok(f in FEATURES, `stage ${s.name} provides unknown feature ${f}`)
      assert.ok(!seen.has(f), `${f} is provided by both ${seen.get(f)} and ${s.name}`)
      seen.set(f, s.name)
    }
  }
  // phase 1 ships these; phase-2 stages add to the list
  for (const f of ['layers', 'model3d', 'thumbnail', 'fab'] as const) assert.ok(provided.has(f), `${f} has no stage`)
})

test('featureBlocker: install, operations and project files', () => {
  const files = { pcb: true, sch: true }
  for (const id of FEATURE_IDS) {
    assert.equal(featureBlocker(id, null, files), 'no usable KiCad install')
    assert.match(featureBlocker(id, capabilitiesFromHelp({}), files) ?? '', /the KiCad backend cannot do: /)
    assert.equal(featureBlocker(id, allOps, files), null, id)
  }
  assert.equal(featureBlocker('layers', phase1, files), null)
  assert.equal(featureBlocker('schematic', phase1, files), 'the KiCad backend cannot do: schematicSvg')
  assert.equal(featureBlocker('crossProbe', caps(['boardInfo']), files), 'the KiCad backend cannot do: bom')
  // files come before capabilities
  const noSch = { pcb: true, sch: false }
  for (const id of ['schematic', 'netlist', 'erc'] as const) assert.equal(featureBlocker(id, allOps, noSch), 'the project has no .kicad_sch file')
  for (const id of ['layers', 'bom', 'drc'] as const) assert.equal(featureBlocker(id, allOps, noSch), null)
})

test('the KiCad 10 fixture boards are consistent with the phase-1 capabilities', () => {
  for (const b of boards) {
    assert.deepEqual(checkFeatures(b, ctx(phase1)), [], b.name)
    assert.deepEqual(FEATURE_IDS.filter(f => b.features[f].available), ['layers', 'model3d', 'thumbnail'], b.name)
  }
})

test('the phase-2 fixture is consistent once every stage exists', () => {
  assert.deepEqual(errors(phase2, ctx(allOps, { provided: new Set(FEATURE_IDS) })), [])
  // ...and flagged while no stage provides those features
  const today = errors(phase2, ctx(allOps)).map(f => f.feature).sort()
  assert.deepEqual(today, FEATURE_IDS.filter(f => !provided.has(f)).sort())
})

function mutated(f: (b: Board) => void): Board {
  const b = structuredClone(boards[0]!)
  f(b)
  return b
}

test('rule 1: availability follows the data', () => {
  const noModel = mutated(b => { b.model = null })
  assert.match(errors(noModel, ctx(phase1)).map(f => f.message).join('\n'), /available, but its data is missing/)
  const hidden = mutated(b => { b.features.thumbnail = { available: false, reason: 'nope' } })
  assert.match(errors(hidden, ctx(phase1)).map(f => f.message).join('\n'), /its data is present/)
})

test('rule 2: features without a stage are unavailable with the blocker as reason', () => {
  // The rule is about features no registered stage provides. Every feature may have a
  // stage by now, so the fixture context drops the stage of the feature under test.
  const without = (f: FeatureId, extra: Partial<FeatureContext> = {}) =>
    ({ ...extra, provided: new Set([...provided].filter(p => p !== f)) })
  const claimed = mutated(b => { b.features.schematic = { available: true }; b.schematic = { sheets: [] } })
  assert.match(errors(claimed, { ...ctx(phase1), ...without('schematic') }).map(f => f.message).join('\n'), /no stage provides it/)
  const wrong = mutated(b => { b.features.drc = { available: false, reason: 'because' } })
  assert.match(errors(wrong, { ...ctx(phase1), ...without('drc') }).map(f => f.message).join('\n'), /expected the blocker "the KiCad backend cannot do: drc"/)
  // with the operation present but no stage yet, the reason is "not implemented yet"
  const withDrc = caps(['boardInfo', 'layerSvg', 'model3d', 'thumbnail', 'drc'])
  const pending = mutated(b => { b.features.drc = { available: false, reason: 'not implemented yet' } })
  assert.deepEqual(errors(pending, { ...ctx(withDrc), ...without('drc') }), [])
  assert.match(errors(boards[0]!, { ...ctx(withDrc), ...without('drc') }).map(f => f.message).join('\n'), /expected "not implemented yet"/)
})

test('rule 3: stage features follow the stage outcome', () => {
  // an export failure is an error; a stale result served after a failure is a note
  const failed = mutated(b => { b.model = null; b.features.model3d = { available: false, reason: 'export failed: boom' } })
  assert.match(errors(failed, ctx(phase1, { stages: { model3d: { skipped: null, error: 'boom' } } })).map(f => f.message).join('\n'), /export failed: boom/)
  const stale = checkFeatures(boards[0]!, ctx(phase1, { stages: { model3d: { skipped: null, error: 'boom' } } }))
  assert.deepEqual(stale.map(f => f.level), ['note'])
  // not exported although nothing blocks it
  const missing = mutated(b => { b.thumbnail = null; b.features.thumbnail = { available: false, reason: 'not exported yet' } })
  assert.match(errors(missing, ctx(phase1)).map(f => f.message).join('\n'), /not exported although nothing blocks it/)
  // a skip must carry the skip reason
  const skipped = mutated(b => { b.thumbnail = null; b.features.thumbnail = { available: false, reason: 'thumbnails are turned off' } })
  assert.deepEqual(errors(skipped, ctx(phase1, { stages: { thumbnail: { skipped: 'thumbnails are turned off', error: null } } })), [])
  assert.equal(errors(skipped, ctx(phase1, { stages: { thumbnail: { skipped: 'other', error: null } } })).length, 1)
  // a fallback that delivers a blocked feature (e.g. a copper-SVG thumbnail on KiCad 8) is a note
  const fallback = checkFeatures(boards[0]!, ctx(caps(['boardInfo', 'layerSvg', 'model3d'])))
  assert.deepEqual(fallback.map(f => `${f.level} ${f.feature}`), ['note thumbnail'])
})
