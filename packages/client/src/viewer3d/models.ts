// Fetching, parsing and caching board models.
//
// - Download with byte progress (Content-Length when the server sends it).
// - VRML is parsed and merged in a worker (falls back to the main thread);
//   GLB is parsed with GLTFLoader, imported only when a GLB is actually shown.
// - The last few parsed models are kept (keyed by URL) so switching back to a
//   board is instant; evicted models are disposed.
import {
  Box3, BufferAttribute, Matrix4, Vector3, BufferGeometry, Color, DoubleSide, Group, Mesh, MeshStandardMaterial, SRGBColorSpace,
  type Material, type Object3D, type Texture,
} from 'three'
import type { BoardModel } from '../types'
import type { MergedModel, VrmlMaterial } from './vrmlMerge'

export interface LoadedModel {
  url: string
  object: Object3D
  box: Box3
  /** Outline points for fitting the view (see outlinePoints). */
  hull: Float32Array
  bytes: number
  triangles: number
  downloadMs: number
  parseMs: number
}

export type LoadProgress =
  | { phase: 'download'; received: number; total: number | null }
  | { phase: 'parse'; bytes: number }

const abortError = () => new DOMException('Aborted', 'AbortError')
export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError'

// ---- download ----------------------------------------------------------------------

async function download(url: string, signal: AbortSignal, onProgress: (p: LoadProgress) => void): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`The model could not be downloaded (HTTP ${res.status}).`)
  const length = Number(res.headers.get('content-length')) || null
  // a compressed response reports the compressed length: only trust it if it is not exceeded
  if (!res.body) return res.arrayBuffer()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let last = 0
  onProgress({ phase: 'download', received: 0, total: length })
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    const now = performance.now()
    if (now - last > 50) {
      last = now
      onProgress({ phase: 'download', received, total: length && received <= length ? length : null })
    }
  }
  const out = new Uint8Array(received)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out.buffer
}

// ---- VRML: worker parse, materials -----------------------------------------------

type WorkerReply = { ok: true; model: MergedModel } | { ok: false; error: string }

function parseInWorker(buffer: ArrayBuffer, base: string, signal: AbortSignal): Promise<MergedModel> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./vrml.worker.ts', import.meta.url), { type: 'module' })
    } catch (e) {
      reject(e)
      return
    }
    const done = () => { worker.terminate(); signal.removeEventListener('abort', onAbort) }
    const onAbort = () => { done(); reject(abortError()) }
    signal.addEventListener('abort', onAbort)
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      done()
      if (e.data.ok) resolve(e.data.model)
      else reject(new Error(`The model could not be parsed: ${e.data.error}`))
    }
    worker.onerror = (e) => {
      done()
      e.preventDefault()
      reject(new WorkerStartError(e.message || 'worker failed'))
    }
    worker.postMessage({ buffer, base }, [buffer])
  })
}

class WorkerStartError extends Error {}

async function parseVrml(buffer: ArrayBuffer, base: string, signal: AbortSignal): Promise<MergedModel> {
  // keep a copy for the fallback: the buffer is transferred to the worker
  const copy = buffer.slice(0)
  try {
    return await parseInWorker(buffer, base, signal)
  } catch (e) {
    if (!(e instanceof WorkerStartError) && !(e instanceof TypeError) && !(e instanceof DOMException && e.name === 'SecurityError')) throw e
    // no usable worker: parse here (blocks the page for the duration)
    if (signal.aborted) throw abortError()
    await new Promise(r => setTimeout(r, 0))
    const { parseAndMergeVrml } = await import('./vrmlMerge')
    return parseAndMergeVrml(new TextDecoder().decode(copy), base)
  }
}

const srgb = new Color()
function srgbOf(hex: number): [number, number, number] {
  srgb.setHex(hex, SRGBColorSpace)
  const out = { r: 0, g: 0, b: 0 }
  srgb.getRGB(out, SRGBColorSpace)
  return [out.r, out.g, out.b]
}

/**
 * VRML Phong-style material -> PBR. KiCad's board materials: copper/gold
 * (yellow, shininess 0.9, strong specular), paste/plated (grey, 0.7), mask
 * (near black, transparency 0.17), silkscreen (white, matte), board body.
 * Component bodies are mostly shininess 0.1 with weak specular.
 */
function toStandard(m: VrmlMaterial, vertexColors: boolean): MeshStandardMaterial {
  const [sr, sg, sb] = srgbOf(m.specular)
  const specLum = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb
  const metal = !m.unlit && m.shininess >= 0.5 && specLum >= 0.5
  const color = new Color().setHex(m.unlit ? 0x000000 : m.color, SRGBColorSpace)
  if (metal) color.lerp(new Color().setHex(m.specular, SRGBColorSpace), 0.5)
  const mask = m.opacity < 1
  const mat = new MeshStandardMaterial({
    color,
    emissive: new Color().setHex(m.emissive, SRGBColorSpace),
    metalness: metal ? 1 : 0,
    roughness: metal ? 0.32 : mask ? 0.32 : Math.min(0.9, Math.max(0.5, 0.9 - 0.6 * m.shininess)),
    transparent: mask,
    // KiCad's 17 % transparent mask lets the copper glow through more than a real
    // black mask does; keep a hint of the traces
    opacity: mask ? 1 - (1 - m.opacity) * 0.25 : 1,
    side: DoubleSide,
    vertexColors,
  })
  if (metal) mat.envMapIntensity = 1.2
  return mat
}

function buildVrml(model: MergedModel): Group {
  const group = new Group()
  group.name = 'board-model'
  for (const g of model.groups) {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(g.position, 3))
    geometry.setAttribute('normal', new BufferAttribute(g.normal, 3))
    if (g.color) geometry.setAttribute('color', new BufferAttribute(g.color, 3))
    geometry.setIndex(new BufferAttribute(g.index, 1))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    const material = toStandard(g.material, !!g.color)
    const mesh = new Mesh(geometry, material)
    // the (slightly transparent) mask after the opaque layers it covers
    if (material.transparent) mesh.renderOrder = 1
    group.add(mesh)
  }
  return group
}

async function parseGlb(buffer: ArrayBuffer, base: string): Promise<Object3D> {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
  const gltf = await new GLTFLoader().parseAsync(buffer, base)
  return gltf.scene
}

function countTriangles(root: Object3D): number {
  let n = 0
  root.traverse(o => {
    if (o instanceof Mesh) {
      const g = o.geometry as BufferGeometry
      n += (g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0)) / 3
    }
  })
  return Math.round(n)
}

/**
 * A small conservative stand-in for the model's convex hull, for fitting views:
 * the vertices are binned on a grid of up to 96 x 96 cells over the footprint and
 * each occupied cell contributes the 8 corners of its vertices' bounding box.
 * Every vertex lies inside, and the outline is at most one cell (about 1 % of
 * the board's long side) too generous, so a fit is tight even in oblique views
 * where the box corners would be far outside the parts.
 */
function outlinePoints(root: Object3D, box: Box3): Float32Array {
  const ex = Math.max(box.max.x - box.min.x, 1e-6), ey = Math.max(box.max.y - box.min.y, 1e-6)
  const long = Math.max(ex, ey)
  const nx = Math.max(1, Math.min(96, Math.round((96 * ex) / long)))
  const ny = Math.max(1, Math.min(96, Math.round((96 * ey) / long)))
  const cells = nx * ny
  const lo = new Float32Array(cells * 3).fill(Infinity)
  const hi = new Float32Array(cells * 3).fill(-Infinity)
  const v = new Vector3()
  root.traverse(o => {
    if (!(o instanceof Mesh)) return
    const pos = (o.geometry as BufferGeometry).getAttribute('position')
    if (!pos) return
    const identity = o.matrixWorld.equals(IDENTITY)
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i)
      if (!identity) v.applyMatrix4(o.matrixWorld)
      const cx = Math.min(nx - 1, Math.max(0, Math.floor(((v.x - box.min.x) / ex) * nx)))
      const cy = Math.min(ny - 1, Math.max(0, Math.floor(((v.y - box.min.y) / ey) * ny)))
      const c = (cy * nx + cx) * 3
      if (v.x < lo[c]!) lo[c] = v.x; if (v.x > hi[c]!) hi[c] = v.x
      if (v.y < lo[c + 1]!) lo[c + 1] = v.y; if (v.y > hi[c + 1]!) hi[c + 1] = v.y
      if (v.z < lo[c + 2]!) lo[c + 2] = v.z; if (v.z > hi[c + 2]!) hi[c + 2] = v.z
    }
  })
  const out: number[] = []
  for (let c = 0; c < cells; c++) {
    const k = c * 3
    if (lo[k] === Infinity) continue
    for (let i = 0; i < 8; i++) {
      out.push(i & 1 ? hi[k]! : lo[k]!, i & 2 ? hi[k + 1]! : lo[k + 1]!, i & 4 ? hi[k + 2]! : lo[k + 2]!)
    }
  }
  return new Float32Array(out)
}

const IDENTITY = new Matrix4()

// ---- public: load + cache --------------------------------------------------------

export async function loadModel(model: Pick<BoardModel, 'url' | 'format'>, signal: AbortSignal, onProgress: (p: LoadProgress) => void): Promise<LoadedModel> {
  const t0 = performance.now()
  const buffer = await download(model.url, signal, onProgress)
  if (signal.aborted) throw abortError()
  const downloadMs = performance.now() - t0
  const bytes = buffer.byteLength
  onProgress({ phase: 'parse', bytes })
  const base = model.url.slice(0, model.url.lastIndexOf('/') + 1)
  const t1 = performance.now()
  let object: Object3D
  let triangles: number
  if (model.format === 'vrml') {
    const merged = await parseVrml(buffer, base, signal)
    if (signal.aborted) throw abortError()
    object = buildVrml(merged)
    triangles = merged.triangles
  } else {
    object = await parseGlb(buffer, base)
    if (signal.aborted) { disposeObject(object); throw abortError() }
    triangles = countTriangles(object)
  }
  object.updateMatrixWorld(true)
  const box = new Box3().setFromObject(object)
  if (box.isEmpty()) { disposeObject(object); throw new Error('The model is empty.') }
  const hull = outlinePoints(object, box)
  return { url: model.url, object, box, hull, bytes, triangles, downloadMs, parseMs: performance.now() - t1 }
}

/**
 * Release GPU resources (and, once dropped from the cache, everything). three.js
 * re-uploads a disposed geometry / material / texture if it is rendered again, so
 * this is also how cached models let go of a renderer that is being destroyed.
 */
export function disposeObject(root: Object3D): void {
  root.traverse(o => {
    const mesh = o as Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : []
    for (const m of mats as Material[]) {
      for (const value of Object.values(m)) {
        if (value && typeof value === 'object' && (value as Texture).isTexture) (value as Texture).dispose()
      }
      m.dispose()
    }
  })
}

const CACHE_SIZE = 3
const cache = new Map<string, LoadedModel>()   // insertion order = least recently used first

export function cachedModel(url: string): LoadedModel | null {
  const m = cache.get(url)
  if (!m) return null
  cache.delete(url)
  cache.set(url, m)
  return m
}

export function cacheModel(m: LoadedModel): void {
  cache.delete(m.url)
  cache.set(m.url, m)
  while (cache.size > CACHE_SIZE) {
    const [url, old] = cache.entries().next().value as [string, LoadedModel]
    cache.delete(url)
    old.object.removeFromParent()
    disposeObject(old.object)
  }
}

/** Free the GPU side of every cached model (the CPU side stays for an instant re-show). */
export function releaseCachedGpu(): void {
  for (const m of cache.values()) disposeObject(m.object)
}
