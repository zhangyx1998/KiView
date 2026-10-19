// [P2-d] deep links: the board page's query parameters survive a format / parse round trip.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatViewLink, otherParams, parseViewLink, type ViewLink } from '../packages/client/src/deepLink.ts'

const roundTrip = (l: ViewLink) => parseViewLink(formatViewLink(l))

test('deep link round trip', () => {
  const full: ViewLink = {
    pane: 'split', layers: ['F.Cu', 'In1.Cu', 'Edge.Cuts'], side: 'back',
    view: { x: 120.5, y: -1.7, z: 5.455 },
    cam: [-0.423, 0.732, 1.207, 0.6149, -0.00721, -0.00924, 0.78852, 38.572, 30],
    net: '/LED driver/LED_A', at: { x: 97.58, y: -22.38 }, tab: 'schematic',
  }
  assert.deepEqual(roundTrip(full), full)
  assert.deepEqual(roundTrip({ pane: 'layers', preset: 'copper' }), { pane: 'layers', preset: 'copper' })
  assert.deepEqual(roundTrip({}), {})
  assert.deepEqual(roundTrip({ layers: [] }), { layers: [] })
})

test('deep link pane list', () => {
  assert.deepEqual(roundTrip({ pane: '3d,layers,bom' }), { pane: '3d,layers,bom' })
  assert.deepEqual(parseViewLink({ pane: 'bom,' }), {})
  assert.deepEqual(parseViewLink({ pane: '3d,<b>' }), {})
})

test('deep link through a real URL (encoding)', () => {
  const l: ViewLink = { pane: '3d', net: 'Net-(D1-A) & +5V', layers: ['F.Cu', 'User.1'], view: { x: 0, y: 0, z: 1 } }
  const url = new URL('http://x/board/B?' + new URLSearchParams(formatViewLink(l)) + '#part=R12')
  assert.equal(url.hash, '#part=R12')
  assert.deepEqual(parseViewLink(Object.fromEntries(url.searchParams)), l)
})

test('deep link formatting is compact and stable', () => {
  assert.deepEqual(formatViewLink({ view: { x: 1.23456, y: -0.0001, z: 2 }, at: { x: 3, y: 4 } }), { view: '1.235,0,2', at: '3,4' })
  assert.deepEqual(Object.keys(formatViewLink({ at: { x: 0, y: 0 }, pane: 'x', side: 'back' })), ['pane', 'side', 'at'])
  // a preset wins over an explicit layer list
  assert.deepEqual(formatViewLink({ preset: 'front', layers: ['F.Cu'] }), { preset: 'front' })
})

test('malformed deep link parameters are ignored', () => {
  assert.deepEqual(parseViewLink({ view: '1,2', cam: '1,2,3', side: 'left', at: 'a,b', pane: '<script>' }), {})
  assert.deepEqual(parseViewLink({ view: '1,2,0' }), {})
  assert.deepEqual(parseViewLink({ tab: 'bom&x' }), {})
  assert.deepEqual(parseViewLink({ side: ['back', 'front'] }), { side: 'back' })
})

test('other query parameters are kept apart', () => {
  assert.deepEqual(otherParams({ pane: '3d', foo: 'bar', net: 'GND' }), { foo: 'bar' })
})
