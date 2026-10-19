// Parse a KiCad VRML export and flatten it into one indexed triangle batch per
// distinct material. KiCad writes thousands of small shapes (7000+ for the
// Controller) and VRMLLoader clones a material for every `USE`, so drawing the
// raw scene graph costs thousands of draw calls; merged it is a few dozen.
//
// Pure data in, pure data out: runs in the parse worker, or on the main thread
// as a fallback when workers are unavailable.
import { BufferAttribute, Color, Matrix3, Mesh, SRGBColorSpace, Vector3, type BufferGeometry, type Material } from 'three'
import { VRMLLoader } from 'three/addons/loaders/VRMLLoader.js'

/** Material as written in the VRML file (colours as sRGB hex). */
export interface VrmlMaterial {
  color: number
  emissive: number
  specular: number
  shininess: number     // VRML 0..1
  opacity: number
  unlit: boolean        // Shape without Appearance: VRML says black and unlit
}

export interface MergedGroup {
  material: VrmlMaterial
  position: Float32Array
  normal: Float32Array
  color: Float32Array | null   // per-vertex colours (linear), if the shapes had them
  index: Uint32Array
}

export interface MergedModel {
  groups: MergedGroup[]
  triangles: number
  shapes: number
  parseMs: number
  mergeMs: number
}

const tmpColor = new Color()
const hex = (c: Color | undefined): number => (c ? c.getHex(SRGBColorSpace) : 0)

function describe(m: Material): VrmlMaterial {
  const p = m as Material & { color?: Color; emissive?: Color; specular?: Color; shininess?: number; isMeshBasicMaterial?: boolean }
  return {
    color: hex(p.color),
    emissive: hex(p.emissive),
    specular: hex(p.specular),
    shininess: p.shininess ?? 0,
    opacity: m.transparent ? m.opacity : 1,
    unlit: p.isMeshBasicMaterial === true,
  }
}

interface Part { geometry: BufferGeometry; matrix: Mesh['matrixWorld']; flip: boolean }

export function parseAndMergeVrml(text: string, base: string): MergedModel {
  const t0 = performance.now()
  const root = new VRMLLoader().parse(text, base)
  const t1 = performance.now()
  root.updateMatrixWorld(true)

  // group meshes by material appearance (+ whether they carry vertex colours)
  const groups = new Map<string, { material: VrmlMaterial; parts: Part[]; vertices: number; indices: number; colored: boolean }>()
  let shapes = 0
  root.traverse(o => {
    if (!(o instanceof Mesh)) return
    const mat = Array.isArray(o.material) ? o.material[0] : o.material
    const g = o.geometry as BufferGeometry
    const pos = g.getAttribute('position')
    if (!mat || !pos || pos.count === 0) return
    shapes++
    if (!g.getAttribute('normal')) g.computeVertexNormals()
    const colored = (mat as Material & { vertexColors?: boolean }).vertexColors === true && !!g.getAttribute('color')
    const material = describe(mat)
    const key = `${material.color}|${material.emissive}|${material.specular}|${material.shininess}|${material.opacity}|${material.unlit}|${colored}`
    let group = groups.get(key)
    if (!group) { group = { material, parts: [], vertices: 0, indices: 0, colored }; groups.set(key, group) }
    group.parts.push({ geometry: g, matrix: o.matrixWorld, flip: o.matrixWorld.determinant() < 0 })
    group.vertices += pos.count
    group.indices += g.index ? g.index.count : pos.count
  })

  const out: MergedGroup[] = []
  const normalMatrix = new Matrix3()
  const v = new Vector3()
  let triangles = 0
  for (const group of groups.values()) {
    const position = new Float32Array(group.vertices * 3)
    const normal = new Float32Array(group.vertices * 3)
    const color = group.colored ? new Float32Array(group.vertices * 3) : null
    const index = new Uint32Array(group.indices)
    let vo = 0
    let io = 0
    for (const { geometry: g, matrix, flip } of group.parts) {
      const pos = g.getAttribute('position') as BufferAttribute
      const nor = g.getAttribute('normal') as BufferAttribute
      const col = color ? (g.getAttribute('color') as BufferAttribute) : null
      normalMatrix.getNormalMatrix(matrix)
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(matrix)
        position[(vo + i) * 3] = v.x; position[(vo + i) * 3 + 1] = v.y; position[(vo + i) * 3 + 2] = v.z
        v.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize()
        normal[(vo + i) * 3] = v.x; normal[(vo + i) * 3 + 1] = v.y; normal[(vo + i) * 3 + 2] = v.z
        if (col && color) {
          tmpColor.fromBufferAttribute(col, i)
          color[(vo + i) * 3] = tmpColor.r; color[(vo + i) * 3 + 1] = tmpColor.g; color[(vo + i) * 3 + 2] = tmpColor.b
        }
      }
      const n = g.index ? g.index.count : pos.count
      const src = g.index
      for (let i = 0; i < n; i += 3) {
        const a = src ? src.getX(i) : i
        const b = src ? src.getX(i + 1) : i + 1
        const c = src ? src.getX(i + 2) : i + 2
        // a mirroring transform reverses the winding: restore it so front faces stay front
        index[io + i] = vo + a
        index[io + i + 1] = vo + (flip ? c : b)
        index[io + i + 2] = vo + (flip ? b : c)
      }
      vo += pos.count
      io += n
    }
    triangles += index.length / 3
    out.push({ material: group.material, position, normal, color, index })
  }

  // the loader's objects are garbage now; release their geometry eagerly
  root.traverse(o => { if (o instanceof Mesh) (o.geometry as BufferGeometry).dispose() })
  return { groups: out, triangles, shapes, parseMs: t1 - t0, mergeMs: performance.now() - t1 }
}

/** Buffers to transfer (not copy) when posting a merged model between threads. */
export function transferables(m: MergedModel): ArrayBuffer[] {
  const list: ArrayBuffer[] = []
  for (const g of m.groups) {
    list.push(g.position.buffer as ArrayBuffer, g.normal.buffer as ArrayBuffer, g.index.buffer as ArrayBuffer)
    if (g.color) list.push(g.color.buffer as ArrayBuffer)
  }
  return list
}
