// [P2-d] Deep links: what the board page shows, as URL query parameters.
//
//   /board/<Name>?pane=layers&preset=back&side=back&view=120.5,108.7,4&net=GND
//
//   pane    the board page's open panes, comma-separated, in page order ("3d,layers",
//           "bom,assembly"); the legacy modes "split" (3D and the tab) and "layers" (the
//           tab alone) are still read
//   preset  a layer preset id ("front", "back", "copper", "all", "none"), or
//   layers  the visible layer ids, comma-separated ("F.Cu,F.SilkS,Edge.Cuts")
//   side    "back" for the mirrored view from the back (front is the default)
//   view    2D view: centre x,y in board mm and zoom relative to "fit"
//   cam     3D camera: target x,y,z, orientation quaternion x,y,z,w, view height, fov
//   net     highlighted net name
//   at      a marked point x,y in board mm (a DRC item), centred and zoomed to
//   tab     legacy, read only: the pane shown with pane=split / pane=layers ("schematic",
//           "bom", "assembly"); no longer written
//
// Worker (b)'s cross-probing uses the hash (#part=R12); these parameters never touch
// it. Pure functions, no imports: the tests run them under Node.

export type LinkSide = 'front' | 'back'

export interface ViewLink {
  pane?: string
  preset?: string
  layers?: string[]
  side?: LinkSide
  view?: { x: number; y: number; z: number }
  cam?: number[]
  net?: string
  at?: { x: number; y: number }
  tab?: string
}

export const LINK_KEYS = ['pane', 'preset', 'layers', 'side', 'view', 'cam', 'net', 'at', 'tab'] as const

type QueryValue = string | null | undefined | (string | null)[]
const first = (v: QueryValue): string | undefined => {
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' && s !== '' ? s : undefined
}
const nums = (s: string | undefined, n: number): number[] | undefined => {
  if (!s) return undefined
  const parts = s.split(',').map(Number)
  return parts.length === n && parts.every(Number.isFinite) ? parts : undefined
}
const fmt = (v: number, digits: number) => {
  const s = v.toFixed(digits).replace(/\.?0+$/, '')
  return s === '-0' ? '0' : s
}

/** Read a link from a route query (unknown or malformed parameters are ignored). */
export function parseViewLink(q: Record<string, QueryValue>): ViewLink {
  const l: ViewLink = {}
  const pane = first(q.pane)
  if (pane && /^[\w-]{1,32}(,[\w-]{1,32}){0,7}$/.test(pane)) l.pane = pane
  const preset = first(q.preset)
  if (preset && /^[\w-]{1,32}$/.test(preset)) l.preset = preset
  const layers = first(q.layers)
  if (layers !== undefined) l.layers = layers.split(',').map(s => s.trim()).filter(Boolean)
  else if (Array.isArray(q.layers) || q.layers === '') l.layers = []
  const side = first(q.side)
  if (side === 'front' || side === 'back') l.side = side
  const view = nums(first(q.view), 3)
  if (view && view[2]! > 0) l.view = { x: view[0]!, y: view[1]!, z: view[2]! }
  const cam = nums(first(q.cam), 9)
  if (cam) l.cam = cam
  const net = first(q.net)
  if (net) l.net = net
  const at = nums(first(q.at), 2)
  if (at) l.at = { x: at[0]!, y: at[1]! }
  const tab = first(q.tab)
  if (tab && /^[\w-]{1,32}$/.test(tab)) l.tab = tab
  return l
}

/** The query parameters of a link (only what is set), in a stable order. */
export function formatViewLink(l: ViewLink): Record<string, string> {
  const q: Record<string, string> = {}
  if (l.pane) q.pane = l.pane
  if (l.preset) q.preset = l.preset
  else if (l.layers) q.layers = l.layers.join(',')
  if (l.side) q.side = l.side
  if (l.view) q.view = `${fmt(l.view.x, 3)},${fmt(l.view.y, 3)},${fmt(l.view.z, 3)}`
  if (l.cam && l.cam.length === 9) q.cam = l.cam.map((v, i) => fmt(v, i >= 3 && i <= 6 ? 5 : 3)).join(',')
  if (l.net) q.net = l.net
  if (l.at) q.at = `${fmt(l.at.x, 3)},${fmt(l.at.y, 3)}`
  if (l.tab) q.tab = l.tab
  return q
}

/** The query without the link parameters (whatever else is there is kept as is). */
export function otherParams(q: Record<string, QueryValue>): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = {}
  for (const [k, v] of Object.entries(q)) if (!(LINK_KEYS as readonly string[]).includes(k)) out[k] = v
  return out
}
