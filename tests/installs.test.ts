// Install discovery against fake file systems (macOS bundles, Windows, Linux, env vars).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { discoverInstalls, dockerImages, dockerInstalls, type DiscoveryEnv } from '@kiview/kicad'

function fakeEnv(platform: NodeJS.Platform, files: string[], env: NodeJS.ProcessEnv = {}): DiscoveryEnv {
  const set = new Set(files)
  const dirs = new Map<string, Set<string>>()
  for (const f of files) {
    const sep = platform === 'win32' ? '\\' : '/'
    const parts = f.split(sep)
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join(sep) || sep
      if (!dirs.has(dir)) dirs.set(dir, new Set())
      dirs.get(dir)!.add(parts[i]!)
      set.add(parts.slice(0, i + 1).join(sep))
    }
  }
  return {
    platform, env: { HOME: '/Users/me', ...env },
    exists: p => set.has(p),
    readdir: async d => [...(dirs.get(d) ?? [])],
    realpath: async p => (set.has(p) ? p : null),
    launcherDir: '/tmp/launchers',
  }
}

const mac = (app: string, o: { cli?: boolean; py?: boolean; models?: boolean } = {}) => [
  ...(o.cli !== false ? [`${app}/Contents/MacOS/kicad-cli`] : []),
  ...(o.py !== false ? [`${app}/Contents/Frameworks/Python.framework/Versions/Current/bin/python3`] : []),
  ...(o.models !== false ? [`${app}/Contents/SharedSupport/3dmodels/x.wrl`] : []),
]

test('macOS: KiCad/KiCad.app, versioned folders and bundles, python-only KiCad 6', async () => {
  const e = fakeEnv('darwin', [
    ...mac('/Applications/KiCad/KiCad.app'),
    ...mac('/Applications/KiCad 9/KiCad.app'),
    ...mac('/Applications/KiCad 8.app'),
    ...mac('/Users/me/Applications/KiCad6/KiCad.app', { cli: false }),
    '/Applications/Other.app/Contents/MacOS/x',
  ])
  const found = await discoverInstalls({}, e)
  assert.deepEqual(found.map(i => [i.cli ?? i.python, i.versionHint ?? null]), [
    ['/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli', null],
    ['/Applications/KiCad 8.app/Contents/MacOS/kicad-cli', '8'],
    ['/Applications/KiCad 9/KiCad.app/Contents/MacOS/kicad-cli', '9'],
    ['/Users/me/Applications/KiCad6/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3', '6'],
  ])
  assert.equal(found[0]!.modelDir, '/Applications/KiCad/KiCad.app/Contents/SharedSupport/3dmodels')
  assert.equal(found[0]!.python, '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3')
  assert.equal(found[3]!.id.startsWith('py:'), true)
})

test('kicad.cli is the only native install when set; env vars come first otherwise', async () => {
  const e = fakeEnv('darwin', [...mac('/Applications/KiCad/KiCad.app'), '/opt/k8/bin/kicad-cli', '/opt/k9/bin/kicad-cli'],
    { KICAD_CLI_8: '/opt/k8/bin/kicad-cli', KICAD_CLI_9_0: '/opt/k9/bin/kicad-cli' })
  const explicit = await discoverInstalls({ cli: '/opt/k9/bin/kicad-cli' }, e)
  assert.deepEqual(explicit.map(i => [i.cli, i.source]), [['/opt/k9/bin/kicad-cli', 'config']])
  const all = await discoverInstalls({}, e)
  assert.deepEqual(all.map(i => [i.cli, i.source, i.versionHint ?? null]), [
    ['/opt/k8/bin/kicad-cli', 'env-versioned', '8'],
    ['/opt/k9/bin/kicad-cli', 'env-versioned', '9.0'],
    ['/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli', 'macos-bundle', null],
  ])
})

test('Windows: Program Files\\KiCad\\<ver>\\bin, per-user installs, KiCad 6 python only', async () => {
  const e = fakeEnv('win32', [
    'C:\\Program Files\\KiCad\\9.0\\bin\\kicad-cli.exe',
    'C:\\Program Files\\KiCad\\9.0\\bin\\python.exe',
    'C:\\Program Files\\KiCad\\9.0\\share\\kicad\\3dmodels\\x.wrl',
    'C:\\Program Files\\KiCad\\8.0\\bin\\kicad-cli.exe',
    'C:\\Program Files\\KiCad\\6.0\\bin\\python.exe',
    'C:\\Users\\me\\AppData\\Local\\Programs\\KiCad\\10.0\\bin\\kicad-cli.exe',
  ], { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })
  const found = await discoverInstalls({}, e)
  assert.deepEqual(found.map(i => [i.cli ?? i.python, i.versionHint]), [
    ['C:\\Program Files\\KiCad\\9.0\\bin\\kicad-cli.exe', '9.0'],
    ['C:\\Program Files\\KiCad\\8.0\\bin\\kicad-cli.exe', '8.0'],
    ['C:\\Program Files\\KiCad\\6.0\\bin\\python.exe', '6.0'],
    ['C:\\Users\\me\\AppData\\Local\\Programs\\KiCad\\10.0\\bin\\kicad-cli.exe', '10.0'],
  ])
  assert.equal(found[0]!.modelDir, 'C:\\Program Files\\KiCad\\9.0\\share\\kicad\\3dmodels')
  assert.equal(found[0]!.python, 'C:\\Program Files\\KiCad\\9.0\\bin\\python.exe')
  assert.equal(found[0]!.source, 'windows')
})

test('Linux: distro, nightly and snap paths; PATH duplicates removed', async () => {
  const e = fakeEnv('linux', ['/usr/bin/kicad-cli', '/usr/bin/python3', '/usr/share/kicad/3dmodels/x.wrl',
    '/usr/lib/kicad-nightly/bin/kicad-cli', '/snap/bin/kicad.kicad-cli'], { PATH: '/usr/local/bin:/usr/bin' })
  const found = await discoverInstalls({}, e)
  assert.deepEqual(found.map(i => i.cli), ['/usr/bin/kicad-cli', '/usr/lib/kicad-nightly/bin/kicad-cli', '/snap/bin/kicad.kicad-cli'])
  assert.equal(found[0]!.modelDir, '/usr/share/kicad/3dmodels')
  assert.equal(found[0]!.python, '/usr/bin/python3')
})

test('docker installs from the image template', () => {
  const images = dockerImages('kicad/kicad:{version}', ['8.0', '9.0'])
  assert.deepEqual(images, ['kicad/kicad:8.0', 'kicad/kicad:9.0'])
  const [i] = dockerInstalls(images)
  assert.deepEqual(i, { id: 'docker:kicad/kicad:8.0', kind: 'docker', source: 'docker', image: 'kicad/kicad:8.0',
    cli: 'kicad-cli', modelDir: '/usr/share/kicad/3dmodels', versionHint: '8.0' })
})
