// The Vite side: the client app (shipped in @kiview/client) is the Vite root,
// the user's project folder is only read by the plugin. Like vitepress, nothing
// Vite-related is required in the user's folder.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import kiview from '@kiview/vite-plugin'
import type { ResolvedConfig } from '@kiview/vite-plugin/config'
import vue from '@vitejs/plugin-vue'
import { build as viteBuild, createServer, preview as vitePreview, type InlineConfig } from 'vite'

export interface CliOverrides {
  open?: boolean
  logLevel?: 'info' | 'warn' | 'error' | 'silent'
}

/** The client app: client/ beside lib/ in the published package (scripts/dist-package.ts), else the workspace. */
export function clientDir(): string {
  const bundled = fileURLToPath(new URL('../client', import.meta.url))
  if (existsSync(join(bundled, 'index.html'))) return bundled
  return dirname(fileURLToPath(import.meta.resolve('@kiview/client/package.json')))
}

export function createViteConfig(config: ResolvedConfig, o: CliOverrides = {}): InlineConfig {
  const root = clientDir()
  const server = {
    host: config.server.host,
    port: config.server.port,
    strictPort: config.server.strictPort,
    // any Host header: previews sit behind tunnels and proxies; a list narrows it
    allowedHosts: config.server.allowedHosts ?? true,
    open: o.open,
  }
  return {
    configFile: false,
    root,
    base: config.base,
    cacheDir: join(config.cacheDir, '.vite'),
    logLevel: o.logLevel,
    plugins: [vue(), kiview({ resolved: config })],
    server: {
      ...server,
      fs: { allow: [root, config.cacheDir, config.root] },
      watch: { ignored: [`${config.cacheDir}/**`, `${config.outDir}/**`, '**/node_modules/**', '**/.git/**'] },
    },
    preview: { host: server.host, port: server.port, strictPort: server.strictPort, allowedHosts: server.allowedHosts, open: o.open },
    // the client may live in node_modules, where Vite's dependency scan does not look
    optimizeDeps: { include: ['vue', 'vue-router', 'three'] },
    build: {
      outDir: config.outDir, emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 800,
      // the boards module waits for the KiCad exports, which the timing check would report as slow plugin code
      rolldownOptions: { checks: { bundlerTimings: false } },
    },
  }
}

export async function dev(config: ResolvedConfig, o: CliOverrides = {}): Promise<void> {
  const server = await createServer(createViteConfig(config, o))
  await server.listen()
  server.printUrls()
  server.bindCLIShortcuts({ print: true })
}

export async function build(config: ResolvedConfig, o: CliOverrides = {}): Promise<void> {
  await viteBuild(createViteConfig(config, o))
}

export async function preview(config: ResolvedConfig, o: CliOverrides = {}): Promise<void> {
  const server = await vitePreview(createViteConfig(config, o))
  server.printUrls()
  server.bindCLIShortcuts({ print: true })
}
