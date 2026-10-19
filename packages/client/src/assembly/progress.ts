// Assembly progress (pure apart from the guarded storage calls): which refdes are
// placed, per board, revision and variant, in localStorage; and the JSON file that
// moves a session to another device.

export const PROGRESS_KIND = 'kiview-assembly'

export interface ProgressFile {
  kind: typeof PROGRESS_KIND
  version: 1
  board: string
  /** Board.rev.label when exported. */
  rev: string
  variant: string | null
  placed: string[]
  /** The step being worked on. */
  current: string | null
  exported: string
}

export interface Saved { placed: string[]; current: string | null }

/** Storage key of one build: board, revision label, variant. */
export const progressKey = (board: string, rev: string, variant: string | null) =>
  `kiview.assembly:${board}@${rev}${variant ? `#${variant}` : ''}`

export function loadProgress(key: string): Saved {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { placed: [], current: null }
    const v = JSON.parse(raw) as Partial<Saved>
    return {
      placed: Array.isArray(v.placed) ? v.placed.filter((x): x is string => typeof x === 'string') : [],
      current: typeof v.current === 'string' ? v.current : null,
    }
  } catch { return { placed: [], current: null } }
}

export function saveProgress(key: string, s: Saved): void {
  try {
    if (!s.placed.length && !s.current) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(s))
  } catch { /* private mode, quota: progress lives for the page only */ }
}

export function exportProgress(o: { board: string; rev: string; variant: string | null; placed: Iterable<string>; current: string | null }, now = new Date()): ProgressFile {
  return { kind: PROGRESS_KIND, version: 1, board: o.board, rev: o.rev, variant: o.variant, placed: [...o.placed].sort(), current: o.current, exported: now.toISOString() }
}

export type ImportResult =
  | { ok: true; file: ProgressFile; warnings: string[] }
  | { ok: false; error: string }

/** Check an uploaded progress file against the board being shown. */
export function parseProgress(text: string, board: string, rev: string, knownRefs: ReadonlySet<string>): ImportResult {
  let v: unknown
  try { v = JSON.parse(text) } catch { return { ok: false, error: 'not a JSON file' } }
  const f = v as Partial<ProgressFile>
  if (!f || typeof f !== 'object' || f.kind !== PROGRESS_KIND || f.version !== 1) return { ok: false, error: 'not an assembly progress file' }
  if (f.board !== board) return { ok: false, error: `the file is for board "${String(f.board)}", not "${board}"` }
  if (!Array.isArray(f.placed) || f.placed.some(x => typeof x !== 'string')) return { ok: false, error: 'the file has no list of placed parts' }
  const warnings: string[] = []
  if (f.rev !== rev) warnings.push(`saved for revision ${String(f.rev)}, this is ${rev}`)
  const unknown = f.placed.filter(r => !knownRefs.has(r))
  if (unknown.length) warnings.push(`${unknown.length} part${unknown.length > 1 ? 's' : ''} not on this board ignored (${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ', …' : ''})`)
  return {
    ok: true,
    warnings,
    file: {
      kind: PROGRESS_KIND, version: 1, board, rev: String(f.rev ?? ''), variant: typeof f.variant === 'string' ? f.variant : null,
      placed: f.placed.filter(r => knownRefs.has(r)), current: typeof f.current === 'string' ? f.current : null,
      exported: typeof f.exported === 'string' ? f.exported : '',
    },
  }
}
