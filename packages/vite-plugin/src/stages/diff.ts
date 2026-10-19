// Layer diff against an earlier git revision (opt-in: config revision.diff), and the
// "changes since <ref>" summary. A late stage.
//
// The base commit is resolved per refresh (git.ts resolveBase) and is part of the
// recipe, so results are cached per (board content, base commit). The board files of
// the base are taken with `git archive` into the stage's scratch dir; the user's
// repo is never checked out or written.
//
// Both revisions are plotted (one multi-layer SVG call each, without drill shapes)
// and normalised onto one viewBox (the union of both outlines plus the margin), so
// equal layers give equal SVG text: that is the "changed" test. Only changed, added
// and removed layers ship their before / after SVGs.
//
// Parts (added / removed / moved / changed) are compared when footprints are parsed
// (BoardInfo.footprints, filled by P2-b); until then `parts` is null.

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { normaliseLayerSvg, readBoard, selectLayers, type BoardInfo, type Footprint, type LayerSpec, type Rect } from '@kiview/kicad'

import type { BoardDiff, LayerDiff, PartsDiff } from '../contract.ts'
import { archive, resolveBase, type GitCommit } from '../git.ts'
import { resolveRevision } from './revision.ts'
import type { Stage, StageContext, StageInput } from './types.ts'

type DiffResult = Omit<BoardDiff, 'layers'> & { layers: (Omit<LayerDiff, 'before' | 'after'> & { before: string | null; after: string | null })[] }

const fileSafe = (id: string) => id.replace(/[^A-Za-z0-9]+/g, '_')
const round = (v: number) => Math.round(v * 1e4) / 1e4
const EPS = 1e-3

const baseMemo = new WeakMap<StageInput['contents'], Promise<GitCommit | string>>()

/** The base commit for this refresh, or why there is none. */
function base(i: StageInput): Promise<GitCommit | string> {
  let p = baseMemo.get(i.contents)
  if (!p) {
    p = resolveRevision(i).then(r => (r.state ? resolveBase(i.src.dir, i.config.revision.diff!, r.state) : 'the project is not in a git repository (or not committed)'))
    baseMemo.set(i.contents, p)
  }
  return p
}

function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a || !b) return a ?? b
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

const sameRect = (a: Rect | null, b: Rect | null) =>
  (!a && !b) || (!!a && !!b && Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.width - b.width) < EPS && Math.abs(a.height - b.height) < EPS)

/** Footprint differences by reference designator; null when neither revision has parsed footprints. */
export function diffParts(before: Footprint[], after: Footprint[]): PartsDiff | null {
  if (!before.length && !after.length) return null
  const old = new Map(before.map(f => [f.ref, f]))
  const now = new Map(after.map(f => [f.ref, f]))
  const out: PartsDiff = { added: [], removed: [], moved: [], changed: [] }
  for (const [ref, f] of now) {
    const o = old.get(ref)
    if (!o) { out.added.push(ref); continue }
    if (Math.abs(o.at.x - f.at.x) > EPS || Math.abs(o.at.y - f.at.y) > EPS || Math.abs(o.rotation - f.rotation) > EPS || o.side !== f.side)
      out.moved.push(ref)
    if (o.value !== f.value || o.footprint !== f.footprint) out.changed.push(ref)
  }
  for (const ref of old.keys()) if (!now.has(ref)) out.removed.push(ref)
  const byRef = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true })
  for (const k of ['added', 'removed', 'moved', 'changed'] as const) out[k].sort(byRef)
  return out
}

export function summarise(d: Pick<BoardDiff, 'layers' | 'parts' | 'outlineChanged' | 'note'>): string {
  if (d.note) return d.note
  const n = (k: LayerDiff['status']) => d.layers.filter(l => l.status === k).length
  const s: string[] = []
  const plural = (c: number, w: string) => `${c} ${w}${c === 1 ? '' : 's'}`
  if (n('changed')) s.push(`${plural(n('changed'), 'layer')} changed`)
  if (n('added')) s.push(`${plural(n('added'), 'layer')} added`)
  if (n('removed')) s.push(`${plural(n('removed'), 'layer')} removed`)
  if (d.outlineChanged) s.push('outline changed')
  if (d.parts) for (const k of ['added', 'removed', 'moved', 'changed'] as const)
    if (d.parts[k].length) s.push(`${plural(d.parts[k].length, 'part')} ${k}`)
  return s.length ? s.join(', ') : 'no changes'
}

async function plot(ctx: StageContext, pcb: string, specs: LayerSpec[], wd: string): Promise<Map<string, string>> {
  const files = await ctx.sem.run(() => ctx.backend!.exportLayerSvgs(pcb, specs.map(s => s.id), { holes: false }, ctx.op(wd)))
  const out = new Map<string, string>()
  for (const f of files) out.set(f.layer, await readFile(f.file, 'utf8'))
  return out
}

export const diffStage: Stage<DiffResult> = {
  name: 'diff',
  version: 'd1',
  inputs: ['pcb'],
  provides: [],
  late: true,
  skip(i) {
    if (!i.config.revision.diff) return 'the revision diff is off (revision.diff)'
    if (!i.config.revision.git) return 'the revision diff needs git (revision.git is false)'
    if (!i.backend?.capabilities.ops.layerSvg) return 'the KiCad backend cannot plot layers'
    return null
  },
  async recipe(i) {
    const b = await base(i)
    return { ref: i.config.revision.diff, base: typeof b === 'string' ? { none: b } : b.commit, margin: i.config.margin, env: i.config.env }
  },

  async run(ctx) {
    const ref = ctx.config.revision.diff!
    const b = await base(ctx)
    const empty = (note: string): DiffResult => ({
      ref, base: typeof b === 'string' ? null : b, note, bounds: { x: 0, y: 0, width: 0, height: 0 },
      outlineChanged: false, layers: [], parts: null, summary: note,
    })
    if (typeof b === 'string') return { result: empty(b), files: [] }

    // the board as of the base commit
    const rev = await resolveRevision(ctx)
    // the project dir relative to the repo top, as git sees it (symlinks such as /tmp -> /private/tmp resolved)
    const { top, prefix } = rev.state!
    const relDir = prefix.replace(/\/$/, '')
    const old = join(ctx.workDir, 'base')
    await archive(top, b.commit, [relDir || '.'], old)
    const oldPcb = join(old, relDir, basename(ctx.src.pcb))
    if (!existsSync(oldPcb)) return { result: empty(`the board did not exist at ${b.short}`), files: [] }
    let oldInfo: BoardInfo
    try { oldInfo = readBoard(await readFile(oldPcb, 'utf8')) }
    catch (e) { return { result: empty(`cannot read the board at ${b.short}: ${e instanceof Error ? e.message : e}`), files: [] } }
    const now = ctx.info

    const m = ctx.config.margin
    const outline = union(oldInfo.outline, now.outline)
    const bounds: Rect = outline
      ? { x: round(outline.x - m), y: round(outline.y - m), width: round(outline.width + 2 * m), height: round(outline.height + 2 * m) }
      : { x: 0, y: 0, width: 100, height: 100 }

    const oldSpecs = selectLayers(oldInfo.layers, new Set(oldInfo.usedLayers))
    const newSpecs = selectLayers(now.layers, new Set(now.usedLayers))
    const snap = await ctx.snapshot()
    const [before, after] = await Promise.all([
      plot(ctx, oldPcb, oldSpecs, join(ctx.workDir, 'plot-before')),
      plot(ctx, snap.pcb, newSpecs, join(ctx.workDir, 'plot-after')),
    ])

    // every layer of either revision, in the current stacking order (removed ones after)
    const specs = new Map<string, LayerSpec>()
    for (const s of [...newSpecs, ...oldSpecs].sort((a, c) => a.rank - c.rank)) if (!specs.has(s.id)) specs.set(s.id, s)
    const norm = (raw: string | undefined, s: LayerSpec) => raw === undefined ? null
      : normaliseLayerSvg(raw, raw, { viewBox: bounds, color: s.color, layerId: s.id, maskId: `diff-${fileSafe(ctx.src.name)}-${fileSafe(s.id)}` }).svg
    const layers: DiffResult['layers'] = []
    const files: string[] = []
    let order = 0
    for (const s of specs.values()) {
      const bSvg = norm(before.get(s.id), s), aSvg = norm(after.get(s.id), s)
      if (bSvg === null && aSvg === null) continue
      const status: LayerDiff['status'] = bSvg === null ? 'added' : aSvg === null ? 'removed' : bSvg === aSvg ? 'unchanged' : 'changed'
      const entry = { id: s.id, name: s.name, kind: s.kind, side: s.side, color: s.color, order: order++, status, before: null as string | null, after: null as string | null }
      if (status !== 'unchanged') {
        const f = `${fileSafe(s.id)}.svg`
        if (bSvg !== null) { await writeFile(join(ctx.outDir, `before-${f}`), bSvg); entry.before = `before-${f}`; files.push(entry.before) }
        if (aSvg !== null) { await writeFile(join(ctx.outDir, `after-${f}`), aSvg); entry.after = `after-${f}`; files.push(entry.after) }
      }
      layers.push(entry)
    }

    const partial = { layers, parts: diffParts(oldInfo.footprints, now.footprints), outlineChanged: !sameRect(oldInfo.outline, now.outline), note: null }
    return { result: { ref, base: b, bounds, ...partial, summary: summarise(partial) }, files }
  },

  apply(board, r, url) {
    board.diff = { ...r, layers: r.layers.map(l => ({ ...l, before: l.before && url(l.before), after: l.after && url(l.after) })) }
  },
}
