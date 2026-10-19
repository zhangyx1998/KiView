// Finding and loading kiview.config.{ts,mts,js,mjs}. TypeScript is compiled
// through Vite's config loader, so the file may import anything.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { resolveConfig, type ResolvedConfig, type UserConfig } from '@kiview/vite-plugin/config'
import { loadConfigFromFile } from 'vite'

export const CONFIG_FILES = ['kiview.config.ts', 'kiview.config.mts', 'kiview.config.js', 'kiview.config.mjs']

export interface LoadedConfig {
  /** The config file, or null when none was found (all defaults). */
  file: string | null
  user: UserConfig
  resolved: ResolvedConfig
  /** Files the config depends on (restart the dev server when they change). */
  dependencies: string[]
}

export async function loadConfig(root: string, opts: { file?: string; command: 'serve' | 'build'; overrides?: UserConfig } = { command: 'serve' }): Promise<LoadedConfig> {
  const file = opts.file ? resolve(root, opts.file) : CONFIG_FILES.map(f => resolve(root, f)).find(f => existsSync(f)) ?? null
  if (opts.file && (!file || !existsSync(file))) throw new Error(`config file not found: ${opts.file}`)
  let user: UserConfig = {}
  let dependencies: string[] = []
  if (file) {
    const r = await loadConfigFromFile({ command: opts.command, mode: opts.command === 'build' ? 'production' : 'development' }, file, root, 'silent')
    if (!r) throw new Error(`cannot load ${file}`)
    user = r.config as UserConfig
    dependencies = r.dependencies
  }
  const merged: UserConfig = { ...user, ...opts.overrides, server: { ...user.server, ...opts.overrides?.server } }
  return { file, user, resolved: resolveConfig(merged, root), dependencies }
}
