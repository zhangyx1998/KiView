// Revision of a board: Board.rev from
//   - the VERSION file next to the board (config revision.versionFile; semver expected),
//   - the title-block rev,
//   - git (config revision.git): the last commit touching the project dir, its exact
//     tag and `git describe`, and whether the dir has uncommitted changes.
// label = version, else tag, else title-block rev, else the short content hash.
//
// The facts are resolved once per refresh (resolveRevision memoises per StageInput)
// and are the stage's recipe, so a new commit or VERSION re-keys the stage. Other
// stages (fab: the zip name; diff: the base commit) use the same resolution. Without
// git (no binary, no repo, untracked dir) `git` is null.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { BoardRevision } from '../contract.ts'
import { gitState, type GitState } from '../git.ts'
import type { Stage, StageInput } from './types.ts'

export interface RevisionFacts {
  version: string | null
  git: BoardRevision['git']
  label: string
  /** Repo facts the diff stage needs (not shipped). */
  repo: { top: string; prefix: string } | null
  warnings: string[]
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** Content of the VERSION file (first non-empty line), or null. */
export async function readVersionFile(dir: string, file: string | false): Promise<{ version: string | null; warning: string | null }> {
  if (!file) return { version: null, warning: null }
  let text: string
  try { text = await readFile(join(dir, file), 'utf8') } catch { return { version: null, warning: null } }
  const version = text.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? null
  if (!version) return { version: null, warning: `${file} is empty` }
  return { version, warning: SEMVER.test(version) ? null : `${file} "${version}" is not a semantic version` }
}

/** Resolve the revision of a board directory (no caching). */
export async function revisionOf(o: {
  dir: string; hash: string; titleBlockRev: string | null; versionFile: string | false; git: boolean
}): Promise<RevisionFacts & { state: GitState | null }> {
  const [{ version, warning }, state] = await Promise.all([
    readVersionFile(o.dir, o.versionFile),
    o.git ? gitState(o.dir) : Promise.resolve(null),
  ])
  const git: BoardRevision['git'] = state && {
    commit: state.commit, short: state.short, tag: state.tag, dirty: state.dirty, date: state.date,
    describe: state.describe, subject: state.subject,
  }
  return {
    version, git,
    label: version ?? state?.tag ?? o.titleBlockRev ?? o.hash.slice(0, 7),
    repo: state && { top: state.top, prefix: state.prefix },
    warnings: warning ? [warning] : [],
    state,
  }
}

// keyed on `contents`: the one object a refresh's StageInput and every StageContext share
const memo = new WeakMap<StageInput['contents'], Promise<RevisionFacts & { state: GitState | null }>>()

/** The board's revision for this refresh (memoised per refresh). */
export function resolveRevision(i: StageInput): Promise<RevisionFacts & { state: GitState | null }> {
  let p = memo.get(i.contents)
  if (!p) {
    p = revisionOf({
      dir: i.src.dir, hash: i.hash, titleBlockRev: i.info.titleBlock.rev,
      versionFile: i.config.revision.versionFile, git: i.config.revision.git,
    })
    memo.set(i.contents, p)
  }
  return p
}

export const revisionStage: Stage<RevisionFacts> = {
  name: 'revision',
  version: 'r1',
  inputs: [],
  provides: [],
  async recipe(i) {
    const { state: _state, ...facts } = await resolveRevision(i)
    return { ...facts, hash: i.hash, titleBlock: i.info.titleBlock.rev }
  },
  async run(ctx) {
    const { state: _state, ...facts } = await resolveRevision(ctx)
    for (const w of facts.warnings) ctx.warn(w)
    return { result: facts, files: [] }
  },
  apply(board, r) {
    board.rev = { ...board.rev, version: r.version, git: r.git, label: r.label }
  },
}
