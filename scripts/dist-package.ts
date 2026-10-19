// The rollup plugin that turns dist/ into the published package root (rollup.config.ts):
// a generated package.json, the README and LICENSE, the client app sources and the
// pcbnew Python helper, and the bin launcher.
//
// Published layout (paths relative to dist/):
//
//   package.json, README.md, LICENSE
//   bin/kiview.js        the CLI launcher (imports ../lib/cli.js)
//   lib/*.js                    the Node packages bundled into one tree
//   index.d.ts                  the public types (defineConfig, UserConfig, ...)
//   client/                     packages/client as source: Vite builds it on the user's machine
//   python/kwv_pcbnew.py        run inside KiCad's Python (KiCad 5 / 6 backend)
//
// lib/ sits one level below the root on purpose: the sources find their files with
// new URL('../package.json' | '../python/...', import.meta.url), which resolves from
// packages/<pkg>/dist/ in the repository and from dist/lib/ in the package alike.

import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Plugin } from 'rollup'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const $ = (...p: string[]) => resolve(ROOT, ...p)
const readJson = (file: string) => JSON.parse(readFileSync($(file), 'utf8'))

/** The workspaces bundled into lib/; their own runtime dependencies are published. */
export const WORKSPACES = ['kicad', 'vite-plugin', 'client', 'cli']

/** Carried over verbatim from the root package.json (runtime metadata only). */
const KEEP = ['name', 'version', 'description', 'type', 'keywords', 'author', 'license',
              'homepage', 'bugs', 'repository', 'engines']

/** Files of packages/client the CLI serves as the Vite root (its package.json "files"). */
const CLIENT_FILES = ['index.html', 'src', 'public', 'tsconfig.json']

/**
 * Runtime dependencies of the bundle: the union of the workspaces' `dependencies`,
 * less the workspaces themselves (bundled). Two workspaces asking for different
 * versions of one package is a build error, not a silent pick.
 */
export function runtimeDependencies(): Record<string, string> {
  const deps: Record<string, string> = {}
  for (const w of WORKSPACES) {
    const pkg = readJson(`packages/${w}/package.json`)
    for (const [name, range] of Object.entries<string>(pkg.dependencies ?? {})) {
      if (name.startsWith('@kiview/')) continue
      if (deps[name] && deps[name] !== range)
        throw new Error(`dist-package: ${name} is ${deps[name]} in one workspace and ${range} in packages/${w}`)
      deps[name] = range
    }
  }
  return Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)))
}

/** The workspaces carry the root version: the version a release tags. */
function checkVersions(version: string) {
  for (const w of WORKSPACES) {
    const v = readJson(`packages/${w}/package.json`).version
    if (v !== version) throw new Error(`dist-package: packages/${w} is ${v}, the root package.json ${version}`)
  }
}

const BIN = `#!/usr/bin/env node
import { main } from '../lib/cli.js'

main(process.argv.slice(2)).catch(e => {
  console.error(e instanceof Error ? e.stack ?? e.message : e)
  process.exit(1)
})
`

export function distPackage(outDir = 'dist'): Plugin {
  return {
    name: 'dist-package',
    closeBundle() {
      const out = $(outDir)
      const pkg = readJson('package.json')
      checkVersions(pkg.version)

      const manifest: Record<string, unknown> = {}
      for (const k of KEEP) if (k in pkg) manifest[k] = pkg[k]
      Object.assign(manifest, {
        bin: { kiview: './bin/kiview.js' },
        exports: {
          '.': { types: './index.d.ts', default: './lib/index.js' },
          './package.json': './package.json',
        },
        types: './index.d.ts',
        dependencies: runtimeDependencies(),
        publishConfig: { access: 'public' },
      })
      writeFileSync(resolve(out, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')

      for (const f of ['README.md', 'LICENSE']) cpSync($(f), resolve(out, f))
      for (const f of CLIENT_FILES) cpSync($('packages/client', f), resolve(out, 'client', f), { recursive: true })
      cpSync($('packages/kicad/python'), resolve(out, 'python'), { recursive: true })

      mkdirSync(resolve(out, 'bin'), { recursive: true })
      writeFileSync(resolve(out, 'bin/kiview.js'), BIN)
      // a bin must run directly (npm link, npx) without npm's install-time chmod
      chmodSync(resolve(out, 'bin/kiview.js'), 0o755)
    },
  }
}
