// kiview: the public API. `kiview.config.ts` does
//   import { defineConfig } from '@zdv/kiview'
//   export default defineConfig({ title: 'My boards', boards: ['hardware'] })

export { defineConfig, resolveConfig } from '@kiview/vite-plugin/config'
export type * from '@kiview/vite-plugin/config'
export { loadConfig, CONFIG_FILES, type LoadedConfig } from './load-config.ts'
export { createViteConfig, dev, build, preview, type CliOverrides } from './vite.ts'
