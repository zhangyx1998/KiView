// Probing against help texts of every kicad-cli release line (tests/fixtures/help/<ver>/:
// 10.0.6 captured from the binary, 7.0.0 to 9.0.7 reconstructed from the KiCad sources,
// see each SOURCE file and tests/fixtures/help/tool.ts).
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  backendForCaps, capabilitiesFromHelp, helpText, parseHelp, parseVersion, readHelpTree, scriptResult, pythonHelp,
  svgToMillimetres, type HelpFacts,
} from '@kiview/kicad'

const dir = new URL('./fixtures/help/', import.meta.url)
const versions = readdirSync(dir).filter(d => /^\d+\.\d+\.\d+$/.test(d))

async function helpOf(ver: string): Promise<Record<string, HelpFacts>> {
  const read: string[] = []
  const help = await readHelpTree(async path => {
    read.push(path)
    const f = new URL(`${ver}/${path.replaceAll(' ', '_')}.txt`, dir)
    return existsSync(f) ? readFileSync(f, 'utf8') : null
  })
  // only paths whose parent lists them are read
  for (const p of read.filter(p => p.includes(' '))) {
    const parent = p.split(' ').slice(0, -1).join(' ')
    assert.ok(help[parent]?.subcommands.includes(p.split(' ').pop()!), `${ver}: ${p} read although ${parent} does not list it`)
  }
  return help
}

test('fixtures: one captured set and reconstructed 7.x / 8.x / 9.x sets', () => {
  assert.deepEqual(versions.map(v => v.split('.')[0]).filter((v, i, a) => a.indexOf(v) === i).sort(), ['10', '7', '8', '9'])
  for (const v of versions) {
    const source = readFileSync(new URL(`${v}/SOURCE`, dir), 'utf8')
    assert.match(source, v.startsWith('10.') ? /^captured/ : /^RECONSTRUCTED/, v)
    assert.equal(parseVersion(readFileSync(new URL(`${v}/VERSION`, dir), 'utf8'))?.raw, v)
  }
})

test('capabilities per release line', async () => {
  const caps = Object.fromEntries(await Promise.all(versions.map(async v => {
    const help = await helpOf(v)
    return [v, { help, c: capabilitiesFromHelp(help) }] as const
  })))

  // KiCad 7: one SVG per call, STEP only, no render / drc / erc / bom; --drill-shape-opt from 7.0.x
  const k7 = caps['7.0.0']!.c
  assert.equal(k7.ops.layerSvg, true)
  assert.equal(k7.layerSvg.multiFile, false)
  assert.equal(k7.layerSvg.drillShape, false)
  assert.equal(k7.layerSvg.pageSizeMode, true)
  assert.deepEqual(k7.model3d.formats, ['step'])
  assert.equal(k7.ops.thumbnail, false)
  assert.equal(k7.ops.drc, false)
  assert.equal(k7.ops.erc, false)
  assert.equal(k7.ops.bom, false)          // only python-bom
  assert.equal(k7.ops.fab, true)
  assert.equal(backendForCaps(k7), 'cli-7-8')
  assert.ok(!caps['7.0.0']!.help['pcb export svg']!.flags.includes('--define-var'))
  assert.equal(caps['7.0.11']!.c.layerSvg.drillShape, true)

  // KiCad 8: vrml / glb / step, vrml without --no-dnp, drc / erc / bom, still no render
  for (const v of ['8.0.0', '8.0.9']) {
    const { c, help } = caps[v]!
    assert.deepEqual(c.model3d.formats, ['vrml', 'glb', 'step'], v)
    assert.equal(c.model3d.noDnp, false, v)
    assert.ok(help['pcb export glb']!.flags.includes('--no-dnp'), v)
    assert.ok(help['pcb export vrml']!.flags.includes('--units'), v)
    assert.ok(help['pcb export svg']!.flags.includes('--define-var'), v)
    assert.equal(c.layerSvg.multiFile, false, v)
    assert.equal(c.ops.thumbnail, false, v)
    assert.equal(c.ops.drc && c.ops.erc && c.ops.bom && c.ops.netlist, true, v)
    assert.equal(backendForCaps(c), 'cli-7-8', v)
  }

  // KiCad 9 and 10: multi-file SVG, render, --no-dnp on vrml
  for (const v of ['9.0.0', '9.0.7', '10.0.6']) {
    const { c } = caps[v]!
    assert.equal(c.layerSvg.multiFile, true, v)
    assert.equal(c.ops.thumbnail, true, v)
    assert.equal(c.model3d.noDnp, true, v)
    assert.equal(backendForCaps(c), 'cli-modern', v)
  }
  assert.equal(caps['9.0.0']!.c.fab.ipcd356, false)
  assert.equal(caps['9.0.7']!.c.fab.ipcd356, true)
  assert.equal(caps['9.0.7']!.c.ops.stats, false)
  assert.equal(caps['10.0.6']!.c.ops.stats, true)
})

test('parseVersion copes with distro builds and noise', () => {
  assert.deepEqual(parseVersion('10.0.6\n'), { major: 10, minor: 0, patch: 6, raw: '10.0.6' })
  assert.equal(parseVersion('9.0.1-rc1')?.major, 9)
  assert.equal(parseVersion('(5.1.9)-1')?.major, 5)
  assert.equal(parseVersion('7.0.11-7.0.11~ubuntu22.04.1')?.minor, 0)
  assert.equal(parseVersion('(kicad-cli:42): Gtk-WARNING **: 12:34:56.789: cannot open display\n8.0.4\n')?.raw, '8.0.4')
  assert.equal(parseVersion('nonsense'), null)
})

test('parseHelp falls back to the {a,b} list of the Usage line', () => {
  assert.deepEqual(parseHelp('Usage: export [-h] {drill,dxf,svg}\n\nOptional arguments:\n  -h, --help  help\n').subcommands, ['drill', 'dxf', 'svg'])
})

test('helpText accepts help printed with a non-zero exit, rejects errors', () => {
  assert.ok(helpText({ code: 1, out: ['Usage: pcb [--help] {export}', ''] }))
  assert.equal(helpText({ code: 1, out: ['Unknown argument: render'] }), null)
})

test('pcbnew script results and capabilities', () => {
  assert.deepEqual(scriptResult({ code: 0, out: ['noise', '@@KWV {"ok":true}'] }), { ok: true })
  assert.throws(() => scriptResult({ code: 1, out: ['@@KWV {"error":"ValueError: x"}'] }), /ValueError: x/)
  assert.throws(() => scriptResult({ code: -11, out: ['assert failed'] }), /exit -11/)
  const c = capabilitiesFromHelp(pythonHelp({ version: '6.0.11', python: '3.9', svg: true, gerber: true, drill: true, pos: true, vrml: false }))
  assert.equal(c.ops.layerSvg, true)
  assert.equal(c.layerSvg.drillShape, true)
  assert.equal(c.ops.model3d, false)
  assert.equal(c.ops.fab, true)
  assert.equal(c.ops.thumbnail, false)
})

test('svgToMillimetres rescales KiCad 5 user units per top-level group', () => {
  const k5 = '<svg width="297mm" height="210mm" viewBox="0 0 116930 82680"><title>x</title>\n' +
    '<g style="fill:#000" transform="translate(0 0) scale(1 1)"><path d="M 0 0"/></g>\n<path d="M 1 1"/>\n</svg>'
  const out = svgToMillimetres(k5)
  const vb = /viewBox="([^"]+)"/.exec(out)![1]!.split(' ').map(Number)
  assert.ok(Math.abs(vb[2]! - 297) < 1e-3 && Math.abs(vb[3]! - 82680 * 297 / 116930) < 1e-3)
  assert.match(out, /<g style="fill:#000" transform="scale\(0\.00254\d*\) translate\(0 0\) scale\(1 1\)">/)
  assert.match(out, /<g transform="scale\(0\.00254\d*\)">\n<path d="M 1 1"\/>/)
  const mm = '<svg width="10mm" height="10mm" viewBox="0 0 10 10"><g></g></svg>'
  assert.equal(svgToMillimetres(mm), mm)
})
