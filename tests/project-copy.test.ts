// [P2-d] the checks' project copy: library tables name the source project dir, since
// KiCad sets KIPRJMOD to the copy's dir (no KiCad needed).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { checkExtras, projectCopy, projectTable } from '../packages/vite-plugin/src/stages/project-copy.ts'
import type { BoardSource, StageContext } from '../packages/vite-plugin/src/stages/types.ts'

const FP = `(fp_lib_table
  (version 7)
  (lib (name "Board")(type "KiCad")(uri "\${KIPRJMOD}/../lib/Board.pretty")(options "")(descr ""))
  (lib (name "Other")(type "KiCad")(uri "$(KIPRJMOD)/Other.pretty")(options "")(descr ""))
  (lib (name "Std")(type "KiCad")(uri "\${KICAD10_FOOTPRINT_DIR}/Resistor_SMD.pretty")(options "")(descr ""))
  (lib (name "Rel")(type "KiCad")(uri "local/Rel.pretty")(options "")(descr ""))
)
`

test('projectTable rewrites KIPRJMOD only', () => {
  const out = projectTable(FP, '/home/me/proj/pcb')
  assert.equal(out, FP.replace('${KIPRJMOD}', '/home/me/proj/pcb').replace('$(KIPRJMOD)', '/home/me/proj/pcb'))
  assert.ok(out.includes('"${KICAD10_FOOTPRINT_DIR}/Resistor_SMD.pretty"'))
  assert.ok(out.includes('"local/Rel.pretty"'))
  assert.equal(projectTable('(sym_lib_table (version 7))\n', '/x'), '(sym_lib_table (version 7))\n')
  assert.equal(projectTable('"${KIPRJMOD}/a"', 'C:\\Users\\me\\"q"'), '"C:/Users/me/\\"q\\"/a"')
})

test('projectCopy writes rewritten tables, other extras byte for byte; checkExtras hashes the copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kiview-pc-'))
  try {
    const src = join(root, 'src'), snap = join(root, 'snap'), work = join(root, 'work')
    for (const d of [src, snap, work]) mkdirSync(d)
    const dru = '(version 1)\n(rule "x" (condition "${KIPRJMOD}") (constraint clearance (min 0.2mm)))\n'
    const sym = '(sym_lib_table\n  (version 7)\n  (lib (name "S")(type "KiCad")(uri "sym/S.kicad_sym")(options "")(descr ""))\n)\n'
    writeFileSync(join(src, 'fp-lib-table'), FP)
    writeFileSync(join(src, 'sym-lib-table'), sym)
    writeFileSync(join(src, 'B.kicad_dru'), dru)
    writeFileSync(join(snap, 'B.kicad_pcb'), '(kicad_pcb)')
    const board: BoardSource = { name: 'B', dir: src, pcb: join(src, 'B.kicad_pcb'), sch: null, pro: null }
    const ctx = { src: board, workDir: work, snapshot: async () => ({ dir: snap, pcb: join(snap, 'B.kicad_pcb'), sch: null }) } as unknown as StageContext
    const p = await projectCopy(ctx)
    assert.equal(p.pcb, join(work, 'project', 'B.kicad_pcb'))
    assert.equal(readFileSync(join(p.dir, 'fp-lib-table'), 'utf8'), projectTable(FP, src))
    assert.ok(!readFileSync(join(p.dir, 'fp-lib-table'), 'utf8').includes('KIPRJMOD'))
    assert.equal(readFileSync(join(p.dir, 'sym-lib-table'), 'utf8'), sym)
    assert.equal(readFileSync(join(p.dir, 'B.kicad_dru'), 'utf8'), dru) // not a table: untouched
    const h1 = checkExtras(board)
    assert.deepEqual(Object.keys(h1).sort(), ['B.kicad_dru', 'fp-lib-table', 'sym-lib-table'])
    // the key follows the source dir for tables that use KIPRJMOD, not for those that do not
    const h2 = checkExtras({ ...board, dir: src + '/.' })
    assert.notEqual(h2['fp-lib-table'], h1['fp-lib-table'])
    assert.equal(h2['sym-lib-table'], h1['sym-lib-table'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
