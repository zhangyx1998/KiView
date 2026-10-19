// `npm run build:dist`: the publishable package in dist/ (scripts/dist-package.ts has the
// layout). Runs after `tsc -b` and bundles its output, packages/<pkg>/dist/*.js, so the
// published code is exactly what the tests ran; the workspaces are inlined, their
// runtime dependencies (vite, vue, three, ...) stay external and are installed with the
// package. Not minified: stack traces from a build are read by users.

import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nodeResolve } from '@rollup/plugin-node-resolve'
import { defineConfig, type Plugin } from 'rollup'
import { dts } from 'rollup-plugin-dts'

import { distPackage, runtimeDependencies } from './scripts/dist-package.ts'

const ROOT = dirname(fileURLToPath(import.meta.url))
const $ = (...p: string[]) => resolve(ROOT, ...p)

const deps = Object.keys(runtimeDependencies())
const external = (id: string) =>
  id.startsWith('node:') || builtinModules.includes(id) || deps.some(d => id === d || id.startsWith(d + '/'))

/** @kiview/<pkg>[/<entry>] to that workspace's declarations (rollup-plugin-dts does not read "exports"). */
const workspaceTypes: Plugin = {
  name: 'workspace-types',
  resolveId(id) {
    const m = /^@kiview\/([\w-]+)(?:\/([\w-]+))?$/.exec(id)
    return m ? $('packages', m[1]!, 'dist', `${m[2] ?? 'index'}.d.ts`) : null
  },
}

export default defineConfig([
  {
    input: { index: $('packages/cli/dist/index.js'), cli: $('packages/cli/dist/cli.js') },
    external,
    output: { dir: $('dist/lib'), format: 'esm', chunkFileNames: '[name]-[hash].js' },
    // board-file.js <-> footprints.js only reference each other inside functions
    onwarn(w, warn) { if (w.code !== 'CIRCULAR_DEPENDENCY') warn(w) },
    plugins: [nodeResolve({ preferBuiltins: true, exportConditions: ['node'] })],
  },
  {
    input: $('packages/cli/dist/index.d.ts'),
    external,
    output: { file: $('dist/index.d.ts'), format: 'esm' },
    // inline the workspaces' declarations (@kiview/* are not published)
    plugins: [workspaceTypes, dts({ respectExternal: true }), distPackage()],
  },
])
