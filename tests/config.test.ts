// Config resolution (packages/vite-plugin/src/config.ts): the site-level keys and the
// single-board choice. The per-feature keys have their tests next to the feature.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_TITLE, pickSingle, resolveConfig } from '../packages/vite-plugin/src/config.ts'

test('title is null until configured, single is automatic by default', () => {
  const c = resolveConfig({}, '/x')
  assert.equal(c.title, null)
  assert.equal(c.single, 'auto')
  assert.equal(resolveConfig({ single: false }, '/x').single, false)
  assert.equal(DEFAULT_TITLE, 'KiCad boards')
  assert.equal(resolveConfig({ title: 'Boards', single: true }, '/x').single, true)
  assert.equal(resolveConfig({ single: 'Blinky' }, '/x').single, 'Blinky')
})

test('pickSingle: off, auto, the only board, a named board', () => {
  assert.deepEqual(pickSingle(false, ['A', 'B']), { name: null, problem: null })
  assert.deepEqual(pickSingle(false, ['A']), { name: null, problem: null })
  assert.deepEqual(pickSingle('auto', ['A']), { name: 'A', problem: null })
  assert.deepEqual(pickSingle('auto', ['A', 'B']), { name: null, problem: null })
  assert.deepEqual(pickSingle('auto', []), { name: null, problem: null })
  assert.deepEqual(pickSingle(true, ['Blinky']), { name: 'Blinky', problem: null })
  assert.deepEqual(pickSingle('B', ['A', 'B']), { name: 'B', problem: null })
})

test('pickSingle: a doubtful choice names the boards', () => {
  const several = pickSingle(true, ['A', 'B'])
  assert.equal(several.name, 'A')
  assert.match(several.problem!, /exactly one board, found 2 \(A, B\)/)
  assert.match(several.problem!, /single: "A"/)
  const missing = pickSingle('C', ['A', 'B'])
  assert.equal(missing.name, 'C')
  assert.match(missing.problem!, /no board named "C" \(boards: A, B\)/)
  assert.deepEqual(pickSingle(true, []), { name: null, problem: 'single: no board found' })
  assert.match(pickSingle('C', []).problem!, /boards: none/)
})
