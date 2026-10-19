// 3D cross-probe marker. The default VRML model is merged into a few meshes per
// material in a worker (vrmlMerge.ts), so part meshes cannot be told apart by
// refdes; instead the selected parts get a translucent box over their footprint
// box (parts.json), standing on the side of the board they are mounted on.
//
// Model coordinates (kicad-cli VRML / GLB): mm, Z up, origin at the centre of the
// board outline, x = kx - cx, y = -(ky - cy); the board is centred on z = 0, so its
// faces are at +-thickness / 2.

import {
  BoxGeometry, EdgesGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, type Object3D,
} from 'three'
import type { Board, Footprint } from '../types'

const COLOR = 0x5aa7ff
const HEIGHT = 2.5   // mm above (below) the board face

export function partMarkers(board: Board, parts: readonly Footprint[], thickness: number | null | undefined): Object3D | null {
  if (!parts.length) return null
  const cx = board.bounds.x + board.bounds.width / 2
  const cy = board.bounds.y + board.bounds.height / 2
  const half = (thickness ?? 1.6) / 2
  const group = new Group()
  group.name = 'crossprobe-markers'
  const fill = new MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.28, depthWrite: false })
  const edge = new LineBasicMaterial({ color: COLOR, transparent: true, opacity: 0.95, depthTest: false })
  for (const f of parts) {
    const w = Math.max(0.4, f.bbox.width), h = Math.max(0.4, f.bbox.height)
    const geo = new BoxGeometry(w, h, HEIGHT)
    const x = f.bbox.x + f.bbox.width / 2 - cx
    const y = -(f.bbox.y + f.bbox.height / 2 - cy)
    const z = f.side === 'back' ? -half - HEIGHT / 2 : half + HEIGHT / 2
    const box = new Mesh(geo, fill)
    box.position.set(x, y, z)
    box.renderOrder = 10
    const lines = new LineSegments(new EdgesGeometry(geo), edge)
    lines.position.copy(box.position)
    lines.renderOrder = 11
    group.add(box, lines)
  }
  return group
}

export function disposeMarkers(o: Object3D | null): void {
  o?.traverse(c => {
    const m = c as Mesh
    m.geometry?.dispose()
    const mat = m.material
    if (Array.isArray(mat)) mat.forEach(x => x.dispose())
    else mat?.dispose()
  })
}
