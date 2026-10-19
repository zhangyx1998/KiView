// kiview dev|build|preview [root] [options]

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import type { UserConfig } from '@kiview/vite-plugin/config'

import { loadConfig } from './load-config.ts'
import { build, dev, preview } from './vite.ts'

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const HELP = `kiview ${VERSION}: a static website for a folder of KiCad projects

Usage
  kiview dev [root]       dev server; re-exports boards when their files change
  kiview build [root]     static site into <outDir> (default <root>/.kiview/dist)
  kiview preview [root]   serve the built site

root defaults to the current directory. Options (override the config file):
  -c, --config <file>     config file (default: kiview.config.{ts,mts,js,mjs} in root)
      --base <path>       public base path, e.g. /boards/
      --out-dir <dir>     build output
      --cache-dir <dir>   export cache
      --host <host>       listen on this interface ("all" for every interface)
      --port <port>
      --open              open a browser
      --kicad-cli <path>  kicad-cli to use
  -h, --help
  -v, --version
`

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      base: { type: 'string' },
      'out-dir': { type: 'string' },
      'cache-dir': { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      open: { type: 'boolean' },
      'kicad-cli': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })
  if (values.version) { console.log(VERSION); return }
  const [command = 'dev', dir = '.'] = positionals
  if (values.help || !['dev', 'build', 'preview'].includes(command)) {
    console.log(HELP)
    if (!values.help) process.exitCode = 1
    return
  }
  const root = resolve(dir)
  const overrides: UserConfig = {}
  if (values.base) overrides.base = values.base
  if (values['out-dir']) overrides.outDir = resolve(values['out-dir'])
  if (values['cache-dir']) overrides.cacheDir = resolve(values['cache-dir'])
  if (values['kicad-cli']) overrides.kicad = { cli: values['kicad-cli'] }
  const server: UserConfig['server'] = {}
  if (values.host !== undefined) server.host = values.host === 'all' ? true : values.host
  if (values.port) server.port = Number(values.port)
  overrides.server = server

  const { file, resolved, user } = await loadConfig(root, { file: values.config, command: command === 'build' ? 'build' : 'serve', overrides })
  if (overrides.kicad && user.kicad) resolved.kicad = { ...resolved.kicad, ...user.kicad, ...overrides.kicad }
  console.log(`kiview ${VERSION}: ${command} ${root}${file ? ` (config ${file})` : ''}`)
  if (command === 'dev') await dev(resolved, { open: values.open })
  else if (command === 'build') await build(resolved)
  else await preview(resolved, { open: values.open })
}
