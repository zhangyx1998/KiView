// Docker command construction (not runnable without docker) and the kicad-cli argument
// building of cli-ops for KiCad 7 / 8 help (recorded with a fake runner).
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  capabilitiesFromHelp, Cli78Backend, dockerCommand, dockerProbeScript, parseDockerProbe, readHelpTree, shQuote,
  splitMultiOutput, DockerBackend, type CliRunner, type ExecOptions, type HelpFacts, type ProbeResult,
} from '@kiview/kicad'

test('dockerCommand: mounts, path mapping into the container and back', () => {
  const cmd = dockerCommand({
    image: 'kicad/kicad:8.0',
    calls: [['pcb', 'export', 'vrml', '--units', 'mm', '-D', 'KIPRJMOD=/home/u/proj/Blinky', '-D', 'KICAD8_3DMODEL_DIR=/usr/share/kicad/3dmodels',
      '-o', '/cache/Blinky/model/.work/tmp/model.wrl', '/cache/Blinky/.snap-1/Blinky.kicad_pcb']],
    env: { KIPRJMOD: '/home/u/proj/Blinky', KICAD8_3DMODEL_DIR: '/usr/share/kicad/3dmodels' },
    read: ['/cache/Blinky/.snap-1/Blinky.kicad_pcb', '/home/u/proj/Blinky'],
    write: ['/cache/Blinky/model/.work/tmp'],
    user: '501:20',
    containerPaths: ['/usr/share/kicad/3dmodels'],
    windows: false,
  })
  assert.deepEqual(cmd.mounts, [
    { host: '/cache/Blinky/model/.work/tmp', container: '/kwv/w0', readonly: false },
    { host: '/home/u/proj/Blinky', container: '/kwv/r0', readonly: true },
    { host: '/cache/Blinky/.snap-1', container: '/kwv/r1', readonly: true },
  ])
  assert.deepEqual(cmd.args, [
    'run', '--rm', '--network', 'none', '--workdir', '/tmp', '-e', 'HOME=/tmp', '--user', '501:20',
    '--mount', 'type=bind,source=/cache/Blinky/model/.work/tmp,target=/kwv/w0',
    '--mount', 'type=bind,source=/home/u/proj/Blinky,target=/kwv/r0,readonly',
    '--mount', 'type=bind,source=/cache/Blinky/.snap-1,target=/kwv/r1,readonly',
    '-e', 'KIPRJMOD=/kwv/r0', '-e', 'KICAD8_3DMODEL_DIR=/usr/share/kicad/3dmodels',
    '--entrypoint', 'kicad-cli', 'kicad/kicad:8.0',
    'pcb', 'export', 'vrml', '--units', 'mm', '-D', 'KIPRJMOD=/kwv/r0', '-D', 'KICAD8_3DMODEL_DIR=/usr/share/kicad/3dmodels',
    '-o', '/kwv/w0/model.wrl', '/kwv/r1/Blinky.kicad_pcb',
  ])
  assert.equal(cmd.multi, false)
  assert.equal(cmd.toHost("Plotted to '/kwv/w0/model.wrl'."), "Plotted to '/cache/Blinky/model/.work/tmp/model.wrl'.")
  assert.equal(cmd.toHost('nothing here /kwv/w01'), 'nothing here /kwv/w01')
})

test('dockerCommand: a read path inside a written dir shares its mount; trailing slashes survive', () => {
  const cmd = dockerCommand({
    image: 'kicad/kicad:9.0', calls: [['pcb', 'export', 'svg', '--mode-multi', '-o', '/w/out/svg/', '/w/out/render.kicad_pcb']],
    env: {}, read: ['/w/out/render.kicad_pcb'], write: ['/w/out', '/w/out/svg'], user: null, windows: false,
  })
  assert.deepEqual(cmd.mounts, [{ host: '/w/out', container: '/kwv/w0', readonly: false }])
  assert.deepEqual(cmd.args.slice(-3), ['-o', '/kwv/w0/svg/', '/kwv/w0/render.kicad_pcb'])
  assert.ok(!cmd.args.includes('--user'))
})

test('dockerCommand: Windows host paths and CSV-quoted mount fields', () => {
  const cmd = dockerCommand({
    image: 'kicad/kicad:8.0', calls: [['pcb', 'export', 'svg', '--layers', 'F.Cu', '-o', 'C:\\Users\\me\\cache, x\\F_Cu.svg', 'D:\\boards\\A\\A.kicad_pcb']],
    env: {}, read: ['D:\\boards\\A\\A.kicad_pcb'], write: ['C:\\Users\\me\\cache, x'], user: null, windows: true,
  })
  assert.deepEqual(cmd.mounts.map(m => [m.host, m.container]), [['C:\\Users\\me\\cache, x', '/kwv/w0'], ['D:\\boards\\A', '/kwv/r0']])
  assert.ok(cmd.args.includes('type=bind,"source=C:\\Users\\me\\cache, x",target=/kwv/w0'))
  assert.deepEqual(cmd.args.slice(-2), ['/kwv/w0/F_Cu.svg', '/kwv/r0/A.kicad_pcb'])
  assert.equal(cmd.toHost("Plotted to '/kwv/w0/F_Cu.svg'"), "Plotted to 'C:\\Users\\me\\cache, x\\F_Cu.svg'")
})

test('dockerCommand: several calls run in one container through sh', () => {
  const cmd = dockerCommand({
    image: 'kicad/kicad:7.0', calls: [['pcb', 'export', 'svg', '--layers', 'F.Cu', '-o', '/o/F_Cu.svg', '/i/b.kicad_pcb'],
      ['pcb', 'export', 'svg', '--layers', "It's", '-o', '/o/x.svg', '/i/b.kicad_pcb']],
    env: {}, read: ['/i/b.kicad_pcb'], write: ['/o'], user: null, windows: false,
  })
  assert.equal(cmd.multi, true)
  assert.deepEqual(cmd.args.slice(-5), ['--entrypoint', 'sh', 'kicad/kicad:7.0', '-c',
    `kicad-cli pcb export svg --layers F.Cu -o /kwv/w0/F_Cu.svg /kwv/r0/b.kicad_pcb; echo "@@KWV-END 0 $?"; ` +
    `kicad-cli pcb export svg --layers 'It'\\''s' -o /kwv/w0/x.svg /kwv/r0/b.kicad_pcb; echo "@@KWV-END 1 $?"`])
  assert.equal(shQuote('a b'), `'a b'`)
  const split = splitMultiOutput(['one', '@@KWV-END 0 0', 'two', 'oops', '@@KWV-END 1 3'], 2, 0)
  assert.deepEqual(split, [{ code: 0, out: ['one'] }, { code: 3, out: ['two', 'oops'] }])
  assert.deepEqual(splitMultiOutput(['one'], 2, 137).map(r => r.code), [137, 137])
})

test('docker probe script and its output', async () => {
  const script = dockerProbeScript()
  assert.match(script, /^echo "@@KWV-VERSION"; kicad-cli version; echo "@@KWV-HELP pcb"; kicad-cli pcb --help 2>&1;/)
  const { version, help } = parseDockerProbe(['@@KWV-VERSION', '8.0.4', '@@KWV-HELP pcb', 'Usage: pcb [--help] {export}', '',
    'Subcommands:', '  export  Export', '@@KWV-HELP pcb render', 'Usage: pcb [--help] {export}'])
  assert.equal(version, '8.0.4')
  const tree = await readHelpTree(async p => help.get(p) ?? null)
  assert.deepEqual(Object.keys(tree), ['pcb'])     // `pcb render` is not listed by `pcb`
})

// ------------------------------------------------------------------ cli-ops arguments

const fixtures = new URL('./fixtures/help/', import.meta.url)
async function probeFor(ver: string, docker = false): Promise<ProbeResult> {
  const help: Record<string, HelpFacts> = await readHelpTree(async p => {
    const f = new URL(`${ver}/${p.replaceAll(' ', '_')}.txt`, fixtures)
    return existsSync(f) ? readFileSync(f, 'utf8') : null
  })
  const [major, minor, patch] = ver.split('.').map(Number) as [number, number, number]
  return {
    install: docker ? { id: `docker:kicad/kicad:${ver}`, kind: 'docker', source: 'docker', image: `kicad/kicad:${ver}`, cli: 'kicad-cli', modelDir: '/usr/share/kicad/3dmodels' }
      : { id: 'cli:/k/kicad-cli', kind: 'native', source: 'path', cli: '/k/kicad-cli', modelDir: '/k/3dmodels' },
    version: { major, minor, patch, raw: ver }, help, capabilities: capabilitiesFromHelp(help),
    backend: docker ? 'docker' : 'cli-7-8', error: null, ms: 0,
  }
}

/** Records calls and writes the output file named by -o, like kicad-cli would. */
class Recorder implements CliRunner {
  calls: string[][] = []
  opts: ExecOptions[] = []
  async exec(args: string[], o: ExecOptions) { return (await this.execMany([args], o))[0]! }
  async execMany(calls: string[][], o: ExecOptions) {
    this.calls.push(...calls)
    this.opts.push(o)
    return calls.map(c => {
      const out = c[c.indexOf('-o') + 1]!
      if (!out.endsWith('/')) writeFileSync(out, '<svg/>')
      return { code: 0, out: [] }
    })
  }
}

const board = join(tmpdir(), `kwv-test-${process.pid}`)
mkdirSync(board, { recursive: true })
writeFileSync(join(board, 'b.kicad_pcb'), readFileSync(new URL('../examples/boards/Blinky/Blinky.kicad_pcb', import.meta.url)))

test('cli-7-8 on KiCad 7.0.0: one call per layer, no -D, no --drill-shape-opt (warned)', async () => {
  const rec = new Recorder()
  const b = new Cli78Backend(await probeFor('7.0.0'), rec)
  const warnings: string[] = []
  const workDir = join(board, 'w7')
  const files = await b.exportLayerSvgs(join(board, 'b.kicad_pcb'), ['F.Cu', 'F.SilkS'], { holes: true },
    { workDir, vars: { KIPRJMOD: '/proj' }, warn: w => warnings.push(w) })
  assert.deepEqual(files.map(f => f.layer), ['F.Cu', 'F.SilkS'])
  assert.deepEqual(rec.calls[0], ['pcb', 'export', 'svg', '--layers', 'F.Cu', '--exclude-drawing-sheet', '--page-size-mode', '1',
    '-o', join(workDir, 'svg-holes', 'F_Cu.svg'), join(board, 'b.kicad_pcb')])
  assert.equal(rec.opts[0]!.env.KIPRJMOD, '/proj')              // KiCad 7 reads variables from the environment
  assert.equal(rec.opts[0]!.env.KICAD7_3DMODEL_DIR, '/k/3dmodels')
  assert.match(warnings[0]!, /no --drill-shape-opt/)
  assert.equal(b.capabilities.ops.model3d, true)                // step ...
  assert.equal(b.capabilities.model3d.formats.includes('vrml'), false)   // ... but no VRML: the model stage skips
  await assert.rejects(b.renderThumbnail('x', { width: 1, height: 1 }, { workDir, vars: {} }), /no pcb render/)
})

test('cli-7-8 on KiCad 8.0.9: -D, --drill-shape-opt, VRML in mm without --no-dnp', async () => {
  const rec = new Recorder()
  const b = new Cli78Backend(await probeFor('8.0.9'), rec)
  const workDir = join(board, 'w8')
  mkdirSync(workDir, { recursive: true })
  await b.exportLayerSvgs(join(board, 'b.kicad_pcb'), ['B.Cu'], { holes: false }, { workDir, vars: {} })
  assert.deepEqual(rec.calls[0]!.slice(0, 11), ['pcb', 'export', 'svg', '--layers', 'B.Cu', '--exclude-drawing-sheet',
    '--page-size-mode', '1', '--drill-shape-opt', '0', '-D'])
  const warnings: string[] = []
  await b.export3d(join(board, 'b.kicad_pcb'), { format: 'vrml', noDnp: true }, { workDir, vars: {}, warn: w => warnings.push(w) })
  const vrml = rec.calls[1]!
  assert.deepEqual(vrml.slice(0, 6), ['pcb', 'export', 'vrml', '--units', 'mm', '--force'])
  assert.ok(!vrml.includes('--no-dnp'))
  assert.match(warnings.join(), /no --no-dnp/)
  await b.export3d(join(board, 'b.kicad_pcb'), { format: 'glb', noDnp: true }, { workDir, vars: {} })
  assert.deepEqual(rec.calls[2]!.slice(0, 7), ['pcb', 'export', 'glb', '--no-dnp', '--subst-models', '--include-tracks', '--include-zones'])
})

test('docker backend on a 9.0 image: one --mode-multi call, image model dir not mounted', async () => {
  const rec = new Recorder()
  const p = await probeFor('9.0.7', true)
  const b = new DockerBackend(p, rec)
  assert.equal(b.capabilities.ops.thumbnail, true)
  const workDir = join(board, 'w9')
  await assert.rejects(b.exportLayerSvgs(join(board, 'b.kicad_pcb'), ['F.Cu'], { holes: true }, { workDir, vars: { KIPRJMOD: board } }),
    /svg export failed/)   // the recorder prints no "Plotted to" lines
  const c = rec.calls[0]!
  assert.ok(c.includes('--mode-multi') && c.includes(`KICAD9_3DMODEL_DIR=/usr/share/kicad/3dmodels`))
  assert.ok(rec.opts[0]!.read.includes(board) && !rec.opts[0]!.read.includes('/usr/share/kicad/3dmodels'))
  assert.ok(readdirSync(workDir).includes('svg-holes'))
})

test('cli-7-8 / docker: schematic, netlist, BOM, DRC / ERC and stats follow the probed help', async () => {
  const k7 = new Cli78Backend(await probeFor('7.0.11'), new Recorder())
  const k8 = new Cli78Backend(await probeFor('8.0.9'), new Recorder())
  const d9 = new DockerBackend(await probeFor('9.0.7', true), new Recorder())
  const on = (b: { capabilities: { ops: Record<string, boolean> } }) =>
    ['schematicSvg', 'netlist', 'bom', 'drc', 'erc', 'stats'].filter(op => b.capabilities.ops[op])
  assert.deepEqual(on(k7), ['schematicSvg', 'netlist', 'bom'])   // KiCad 7: no pcb drc / sch erc
  assert.deepEqual(on(k8), ['schematicSvg', 'netlist', 'bom', 'drc', 'erc'])
  assert.deepEqual(on(d9), ['schematicSvg', 'netlist', 'bom', 'drc', 'erc'])   // pcb export stats is 10+

  const rec = new Recorder()
  const b = new Cli78Backend(await probeFor('8.0.9'), rec)
  const workDir = join(board, 'w8c')
  await assert.rejects(b.drc(join(board, 'b.kicad_pcb'), {}, { workDir, vars: {} }))   // the recorder writes no JSON report
  assert.deepEqual(rec.calls[0]!.slice(0, 7), ['pcb', 'drc', '--format', 'json', '--units', 'mm', '--severity-all'])
  await assert.rejects(k7.erc(join(board, 'b.kicad_sch'), { workDir, vars: {} }), /has no sch erc/)
  // stats without pcb export stats: the file's numbers, no kicad-cli call
  const s = await b.stats(join(board, 'b.kicad_pcb'), { workDir, vars: {} })
  assert.equal(s.copperLayers, 2)
  assert.equal(rec.calls.length, 1)
})
