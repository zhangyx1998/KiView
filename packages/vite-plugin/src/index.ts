// @kiview/vite-plugin: discovers KiCad projects, exports them through
// @kiview/kicad into a content-addressed cache (pipeline.ts, stages/), and
// exposes the result to the client as two virtual modules (contract.ts):
//   virtual:kiview/boards  -> { boards: Board[] }
//   virtual:kiview/site    -> { site: SiteData }
//
// Dev: assets are served from the cache under <base>board-assets/, project files
// are watched and re-exported on change; every board whose data changed is pushed
// as an HMR event carrying the new Board (the client's reactive store swaps it in
// and the views refetch only the assets whose content-hashed URL changed; the page
// reloads only when the site data changed). Build: the same files are emitted into
// <outDir>/board-assets/<Name>/<stage>/<key>/...

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, resolve, sep } from 'node:path'

import { openKicad } from '@kiview/kicad'
import type { Plugin, ResolvedConfig as ViteResolvedConfig, ViteDevServer } from 'vite'

import { DEFAULT_TITLE, pickSingle, resolveConfig, type ResolvedConfig, type UserConfig } from './config.ts'
import { BOARD_EVENT, BOARDS_MODULE, SITE_MODULE, STATUS_PATH, type BoardEvent, type SiteData } from './contract.ts'
import { isProjectFile } from './discover.ts'
import { ASSET_DIR, Pipeline, type Logger } from './pipeline.ts'

export { defineConfig, resolveConfig } from './config.ts'
export type * from './config.ts'
export type * from './contract.ts'
export { Pipeline, type Logger } from './pipeline.ts'
export type { Stage, StageContext, StageInput, StageOutput, StageRecord, BoardSource, Snapshot } from './stages/types.ts'

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const SITE_ASSETS = 'site-assets'

const CONTENT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.wrl': 'model/vrml',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.pdf': 'application/pdf',
}

export interface PluginOptions {
  /** A config already resolved (the CLI passes this). */
  resolved?: ResolvedConfig
  /** Or a user config, resolved against `root` (default: the Vite root). */
  config?: UserConfig
  root?: string
}

export default function kiview(options: PluginOptions = {}): Plugin {
  let vite: ViteResolvedConfig
  let config: ResolvedConfig
  let log: Logger
  let pipeline: Promise<Pipeline> | null = null
  let server: ViteDevServer | null = null
  let building = false

  const ids = { boards: '\0' + BOARDS_MODULE, site: '\0' + SITE_MODULE }

  function getPipeline(): Promise<Pipeline> {
    pipeline ??= (async () => {
      const kit = await openKicad(config.kicad)
      log.info(`KiCad: ${kit.describe()}`)
      const p = new Pipeline(config, kit, log)
      p.onLate = name => pushBoard(p, name)
      return p
    })()
    return pipeline
  }

  async function ready(): Promise<Pipeline> {
    const p = await getPipeline()
    await p.ensureReady(building)
    syncNotesFiles(p)   // [assembly]
    return p
  }

  /** The logo: URLs as they are, local files served / emitted under site-assets/. */
  function logo(): { url: string; file: string | null } | null {
    const l = config.logo
    if (!l) return null
    if (/^(https?:|data:|\/\/)/.test(l)) return { url: l, file: null }
    const file = isAbsolute(l) ? l : resolve(config.root, l)
    return { url: `${config.base}${SITE_ASSETS}/${basename(file)}`, file }
  }

  /** The board of a single-board site (config `single`), or null. A doubtful choice fails the build; dev warns. */
  function single(p: Pipeline): string | null {
    const { name, problem } = pickSingle(config.single, p.boards().map(b => b.name))
    if (problem && building) throw new Error(problem)
    if (problem) log.warn(problem)
    return name
  }

  /** The configured title, else the single board's, else the default. */
  function title(p: Pipeline, s = single(p)): string {
    if (config.title) return config.title
    return (s && p.board(s)?.title) || DEFAULT_TITLE
  }

  async function siteData(): Promise<SiteData> {
    const p = await ready()
    const s = single(p)
    return {
      title: title(p, s),
      description: config.description,
      logo: logo()?.url ?? null,
      theme: config.theme,
      single: s,
      generator: { name: 'kiview', version: VERSION },
      kicad: p.kit.describe(),
    }
  }

  // ---- dev: watching and pushing ------------------------------------------------

  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  let chain: Promise<unknown> = Promise.resolve()
  const ALL = '\0all'

  function schedule(name: string): void {
    clearTimeout(pending.get(name))
    pending.set(name, setTimeout(() => {
      pending.delete(name)
      // serialise refreshes; each re-discovers so added / removed boards are picked up
      chain = chain.then(async () => {
        const p = await ready()
        const before = await snapshot(p)
        if (name === ALL) await p.refreshAll()
        else {
          const src = (await p.discover()).find(s => s.name === name)
          if (src) await p.refresh(src)
          else p.entries.delete(name)
        }
        await publish(p, before)
      }).catch(e => log.error(String(e)))
    }, 300))
  }

  /** What the page holds: every board's data and the site data, as JSON, to tell what a refresh changed. */
  async function snapshot(p: Pipeline): Promise<{ boards: Map<string, string>; site: string }> {
    return { boards: new Map(p.boards().map(b => [b.name, JSON.stringify(b)])), site: JSON.stringify(await siteData()) }
  }

  /** Push the boards a refresh changed (added, updated, removed); reload only when the site data changed. */
  async function publish(p: Pipeline, before: Awaited<ReturnType<typeof snapshot>>): Promise<void> {
    const after = await snapshot(p)
    if (after.site !== before.site) { reload('site data changed'); return }
    const changed = [...new Set([...before.boards.keys(), ...after.boards.keys()])].filter(n => before.boards.get(n) !== after.boards.get(n))
    for (const n of changed) pushBoard(p, n)
    if (changed.length) log.info(`${changed.join(', ')}: updated in the page`)
    else invalidate()
  }

  function invalidate(): void {
    const graph = server?.environments?.client?.moduleGraph
    if (!graph) return
    for (const id of [ids.boards, ids.site]) {
      const mod = graph.getModuleById(id)
      if (mod) graph.invalidateModule(mod)
    }
  }

  function reload(why: string): void {
    if (!server) return
    invalidate()
    server.ws.send({ type: 'full-reload' })
    log.info(`${why}, page reloaded`)
  }

  function pushBoard(p: Pipeline, name: string): void {
    if (!server) return
    invalidate()
    const data: BoardEvent = { name, board: p.board(name) }
    server.ws.send({ type: 'custom', event: BOARD_EVENT, data })
  }

  /** Assembly notes file names of the boards (config assembly.notesFile), watched like project files. */
  let notesFiles: string[] = []
  const syncNotesFiles = (p: Pipeline) => {
    notesFiles = [...new Set([...p.entries.values()].map(e => config.assembly(e.src.name).notesFile).filter((f): f is string => !!f).map(f => basename(f)))]
  }

  function onFsEvent(kind: 'change' | 'add' | 'unlink' | 'dir', file: string): void {
    if (file.startsWith(config.cacheDir + sep) || file.startsWith(config.outDir + sep)) return
    if (kind === 'dir') { schedule(ALL); return }
    if (!isProjectFile(file, notesFiles)) return
    if (kind !== 'change' && file.endsWith('.kicad_pcb')) { schedule(ALL); return }
    void getPipeline().then(p => {
      for (const e of p.entries.values()) if (dirname(file) === e.src.dir || (file.startsWith(e.src.dir + sep) && file.endsWith('.kicad_sch'))) schedule(e.src.name)
    })
  }

  return {
    name: 'kiview',

    configResolved(c) {
      vite = c
      building = c.command === 'build'
      config = options.resolved ?? resolveConfig({ base: c.base, ...options.config }, options.root ?? c.root)
      const tag = '\x1b[36m[kiview]\x1b[0m'
      log = {
        info: m => vite.logger.info(`${tag} ${m}`, { timestamp: true }),
        warn: m => vite.logger.warn(`\x1b[33m[kiview]\x1b[0m ${m}`, { timestamp: true }),
        error: m => vite.logger.error(`\x1b[31m[kiview]\x1b[0m ${m}`, { timestamp: true }),
      }
    },

    resolveId(id) {
      if (id === BOARDS_MODULE) return ids.boards
      if (id === SITE_MODULE) return ids.site
      return undefined
    },

    async load(id) {
      if (id === ids.boards) return `export const boards = ${JSON.stringify((await ready()).boards())}\n`
      if (id === ids.site) return `export const site = ${JSON.stringify(await siteData())}\n`
      return undefined
    },

    // The built page carries the final title; in dev the pipeline may still be exporting,
    // so the page gets the configured one and the client sets document.title from the site data.
    async transformIndexHtml(html) {
      const esc = (s: string) => s.replace(/[&<>"]/g, ch => `&#${ch.charCodeAt(0)};`)
      const t = building ? title(await ready()) : config.title ?? DEFAULT_TITLE
      return html.replace(/<title>[^<]*<\/title>/, `<title>${esc(t)}</title>`)
    },

    configureServer(s) {
      server = s
      void ready()
      s.watcher.add(config.root)
      s.watcher
        .on('change', f => onFsEvent('change', f))
        .on('add', f => onFsEvent('add', f))
        .on('unlink', f => onFsEvent('unlink', f))
        .on('addDir', f => onFsEvent('dir', f))
        .on('unlinkDir', f => onFsEvent('dir', f))

      const assets = `${config.base}${ASSET_DIR}/`
      s.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!
        if (url === `${config.base}${STATUS_PATH}`) {
          const p = await ready()
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ kicad: p.kit.installs.map(i => ({ ...i, help: undefined })), boards: p.boards(), status: p.status() }, null, 2))
          return
        }
        const l = logo()
        if (l?.file && url === new URL(l.url, 'http://x').pathname) {
          try { res.setHeader('Content-Type', CONTENT_TYPES[extname(l.file)] ?? 'application/octet-stream'); res.end(await readFile(l.file)) }
          catch { res.statusCode = 404; res.end() }
          return
        }
        if (!url.startsWith(assets)) return next()
        // only what a stage record publishes is served (the path's id is the file's content hash)
        const file = (await getPipeline()).assetFile(decodeURIComponent(url.slice(assets.length)))
        if (!file) { res.statusCode = 404; res.end(); return }
        try {
          const body = await readFile(file)
          res.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream')
          res.setHeader('Content-Length', body.length)
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          if (extname(file) === '.zip') res.setHeader('Content-Disposition', `attachment; filename="${basename(file)}"`)
          res.end(body)
        } catch {
          res.statusCode = 404; res.end()
        }
      })
    },

    async generateBundle() {
      const p = await ready()
      for (const [fileName, path] of p.assetFiles()) this.emitFile({ type: 'asset', fileName, source: await readFile(path) })
      const l = logo()
      if (l?.file) this.emitFile({ type: 'asset', fileName: `${SITE_ASSETS}/${basename(l.file)}`, source: await readFile(l.file) })
      // static hosts that read _headers (Cloudflare Pages, Netlify): serve zips as downloads
      const headers = p.boards().filter(b => b.download).map(b =>
        `${b.download!.url}\n  Content-Type: application/zip\n  Content-Disposition: attachment; filename="${b.download!.filename}"\n`)
      if (headers.length) this.emitFile({ type: 'asset', fileName: '_headers', source: headers.join('\n') })
      const failed = [...p.entries.values()].filter(e => e.error || [...e.stages.values()].some(s => s.error)).map(e => e.src.name)
      if (failed.length) log.warn(`built with export failures: ${failed.join(', ')} (details above)`)
    },
  }
}
