// Camera poses for the view shortcuts, and fitting a box to the viewport.
//
// World: millimetres, Z up, board centred on the origin, front copper on +Z.
// One perspective camera serves every view. Plan views (Top / Bottom) use a very
// narrow field of view from far away, which is orthographic for all practical
// purposes (a 5 mm part 80 mm off-centre leans by under 0.2 mm), while the
// animation between plan and 3D views changes the field of view and the distance
// together ("dolly zoom"), so the framing never jumps.
import { MathUtils, Matrix4, Quaternion, Vector3, type Box3 } from 'three'

export const FOV_3D = 30          // degrees
export const FOV_PLAN = 3         // degrees, plan views

export type ViewName = 'top' | 'bottom' | 'iso'

/** What the camera looks at and how: everything an animation interpolates. */
export interface Pose {
  target: Vector3
  quaternion: Quaternion
  /** Half of the visible height at the target distance (mm). Distance = height / tan(fov / 2). */
  height: number
  fov: number
}

export interface Viewport {
  width: number
  height: number
  /** Pixels kept free on each side (toolbar, margins). */
  inset: { top: number; right: number; bottom: number; left: number }
}

const Z = new Vector3(0, 0, 1)

/** Tilt of plan views off the pole (radians): keeps a Z-up orbit controller well defined. */
const POLE_TILT = 1e-4

/**
 * Camera orientation looking along -back with the given screen-up direction, as a
 * Z-up orbit controller would produce it (camera.lookAt with up = Z). For views
 * along Z the camera is tilted by POLE_TILT so that "up" is unambiguous; the tilt
 * is in the up direction, so there is no roll and board edges stay parallel to the pane.
 */
export function orientation(back: Vector3, up: Vector3): Quaternion {
  const b = back.clone().normalize()
  const dir = b.clone()
  const s = b.dot(Z)
  if (Math.abs(s) > 0.9999) {
    // screen up of a camera near the pole is -sign(s) * (tilt direction)
    const k = up.clone().addScaledVector(b, -up.dot(b)).normalize().multiplyScalar(-Math.sign(s))
    dir.multiplyScalar(Math.cos(POLE_TILT)).addScaledVector(k, Math.sin(POLE_TILT)).normalize()
  }
  const m = new Matrix4().lookAt(dir, new Vector3(0, 0, 0), Z)
  return new Quaternion().setFromRotationMatrix(m)
}

export function basis(q: Quaternion): { right: Vector3; up: Vector3; back: Vector3 } {
  return {
    right: new Vector3(1, 0, 0).applyQuaternion(q),
    up: new Vector3(0, 1, 0).applyQuaternion(q),
    back: new Vector3(0, 0, 1).applyQuaternion(q),
  }
}

/** The 8 corners of a box as a point list (xyz triples). */
export function boxPoints(box: Box3): Float32Array {
  const out = new Float32Array(24)
  for (let i = 0; i < 8; i++) {
    out[i * 3] = i & 1 ? box.max.x : box.min.x
    out[i * 3 + 1] = i & 2 ? box.max.y : box.min.y
    out[i * 3 + 2] = i & 4 ? box.max.z : box.min.z
  }
  return out
}

/**
 * Frame the model for a camera with orientation `q` and field of view `fov`:
 * the smallest distance at which every point of `hull` (xyz triples: the model's
 * outline points, see models.ts) is inside the free part of the viewport, exact
 * under perspective, with the model centred in that free part.
 */
export function fit(hull: Float32Array, q: Quaternion, fov: number, vp: Viewport): Pose {
  const { right, up, back } = basis(q)
  const n = hull.length / 3
  const U = new Float64Array(n), V = new Float64Array(n), Wd = new Float64Array(n)
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, w0 = Infinity, w1 = -Infinity
  for (let i = 0; i < n; i++) {
    const x = hull[i * 3]!, y = hull[i * 3 + 1]!, z = hull[i * 3 + 2]!
    const u = x * right.x + y * right.y + z * right.z
    const v = x * up.x + y * up.y + z * up.z
    const w = x * back.x + y * back.y + z * back.z
    U[i] = u; V[i] = v; Wd[i] = w
    if (u < u0) u0 = u; if (u > u1) u1 = u
    if (v < v0) v0 = v; if (v > v1) v1 = v
    if (w < w0) w0 = w; if (w > w1) w1 = w
  }
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2, wc = (w0 + w1) / 2

  const W = Math.max(1, vp.width), H = Math.max(1, vp.height)
  const { top, right: r, bottom, left } = vp.inset
  const fx = Math.max(0.2, (W - left - r) / W)
  const fy = Math.max(0.2, (H - top - bottom) / H)
  const tanV = Math.tan(MathUtils.degToRad(fov) / 2)
  const tanH = tanV * (W / H)
  const tV = tanV * fy, tH = tanH * fx

  let D = 0
  for (let i = 0; i < n; i++) D = Math.max(D, Math.max(Math.abs(U[i]! - uc) / tH, Math.abs(V[i]! - vc) / tV) + (Wd[i]! - wc))
  D = Math.max(D, 1e-3)

  // centre the box in the free rectangle rather than in the pane
  const ndcX = ((left - r) / 2) / (W / 2)
  const ndcY = -((top - bottom) / 2) / (H / 2)
  const target = new Vector3()
    .addScaledVector(right, uc - ndcX * D * tanH)
    .addScaledVector(up, vc - ndcY * D * tanV)
    .addScaledVector(back, wc)
  return { target, quaternion: q.clone(), height: D * tanV, fov }
}

/** Should plan views turn the board by 90 degrees to use the pane better? */
export function planRotated(box: Box3, vp: Viewport): boolean {
  const ex = box.max.x - box.min.x, ey = box.max.y - box.min.y
  const W = vp.width - vp.inset.left - vp.inset.right
  const H = vp.height - vp.inset.top - vp.inset.bottom
  if (W <= 0 || H <= 0 || ex <= 0 || ey <= 0) return false
  const straight = Math.min(W / ex, H / ey)
  const turned = Math.min(W / ey, H / ex)
  return turned > straight * 1.1
}

/**
 * Orientation of a plan view.
 *
 * Top: board X to the right, Y up (as in KiCad). Turned: rotated 90 degrees
 * counter-clockwise (board X up, text reads bottom to top).
 * Bottom: the board turned over about its Y axis, which is how KiCad shows the
 * back and how back-side text is laid out (mirrored text at 0 degrees), so the
 * back silkscreen reads left to right and upright. `alternate` turns it 180
 * degrees in plane (the same as flipping it over its X axis instead).
 */
export function planOrientation(view: 'top' | 'bottom', turned: boolean, alternate = false): Quaternion {
  const back = new Vector3(0, 0, view === 'top' ? 1 : -1)
  const up = new Vector3(0, 1, 0)
  let roll = turned ? -Math.PI / 2 : 0
  if (alternate) roll += Math.PI
  up.applyAxisAngle(back, roll)
  return orientation(back, up)
}

/** Isometric-style 3D view from the front, `corner` (0..3) steps it around the board by 90 degrees. */
export function isoOrientation(corner = 0): Quaternion {
  const az = MathUtils.degToRad(-30 + 90 * corner)
  const el = MathUtils.degToRad(35)
  const back = new Vector3(-Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el))
  return orientation(back, Z)
}

/** Interpolate between two poses; t in 0..1 (already eased). */
export function lerpPose(a: Pose, b: Pose, t: number, out: Pose): Pose {
  out.target.lerpVectors(a.target, b.target, t)
  out.quaternion.slerpQuaternions(a.quaternion, b.quaternion, t)
  // field of view and visible size change together: interpolate in tan / log space
  const ta = Math.tan(MathUtils.degToRad(a.fov) / 2), tb = Math.tan(MathUtils.degToRad(b.fov) / 2)
  out.fov = MathUtils.radToDeg(2 * Math.atan(ta * Math.pow(tb / ta, t)))
  out.height = a.height * Math.pow(b.height / a.height, t)
  return out
}

export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
