// The sample projects in examples/boards, read without KiCad: the file-format facts
// selection depends on (tests/contract/expectations.json), the schematic hierarchy
// (sheet files resolve relative to the sheet that places them, sub-directories
// included), and the footprint -> symbol paths cross-probing joins on.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { formatVersionOf, minKicadFor, parseSExpr, readBoard, type SExpr } from '@kiview/kicad'

const BOARDS = fileURLToPath(new URL('../examples/boards/', import.meta.url))
const expectations = JSON.parse(readFileSync(new URL('./contract/expectations.json', import.meta.url), 'utf8')) as {
  boards: Record<string, { formatVersion: number; minKicad: number; copperLayers: number; schFormatVersion: number; sheets: number }>
}

const isList = (e: SExpr): e is SExpr[] => Array.isArray(e)
const children = (e: SExpr[], name: string) => e.filter(isList).filter(c => c[0] === name)
const child = (e: SExpr[], name: string) => children(e, name)[0]
const prop = (e: SExpr[], key: string) => children(e, 'property').find(p => p[1] === key)?.[2] as string | undefined
const top = (file: string, kind: string) => {
  const root = parseSExpr(readFileSync(file, 'utf8')).find(e => isList(e) && e[0] === kind)
  assert.ok(root && isList(root), `${file} is not a ${kind}`)
  return root
}

interface Walk { pages: string[]; files: Set<string>; symbolPaths: Set<string>; formats: Set<number> }

/** Walks the hierarchy from the root sheet; paths exclude the root uuid, as in the board. */
function walk(file: string, prefix: string, w: Walk, depth = 0): void {
  assert.ok(depth < 10, 'sheet recursion')
  assert.ok(existsSync(file), `missing sheet file ${file}`)
  w.files.add(file)
  const text = readFileSync(file, 'utf8')
  w.formats.add(formatVersionOf(text) ?? 0)
  const sch = top(file, 'kicad_sch')
  for (const s of children(sch, 'symbol')) w.symbolPaths.add(`${prefix}/${child(s, 'uuid')![1]}`)
  for (const sh of children(sch, 'sheet')) {
    const uuid = child(sh, 'uuid')![1] as string
    w.pages.push(`${prefix}/${uuid}`)
    walk(join(dirname(file), prop(sh, 'Sheetfile')!), `${prefix}/${uuid}`, w, depth + 1)
  }
}

for (const [name, exp] of Object.entries(expectations.boards)) {
  test(`sample ${name}`, () => {
    const pcbFile = join(BOARDS, name, `${name}.kicad_pcb`)
    const text = readFileSync(pcbFile, 'utf8')
    const info = readBoard(text)
    assert.equal(info.formatVersion, exp.formatVersion)
    assert.equal(info.minKicad, exp.minKicad)
    assert.equal(info.stackup.copperLayers, exp.copperLayers)
    assert.ok(info.outline && info.outline.width > 0 && info.outline.height > 0, 'has an Edge.Cuts outline')
    assert.equal(info.layers.filter(l => /\.Cu$/.test(l.name)).length, exp.copperLayers)

    const w: Walk = { pages: ['/'], files: new Set(), symbolPaths: new Set(), formats: new Set() }
    walk(join(BOARDS, name, `${name}.kicad_sch`), '', w)
    assert.equal(w.pages.length, exp.sheets, `sheet instances: ${w.pages.join(' ')}`)
    // every file of a project is in the same format
    assert.deepEqual([...w.formats], [exp.schFormatVersion])
    assert.equal(minKicadFor(exp.schFormatVersion, 'sch'), exp.minKicad)

    // every footprint with a symbol links to a symbol instance of the hierarchy
    const pcb = top(pcbFile, 'kicad_pcb')
    const paths = children(pcb, 'footprint').map(fp => child(fp, 'path')?.[1] as string | undefined).filter((p): p is string => !!p)
    assert.ok(paths.length > 0)
    for (const p of paths) assert.ok(w.symbolPaths.has(p), `footprint path ${p} has no symbol`)
  })
}

test('the generated samples cover KiCad 7, 8 and 9 file formats, 4 layers and sub-directory sheets', () => {
  const b = expectations.boards
  assert.deepEqual(new Set(Object.values(b).map(x => x.minKicad)), new Set([7, 8, 9, 10]))
  assert.ok(Object.values(b).some(x => x.copperLayers === 4))
  assert.ok(existsSync(join(BOARDS, 'Hierarchy/channels/channel.kicad_sch')))
  assert.ok(existsSync(join(BOARDS, 'Hierarchy/channels/led.kicad_sch')))
})
