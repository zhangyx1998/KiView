// Polarity / pin-1 detection for assembly mode (pure, no Vue): which pad of a placed
// footprint has to be oriented, and how to say it.
//
//   - Diodes and LEDs (two terminals): the cathode. Found by the pin function "K" /
//     "cathode" (of the pad, else of the symbol pin in the netlist), else as the other
//     pad of an "A" / "anode" pin, else pad 1 (KiCad's convention: pad 1 is the cathode
//     of every stock diode and LED footprint).
//   - Polarized capacitors, batteries: the "+" pad (pin function "+", else pad 1).
//   - Two-pin connectors and two-pin parts whose symbol pins are not passive: pin 1.
//   - Three or more numbered pads (ICs, networks, transistors, modules, connectors): pin 1
//     ("1", else "A1" for grid arrays).
//   - Other two-terminal parts (resistors, plain capacitors, inductors) and mechanical
//     footprints: none.
//
// The direction is where the pad lies from the part's centre in board coordinates
// (KiCad's front view: north up, east right; y grows south), e.g. "cathode W".

import type { Footprint, Pad } from '@kiview/kicad/types'

export type MarkKind = 'cathode' | 'plus' | 'pin1'
export type Compass = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW'

export interface Polarity {
  kind: MarkKind
  /** Pad number of the marked pad. */
  pad: string
  /** Centre of the marked pad (board mm); the marker goes there. */
  at: { x: number; y: number }
  /** Direction of the pad from the part's centre (board coordinates), or null when central. */
  dir: Compass | null
  /** How it was found. */
  source: 'pin-function' | 'pin-type' | 'pad-1'
  /** Short text for the step, e.g. "Cathode (pad 1) W". */
  label: string
}

/** Symbol pin facts by pad number (from the netlist: pinfunction / pintype). */
export type PinInfo = Map<string, { fn?: string; type?: string }>

/** "K_1" -> "K" (kicad-cli appends `_<pin>` to pin names in some netlists), upper-cased. */
export function pinName(fn: string | undefined, pad: string): string {
  if (!fn) return ''
  const s = fn.trim()
  const t = pad && s.endsWith(`_${pad}`) ? s.slice(0, -pad.length - 1) : s
  return t.toUpperCase()
}

const DIODE_REF = /^(D|LED|CR|ZD|TVS|VD)\d/i
const DIODE_FP = /(^|[:_\s-])(LED|Diode|D|SOD|SMA|SMB|SMC|MELF|MiniMELF|DO-?\d+)([_\s-]|\d|$)/i
const PCAP_FP = /(CP_|Elec|Tantal|Polarized|Polymer)/i
const PCAP_REF = /^(CP|C|BT|BAT)\d/i
/** Refs that are not diodes whatever the footprint is called (an IC in a SOD package, a jumper, ...). */
const NOT_DIODE_REF = /^(R|C|L|F|FB|U|IC|Q|J|P|CN|X|SW|K|Y|TP|JP)\d/i
const CONN_REF = /^(J|P|CN|CON|X|XS|XP|JP)\d/i
const CATHODE = new Set(['K', 'CATHODE', 'KATHODE'])
const ANODE = new Set(['A', 'ANODE'])

/** Copper pads with a number, one per number (the first; thermal / duplicate pads are ignored). */
export function numberedPads(fp: Footprint): Pad[] {
  const seen = new Set<string>()
  const out: Pad[] = []
  for (const p of fp.pads) {
    if (!p.number || p.type === 'np_thru_hole' || seen.has(p.number)) continue
    seen.add(p.number)
    out.push(p)
  }
  return out
}

const centre = (fp: Footprint) => ({ x: fp.bbox.x + fp.bbox.width / 2, y: fp.bbox.y + fp.bbox.height / 2 })

/** The direction as seen from the other side (east and west swap: the board is turned over). */
export function mirrored(d: Compass): Compass {
  return d.replace(/[EW]/g, c => (c === 'E' ? 'W' : 'E')) as Compass
}

/** Compass direction of (dx, dy) in board coordinates (y down); `four` for two-pad parts. */
export function compass(dx: number, dy: number, four = false, eps = 0.05): Compass | null {
  if (Math.hypot(dx, dy) < eps) return null
  if (four) return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N')
  const a = (Math.atan2(-dy, dx) * 180) / Math.PI   // 0 = east, counter-clockwise, north up
  const dirs: Compass[] = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE']
  return dirs[((Math.round(a / 45) % 8) + 8) % 8]!
}

/** Polarity of a placed footprint, or null when it has none to observe. */
export function detectPolarity(fp: Footprint, pins: PinInfo = new Map()): Polarity | null {
  const pads = numberedPads(fp)
  if (pads.length < 2) return null
  const fnOf = (p: Pad) => pinName(p.pinFunction ?? pins.get(p.number)?.fn, p.number)
  const typeOf = (p: Pad) => (p.pinType ?? pins.get(p.number)?.type ?? '').toLowerCase()
  const fns = pads.map(fnOf)
  const two = pads.length === 2
  const make = (kind: MarkKind, pad: Pad, source: Polarity['source']): Polarity => {
    const c = centre(fp)
    // relative to the other pads' centroid for two-pad parts (the box may be lopsided)
    const ref = two ? { x: (pads[0]!.at.x + pads[1]!.at.x) / 2, y: (pads[0]!.at.y + pads[1]!.at.y) / 2 } : c
    const dir = compass(pad.at.x - ref.x, pad.at.y - ref.y, two)
    const name = kind === 'cathode' ? 'Cathode' : kind === 'plus' ? '+' : 'Pin 1'
    const padText = kind === 'pin1' && pad.number === '1' ? '' : ` (pad ${pad.number})`
    return { kind, pad: pad.number, at: { x: pad.at.x, y: pad.at.y }, dir, source, label: `${name}${padText}${dir ? ` ${dir}` : ''}` }
  }
  const byNumber = (n: string) => pads.find(p => p.number === n)
  const fp1 = () => byNumber('1') ?? byNumber('A1') ?? null

  const footprintName = fp.footprint.slice(fp.footprint.indexOf(':') + 1)
  const hasDiodeFn = fns.some(f => CATHODE.has(f)) || fns.some(f => ANODE.has(f))
  const diodeLike = two && (DIODE_REF.test(fp.ref) || hasDiodeFn || (DIODE_FP.test(footprintName) && !NOT_DIODE_REF.test(fp.ref)))
  if (diodeLike) {
    const k = pads.find((_, i) => CATHODE.has(fns[i]!))
    if (k) return make('cathode', k, 'pin-function')
    const a = pads.findIndex((_, i) => ANODE.has(fns[i]!))
    if (a >= 0) return make('cathode', pads[1 - a]!, 'pin-function')
    const p1 = fp1()
    return p1 ? make('cathode', p1, 'pad-1') : null
  }

  const plusIdx = fns.findIndex(f => f === '+')
  const polarizedCap = two && PCAP_REF.test(fp.ref) && (PCAP_FP.test(footprintName) || plusIdx >= 0 || /^(CP|BT|BAT)\d/i.test(fp.ref))
  if (polarizedCap) {
    if (plusIdx >= 0) return make('plus', pads[plusIdx]!, 'pin-function')
    const minus = fns.findIndex(f => f === '-')
    if (minus >= 0) return make('plus', pads[1 - minus]!, 'pin-function')
    const p1 = fp1()
    return p1 ? make('plus', p1, 'pad-1') : null
  }

  if (two) {
    const p1 = fp1()
    if (!p1) return null
    if (CONN_REF.test(fp.ref)) return make('pin1', p1, 'pad-1')
    const types = pads.map(typeOf).filter(Boolean)
    if (types.length && types.some(t => t !== 'passive' && t !== 'unspecified' && t !== 'no_connect')) return make('pin1', p1, 'pin-type')
    return null
  }

  const p1 = fp1()
  return p1 ? make('pin1', p1, 'pad-1') : null
}
