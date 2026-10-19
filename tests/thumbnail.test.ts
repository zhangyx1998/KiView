// The thumbnail fallback (layer composite) used when the backend cannot render.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  composeTopView, compositeColours, cssColour, finishColour, fitPixels,
} from '../packages/vite-plugin/src/stages/thumbnail-composite.ts'

test('stackup colours to CSS', () => {
  assert.equal(cssColour('Black', '#0f0'), '#141414')
  assert.equal(cssColour('#2B4E2FD4', '#0f0'), '#2B4E2F')
  assert.equal(cssColour('Unobtainium', '#0f0'), '#0f0')
  assert.equal(cssColour(null, '#0f0'), '#0f0')
  assert.equal(finishColour('ENIG'), '#d6b25e')
  assert.equal(finishColour('HAL lead-free'), '#c9c9c9')
  const c = compositeColours({ maskColor: { front: 'Green', back: null }, silkColor: { front: null, back: null }, finish: null, thickness: 1.6, copperLayers: 2 }, 'Black')
  assert.equal(c.substrate, '#141414')       // the configured override wins
  assert.equal(c.silk, '#f4f4f4')
})

test('fitPixels keeps the aspect ratio inside the box', () => {
  assert.deepEqual(fitPixels({ x: 0, y: 0, width: 32, height: 22 }, { width: 640, height: 400 }), { width: 582, height: 400 })
  assert.deepEqual(fitPixels({ x: 0, y: 0, width: 100, height: 10 }, { width: 640, height: 400 }), { width: 640, height: 64 })
})

test('composeTopView nests the layers on one viewBox, holes cut through the substrate', () => {
  const layer = (id: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="99 99 32 22" width="32mm" height="22mm" data-layer="${id}" style="color:var(--layer-color, #c83434)">\n<path d="M0 0"/>\n</svg>\n`
  const svg = composeTopView({
    vb: { x: 99, y: 99, width: 32, height: 22 }, outline: { x: 100, y: 100, width: 30, height: 20 },
    layers: { 'F.Cu': layer('F.Cu'), 'F.SilkS': layer('F.SilkS') }, holesMaskId: 'thumb-B-F_Cu',
    colours: { substrate: '#111111', copper: '#222222', pads: '#333333', silk: '#444444', edge: '#555555' },
    pixels: { width: 582, height: 400 },
  })
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"[^>]* viewBox="99 99 32 22" width="582" height="400">/)
  assert.match(svg, /<g mask="url\(#thumb-B-F_Cu\)"><rect x="100" y="100" width="30" height="20" rx="0.5" fill="#111111"\/><\/g>/)
  assert.match(svg, /<svg x="99" y="99" width="32" height="22" viewBox="99 99 32 22" style="color:#222222">/)
  assert.match(svg, /style="color:#444444"/)
  assert.ok(!/mm"/.test(svg), 'nested layers carry no mm sizes')
  assert.equal((svg.match(/<svg\b/g) ?? []).length, 3)
})
