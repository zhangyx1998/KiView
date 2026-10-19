// Discovering KiCad installs, in priority order:
//
//   config      `kicad.cli` (when set, the only native install used: an explicit choice)
//   env         KICAD_CLI, and KICAD_CLI_<ver> (KICAD_CLI_8=/opt/kicad8/bin/kicad-cli)
//   macOS       /Applications and ~/Applications: KiCad/KiCad.app, "KiCad 9/KiCad.app",
//               "KiCad 8.app", "KiCad9.app", ... (any KiCad* folder or app bundle)
//   Linux       /usr/bin, /usr/local/bin, /opt/kicad, kicad-nightly, Flatpak
//               (org.kicad.KiCad, run through `flatpak run --command=kicad-cli`), Snap
//   Windows     %ProgramFiles%\KiCad\<ver>\bin\kicad-cli.exe (and Program Files (x86),
//               %LOCALAPPDATA%\Programs\KiCad\<ver> for per-user installs)
//   PATH        kicad-cli on PATH
//   docker      kicad/kicad:<ver> images (only with kicad.docker.enabled; see docker.ts)
//
// Each native install carries its bundled Python (for the pcbnew-python backend) and
// stock 3D model library when they can be found.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import type { KicadInstall, KicadOptions } from './types.ts'

/** The environment discovery reads; injectable for tests. */
export interface DiscoveryEnv {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists(path: string): boolean
  readdir(dir: string): Promise<string[]>
  realpath(path: string): Promise<string | null>
  /** Where launcher scripts (Flatpak) are written. */
  launcherDir: string
}

export const nodeDiscoveryEnv = (launcherDir?: string): DiscoveryEnv => ({
  platform: process.platform,
  env: process.env,
  exists: existsSync,
  readdir: d => readdir(d).catch(() => [] as string[]),
  realpath: p => realpath(p).catch(() => null),
  launcherDir: launcherDir ?? join(tmpdir(), 'kiview-launchers'),
})

/** macOS bundle layout: <app>/Contents/{MacOS/kicad-cli, SharedSupport/3dmodels, Frameworks/Python.framework}. */
function fromBundle(e: DiscoveryEnv, app: string, source: KicadInstall['source'], hint?: string): KicadInstall | null {
  const cli = join(app, 'Contents/MacOS/kicad-cli')
  const py = join(app, 'Contents/Frameworks/Python.framework/Versions/Current/bin/python3')
  const hasCli = e.exists(cli)
  if (!hasCli && !e.exists(py)) return null
  // KiCad 5 / 6 bundles have no kicad-cli: the pcbnew-python backend drives them
  const install: KicadInstall = hasCli
    ? { id: `cli:${cli}`, kind: 'native', source, cli }
    : { id: `py:${py}`, kind: 'native', source }
  const models = join(app, 'Contents/SharedSupport/3dmodels')
  if (e.exists(models)) install.modelDir = models
  if (e.exists(py)) install.python = py
  if (hint) install.versionHint = hint
  return install
}

/** A kicad-cli path: find the model dir and python from the bundle or the distro / Windows layout. */
export function fromCli(e: DiscoveryEnv, cli: string, source: KicadInstall['source'], hint?: string): KicadInstall {
  const bundle = /^(.*\.app)\/Contents\/MacOS\/kicad-cli$/.exec(cli)?.[1]
  if (bundle) return fromBundle(e, bundle, source, hint) ?? { id: `cli:${cli}`, kind: 'native', source, cli }
  const install: KicadInstall = { id: `cli:${cli}`, kind: 'native', source, cli }
  const win = /\\bin\\kicad-cli\.exe$/i.test(cli)
  const sep = win ? '\\' : '/'
  const prefix = cli.split(/[\\/]/).slice(0, -2).join(sep)   // .../bin/kicad-cli -> ...
  for (const share of ['share/kicad/3dmodels', 'share/kicad-nightly/3dmodels']) {
    const p = [prefix, ...share.split('/')].join(sep)
    if (e.exists(p)) { install.modelDir = p; break }
  }
  if (!install.modelDir && !win && e.exists('/usr/share/kicad/3dmodels')) install.modelDir = '/usr/share/kicad/3dmodels'
  if (win) {
    const py = [prefix, 'bin', 'python.exe'].join(sep)
    if (e.exists(py)) install.python = py
  } else if (prefix === '/usr' || prefix === '/usr/local') {
    // distro packages install pcbnew for the system python3 [uncertain: not every distro]
    for (const py of ['/usr/bin/python3']) if (e.exists(py)) { install.python = py; break }
  }
  if (hint) install.versionHint = hint
  return install
}

function onPath(e: DiscoveryEnv, name: string): string | null {
  for (const dir of (e.env.PATH ?? e.env.Path ?? '').split(e.platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue
    const p = e.platform === 'win32' ? `${dir.replace(/\\$/, '')}\\${name}` : join(dir, name)
    if (e.exists(p)) return p
  }
  return null
}

const versionIn = (name: string) => /(\d+(?:\.\d+)?)/.exec(name)?.[1]

async function macInstalls(e: DiscoveryEnv, roots: string[]): Promise<KicadInstall[]> {
  const out: KicadInstall[] = []
  for (const root of roots) {
    for (const name of (await e.readdir(root)).sort()) {
      if (!/^kicad/i.test(name)) continue
      if (name.endsWith('.app')) {
        const i = fromBundle(e, join(root, name), 'macos-bundle', versionIn(name))
        if (i) out.push(i)
        continue
      }
      // a folder: KiCad/KiCad.app, "KiCad 9/KiCad.app", or a versioned bundle inside
      for (const app of (await e.readdir(join(root, name))).filter(a => /^kicad.*\.app$/i.test(a)).sort()) {
        const i = fromBundle(e, join(root, name, app), 'macos-bundle', versionIn(app) ?? versionIn(name))
        if (i) out.push(i)
      }
    }
  }
  return out
}

/** `flatpak run` launcher: a tiny script, rewritten when the installed commit changes. */
async function flatpakLauncher(e: DiscoveryEnv, appDir: string): Promise<KicadInstall | null> {
  const active = await e.realpath(join(appDir, 'current/active'))
  if (!active) return null
  const script = `#!/bin/sh\n# kiview launcher for ${active}\nexec flatpak run --command=kicad-cli org.kicad.KiCad "$@"\n`
  const file = join(e.launcherDir, `flatpak-kicad-cli-${createHash('sha256').update(active).digest('hex').slice(0, 12)}`)
  if ((await readFile(file, 'utf8').catch(() => '')) !== script) {
    await mkdir(e.launcherDir, { recursive: true })
    await writeFile(file, script)
    await chmod(file, 0o755)
  }
  // no modelDir: inside the sandbox KiCad's own KICAD<n>_3DMODEL_DIR defaults apply
  // (the library is a Flatpak extension) [uncertain: untested]
  return { id: `cli:${file}`, kind: 'native', source: 'linux', cli: file, versionHint: 'flatpak' }
}

async function linuxInstalls(e: DiscoveryEnv, searchPaths: string[]): Promise<KicadInstall[]> {
  const out: KicadInstall[] = []
  const clis = [
    ...searchPaths.map(p => join(p, 'kicad-cli')),
    '/usr/bin/kicad-cli', '/usr/local/bin/kicad-cli', '/opt/kicad/bin/kicad-cli',
    '/usr/lib/kicad-nightly/bin/kicad-cli', '/usr/bin/kicad-cli-nightly',
    // Snap: the kicad snap exposes kicad.kicad-cli [uncertain: app name]
    '/snap/bin/kicad.kicad-cli', '/snap/bin/kicad-cli',
  ]
  for (const cli of clis) if (e.exists(cli)) out.push(fromCli(e, cli, 'linux'))
  for (const root of ['/var/lib/flatpak/app/org.kicad.KiCad', join(e.env.HOME ?? '~', '.local/share/flatpak/app/org.kicad.KiCad')]) {
    if (!e.exists(root)) continue
    const i = await flatpakLauncher(e, root)
    if (i) out.push(i)
  }
  return out
}

async function windowsInstalls(e: DiscoveryEnv, searchPaths: string[]): Promise<KicadInstall[]> {
  const out: KicadInstall[] = []
  const roots = [
    ...searchPaths,
    e.env.ProgramFiles && `${e.env.ProgramFiles}\\KiCad`,
    e.env['ProgramFiles(x86)'] && `${e.env['ProgramFiles(x86)']}\\KiCad`,
    e.env.LOCALAPPDATA && `${e.env.LOCALAPPDATA}\\Programs\\KiCad`,
    'C:\\Program Files\\KiCad',
  ].filter((r): r is string => !!r)
  for (const root of [...new Set(roots)]) {
    // <root>\<ver>\bin\kicad-cli.exe (KiCad 7+); KiCad 5 / 6 used <root>\bin directly
    const versions = (await e.readdir(root)).filter(v => /^\d+(\.\d+)*$/.test(v))
      .sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a))
    for (const v of versions) {
      const cli = `${root}\\${v}\\bin\\kicad-cli.exe`
      const py = `${root}\\${v}\\bin\\python.exe`
      if (e.exists(cli)) out.push(fromCli(e, cli, 'windows', v))
      else if (e.exists(py)) out.push({ id: `py:${py}`, kind: 'native', source: 'windows', python: py, versionHint: v })
    }
    const legacy = `${root}\\bin\\python.exe`
    if (!versions.length && e.exists(legacy)) out.push({ id: `py:${legacy}`, kind: 'native', source: 'windows', python: legacy })
  }
  return out
}

/** All native installs found, in priority order, de-duplicated by real path. */
export async function discoverInstalls(o: Pick<KicadOptions, 'cli' | 'searchPaths'> = {},
                                       e: DiscoveryEnv = nodeDiscoveryEnv()): Promise<KicadInstall[]> {
  if (o.cli) return [fromCli(e, o.cli, 'config')]
  const found: KicadInstall[] = []
  const exe = e.platform === 'win32' ? 'kicad-cli.exe' : 'kicad-cli'
  if (e.env.KICAD_CLI) found.push(fromCli(e, e.env.KICAD_CLI, 'env'))
  for (const [k, v] of Object.entries(e.env).sort(([a], [b]) => a.localeCompare(b))) {
    const m = /^KICAD_CLI_(\d+(?:_\d+)?)$/.exec(k)
    if (m && v) found.push(fromCli(e, v, 'env-versioned', m[1]!.replace('_', '.')))
  }
  const searchPaths = o.searchPaths ?? []
  if (e.platform === 'darwin') found.push(...await macInstalls(e, [...searchPaths, '/Applications', join(e.env.HOME ?? '~', 'Applications')]))
  if (e.platform === 'linux') found.push(...await linuxInstalls(e, searchPaths))
  if (e.platform === 'win32') found.push(...await windowsInstalls(e, searchPaths))
  const path = onPath(e, exe)
  if (path) found.push(fromCli(e, path, 'path'))

  const seen = new Set<string>()
  const out: KicadInstall[] = []
  for (const i of found) {
    const target = i.cli ?? i.python!
    const real = await e.realpath(target)
    if (!real) continue
    if (seen.has(real)) continue
    seen.add(real)
    out.push(i)
  }
  return out
}

/** Docker installs for image names (configured versions and/or the local kicad/kicad tags). */
export function dockerInstalls(images: string[]): KicadInstall[] {
  return [...new Set(images)].map(image => ({
    id: `docker:${image}`, kind: 'docker' as const, source: 'docker' as const, image,
    cli: 'kicad-cli', modelDir: '/usr/share/kicad/3dmodels', versionHint: /:(\d+(?:\.\d+)*)/.exec(image)?.[1],
  }))
}

