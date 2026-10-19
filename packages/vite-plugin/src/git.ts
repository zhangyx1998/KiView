// Read-only git access for revision info and layer diffs. Every call is
// `git -C <dir> ...` with GIT_OPTIONAL_LOCKS=0 (so `git status` never rewrites the
// index of the user's repo); nothing here checks out, stages or writes into a repo.
// Old revisions of a board are taken with `git archive` into a scratch directory.
// Without git (no binary, not a repo, untracked dir) every helper returns null.

import { execFile, spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'

export interface GitCommit {
  commit: string
  short: string
  date: string
  subject: string
  /** Tag pointing exactly at the commit (newest by version sort), else null. */
  tag: string | null
}

export interface GitState extends GitCommit {
  /** `git describe --tags --always` of the commit, e.g. "v1.2.0-3-gabc1234". */
  describe: string | null
  /** Uncommitted changes (tracked or untracked, not ignored) inside the project dir. */
  dirty: boolean
  /** Repository top level and the project dir relative to it ('' at the top). */
  top: string
  prefix: string
}

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }

/** stdout of `git -C dir ...`, trimmed; null on any failure. */
export function git(dir: string, args: string[], timeoutMs = 20_000): Promise<string | null> {
  return new Promise(resolve => {
    execFile('git', ['-C', dir, ...args], { env: ENV, timeout: timeoutMs, maxBuffer: 16 << 20, windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout).trim()))
  })
}

async function commitFacts(dir: string, rev: string): Promise<GitCommit | null> {
  const out = await git(dir, ['log', '-1', '--format=%H%x00%h%x00%cI%x00%s', rev, '--'])
  if (!out) return null
  const [commit = '', short = '', date = '', subject = ''] = out.split('\0')
  const tags = await git(dir, ['tag', '--points-at', commit, '--sort=-version:refname'])
  return { commit, short, date, subject, tag: tags?.split('\n').find(Boolean) ?? null }
}

/** Last commit touching `dir`, its tag / describe and whether `dir` has uncommitted changes. */
export async function gitState(dir: string): Promise<GitState | null> {
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  if (!top) return null
  const prefix = (await git(dir, ['rev-parse', '--show-prefix'])) ?? ''
  const last = await git(dir, ['log', '-1', '--format=%H', '--', '.'])
  if (!last) return null
  const facts = await commitFacts(dir, last)
  if (!facts) return null
  const [describe, status] = await Promise.all([
    git(dir, ['describe', '--tags', '--always', last]),
    git(dir, ['status', '--porcelain', '--', '.']),
  ])
  return { ...facts, describe, dirty: !!status, top, prefix }
}

/**
 * The commit a diff compares against:
 * - 'previous': the version before the current one: the last commit touching the
 *   project dir when the dir has uncommitted changes, else the commit before that one;
 * - 'previous-tag': the newest tag before the current version;
 * - anything else: a git revision (`HEAD~1`, `v1.0`, a hash), resolved in the repo.
 */
export async function resolveBase(dir: string, ref: string, state: GitState): Promise<GitCommit | string> {
  let rev: string | null
  if (ref === 'previous') {
    if (state.dirty) rev = state.commit
    else {
      const two = await git(dir, ['log', '-2', '--format=%H', state.commit, '--', '.'])
      rev = two?.split('\n')[1] ?? null
      if (!rev) return 'no earlier commit touches the board'
    }
  } else if (ref === 'previous-tag') {
    const from = state.tag && !state.dirty ? `${state.commit}^` : state.commit
    rev = await git(dir, ['describe', '--tags', '--abbrev=0', from])
    if (!rev) return 'no earlier tag'
  } else {
    rev = await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    if (!rev) return `unknown git revision "${ref}"`
  }
  return (await commitFacts(dir, rev)) ?? `cannot read commit ${rev}`
}

/** Extract `paths` (relative to the repo top) as of `commit` into `dest` (git archive | tar). */
export async function archive(top: string, commit: string, paths: string[], dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const g = spawn('git', ['-C', top, 'archive', '--format=tar', commit, '--', ...(paths.length ? paths : ['.'])],
                    { env: ENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const t = spawn('tar', ['-x', '-f', '-', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    g.stderr.on('data', d => { err += d })
    t.stderr.on('data', d => { err += d })
    g.stdout.pipe(t.stdin)
    const done = (p: ReturnType<typeof spawn>) => new Promise<number | null>((res, rej) => { p.on('error', rej); p.on('close', res) })
    Promise.all([done(g), done(t)]).then(([gc, tc]) => {
      if (gc === 0 && tc === 0) resolve()
      else reject(new Error(`git archive ${commit.slice(0, 12)} failed: ${err.trim().split('\n').slice(-2).join(' | ') || `exit ${gc}/${tc}`}`))
    }, reject)
  })
}
