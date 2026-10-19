// Child processes: run a command with a timeout and collect its output, and a
// semaphore that bounds how many KiCad processes run at once.

import { spawn } from 'node:child_process'

export interface RunResult {
  code: number | null
  /** stdout + stderr lines, noise removed. */
  out: string[]
}

export interface RunOptions {
  timeoutMs?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Lines to drop from the output. */
  noise?: RegExp
}

const DEFAULT_NOISE = /^(Debug:|Rendering:|\s*$)/

/** Never rejects: a spawn failure is code -1 with the error as output. */
export function run(cmd: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = o.timeoutMs ?? 180_000
  const noise = o.noise ?? DEFAULT_NOISE
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], signal: o.signal })
    let buf = ''
    child.stdout.on('data', (d: Buffer) => { buf += d.toString() })
    child.stderr.on('data', (d: Buffer) => { buf += d.toString() })
    const timer = setTimeout(() => { buf += `\n(killed after ${timeoutMs} ms)`; child.kill('SIGKILL') }, timeoutMs)
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: [String(e)] }) })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, out: buf.split(/\r?\n/).filter(l => !noise.test(l)) })
    })
  })
}

export class Semaphore {
  private queue: (() => void)[] = []
  private active = 0
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(r => this.queue.push(r))
    this.active++
    try { return await fn() } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}
