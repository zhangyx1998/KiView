#!/usr/bin/env node
// Generates the sample projects in examples/boards/ that test version selection and
// the export contract (Blinky is hand-made in KiCad 10 and not touched here):
//
//   Legacy7    KiCad 7 file format (pcb 20221018, sch 20230121), 2 layers, flat schematic
//   Legacy8    KiCad 8 file format (pcb 20240108, sch 20231120), 2 layers, LED on the back
//   FourLayer  KiCad 9 file format (pcb 20241229, sch 20250114), 4 layers, GND and VIN
//              planes on the inner layers, vias into both planes
//   Hierarchy  KiCad 8 file format, 3-level hierarchy: root -> channels/channel.kicad_sch
//              (two instances) -> channels/led.kicad_sch, i.e. sheets in a sub-directory
//
// The files are written from s-expression templates, one profile per file-format
// version (header tokens, uuid vs tstamp, fp_text vs property, layer numbering,
// boolean style). Everything is deterministic: uuids are hashes of the board name and
// an item key, so re-running the script rewrites identical files.
//
// KiCad (any version that opens these formats, i.e. 9+ for FourLayer) is used for two
// things: the net names come from `kicad-cli sch export netlist` of the generated
// schematic (so the board matches the schematic exactly), and zone fills come from
// `kicad-cli pcb drc --refill-zones --save-board` on a scratch copy (the filled polygons
// are copied back into the template, which keeps its own format version).
//
//   node examples/scripts/generate-samples.mjs [--kicad-cli <path>] [--validate]
//
// --validate runs `pcb drc --schematic-parity`, `sch erc` and a layer SVG export on
// every generated sample and prints the violation counts.
//
// The generated design files are CC0 1.0 (public domain). Symbols and footprints are
// drawn here (they only resemble the stock 0805 / 2.54 mm parts), so nothing comes
// from the KiCad libraries except the 3D model paths, which the viewer resolves
// against the installed stock models.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const BOARDS = resolve(HERE, '../boards')

const { values: args } = parseArgs({
  options: { 'kicad-cli': { type: 'string' }, validate: { type: 'boolean' } },
})

function findCli() {
  const candidates = [args['kicad-cli'], process.env.KICAD_CLI,
    '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli', '/usr/bin/kicad-cli', '/usr/local/bin/kicad-cli']
  for (const c of candidates) if (c && existsSync(c)) return c
  return 'kicad-cli'
}
const CLI = findCli()
const kicad = (...a) => execFileSync(CLI, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// ===================================================================================
// File-format profiles
// ===================================================================================

const OLD_LAYERS = [
  [0, 'F.Cu', 'signal'], [1, 'In1.Cu', 'signal'], [2, 'In2.Cu', 'signal'], [31, 'B.Cu', 'signal'],
  [32, 'B.Adhes', 'user', 'B.Adhesive'], [33, 'F.Adhes', 'user', 'F.Adhesive'],
  [34, 'B.Paste', 'user'], [35, 'F.Paste', 'user'],
  [36, 'B.SilkS', 'user', 'B.Silkscreen'], [37, 'F.SilkS', 'user', 'F.Silkscreen'],
  [38, 'B.Mask', 'user'], [39, 'F.Mask', 'user'],
  [40, 'Dwgs.User', 'user', 'User.Drawings'], [41, 'Cmts.User', 'user', 'User.Comments'],
  [42, 'Eco1.User', 'user', 'User.Eco1'], [43, 'Eco2.User', 'user', 'User.Eco2'],
  [44, 'Edge.Cuts', 'user'], [45, 'Margin', 'user'],
  [46, 'B.CrtYd', 'user', 'B.Courtyard'], [47, 'F.CrtYd', 'user', 'F.Courtyard'],
  [48, 'B.Fab', 'user'], [49, 'F.Fab', 'user'],
]
// KiCad 9 renumbered the layers (copper even, F.Cu 0, B.Cu 2, In<n>.Cu 2n+2; tech odd)
const NEW_LAYERS = [
  [0, 'F.Cu', 'signal'], [4, 'In1.Cu', 'signal'], [6, 'In2.Cu', 'signal'], [2, 'B.Cu', 'signal'],
  [9, 'F.Adhes', 'user', 'F.Adhesive'], [11, 'B.Adhes', 'user', 'B.Adhesive'],
  [13, 'F.Paste', 'user'], [15, 'B.Paste', 'user'],
  [5, 'F.SilkS', 'user', 'F.Silkscreen'], [7, 'B.SilkS', 'user', 'B.Silkscreen'],
  [1, 'F.Mask', 'user'], [3, 'B.Mask', 'user'],
  [17, 'Dwgs.User', 'user', 'User.Drawings'], [19, 'Cmts.User', 'user', 'User.Comments'],
  [21, 'Eco1.User', 'user', 'User.Eco1'], [23, 'Eco2.User', 'user', 'User.Eco2'],
  [25, 'Edge.Cuts', 'user'], [27, 'Margin', 'user'],
  [31, 'F.CrtYd', 'user', 'F.Courtyard'], [29, 'B.CrtYd', 'user', 'B.Courtyard'],
  [35, 'F.Fab', 'user'], [33, 'B.Fab', 'user'],
]

/**
 * What differs between the formats we write. Only tokens that KiCad of that major
 * writes itself are used, so the oldest version that should open a file can.
 */
const FORMATS = {
  7: {
    major: 7, pcb: 20221018, sch: 20230121, generatorVersion: null, id: 'tstamp', fpText: true,
    boolHide: false, simFlags: false, sheetFlags: false, layers: OLD_LAYERS, embeddedFonts: false,
  },
  8: {
    major: 8, pcb: 20240108, sch: 20231120, generatorVersion: '8.0', id: 'uuid', fpText: false,
    boolHide: true, simFlags: true, sheetFlags: false, layers: OLD_LAYERS, embeddedFonts: false,
  },
  9: {
    major: 9, pcb: 20241229, sch: 20250114, generatorVersion: '9.0', id: 'uuid', fpText: false,
    boolHide: true, simFlags: true, sheetFlags: true, layers: NEW_LAYERS, embeddedFonts: true,
  },
}

// ===================================================================================
// S-expressions
// ===================================================================================

/** A quoted string atom. */
class Q { constructor(s) { this.s = s } }
const q = s => new Q(String(s))
const num = n => {
  const r = Math.round(n * 1e4) / 1e4
  return Object.is(r, -0) ? '0' : String(r)
}
function atom(a) {
  if (a instanceof Q) return `"${a.s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  if (typeof a === 'number') return num(a)
  return a
}
/** KiCad-like layout: a node with only atoms on one line, else one child per line. */
function serialize(node, indent = '') {
  const [head, ...rest] = node
  const lead = []
  let i = 0
  for (; i < rest.length && !Array.isArray(rest[i]); i++) lead.push(atom(rest[i]))
  const first = `${indent}(${[head, ...lead].join(' ')}`
  if (i === rest.length) return `${first})`
  const inner = indent + '\t'
  const lines = [first]
  for (; i < rest.length; i++) {
    const c = rest[i]
    if (c === null || c === undefined) continue
    lines.push(Array.isArray(c) ? serialize(c, inner) : inner + atom(c))
  }
  return `${lines.join('\n')}\n${indent})`
}
/** Drops null children (optional tokens) recursively. */
const clean = n => Array.isArray(n) ? n.filter(c => c !== null && c !== undefined).map(clean) : n

/** Minimal parser (for reading back netlists and zone fills). */
function parse(text) {
  let i = 0
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++ }
  function value() {
    ws()
    if (text[i] === '(') {
      i++
      const list = []
      for (;;) {
        ws()
        if (text[i] === ')') { i++; return list }
        list.push(value())
      }
    }
    if (text[i] === '"') {
      let s = ''
      i++
      while (text[i] !== '"') { if (text[i] === '\\') i++; s += text[i++] }
      i++
      return new Q(s)
    }
    const start = i
    while (i < text.length && !/[\s()]/.test(text[i])) i++
    return text.slice(start, i)
  }
  return value()
}
const str = a => (a instanceof Q ? a.s : a)
const kids = (n, head) => n.filter(c => Array.isArray(c) && c[0] === head)
const kid = (n, head) => kids(n, head)[0]

// ===================================================================================
// Ids
// ===================================================================================

function uuidFor(...key) {
  const h = createHash('sha256').update(key.join('\0')).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// ===================================================================================
// Schematic side
// ===================================================================================

const font = (size = 1.27) => ['font', ['size', size, size]]

/** Library symbols (y up), drawn here. pins: [number, name, x, y, angle, length]. */
const SYMBOLS = {
  R: {
    ref: 'R', pins: [['1', '~', 0, 3.81, 270, 1.27], ['2', '~', 0, -3.81, 90, 1.27]],
    body: [['rectangle', ['start', -1.016, 2.54], ['end', 1.016, -2.54], ['stroke', ['width', 0.254], ['type', 'default']], ['fill', ['type', 'none']]]],
    refAt: [2.54, 1.27], valAt: [2.54, -1.27],
  },
  C: {
    ref: 'C', pins: [['1', '~', 0, 3.81, 270, 2.794], ['2', '~', 0, -3.81, 90, 2.794]],
    body: [
      ['polyline', ['pts', ['xy', -2.032, 0.762], ['xy', 2.032, 0.762]], ['stroke', ['width', 0.508], ['type', 'default']], ['fill', ['type', 'none']]],
      ['polyline', ['pts', ['xy', -2.032, -0.762], ['xy', 2.032, -0.762]], ['stroke', ['width', 0.508], ['type', 'default']], ['fill', ['type', 'none']]],
    ],
    refAt: [3.048, 1.27], valAt: [3.048, -1.27],
  },
  LED: {
    ref: 'D', pins: [['1', 'K', -3.81, 0, 0, 2.54], ['2', 'A', 3.81, 0, 180, 2.54]],
    body: [
      ['polyline', ['pts', ['xy', 1.27, -1.27], ['xy', 1.27, 1.27], ['xy', -1.27, 0], ['xy', 1.27, -1.27]], ['stroke', ['width', 0.254], ['type', 'default']], ['fill', ['type', 'none']]],
      ['polyline', ['pts', ['xy', -1.27, -1.27], ['xy', -1.27, 1.27]], ['stroke', ['width', 0.254], ['type', 'default']], ['fill', ['type', 'none']]],
    ],
    refAt: [0, 2.54], valAt: [0, -2.54],
  },
  Conn_01x02: {
    ref: 'J', pins: [['1', 'Pin_1', -5.08, 0, 0, 3.81], ['2', 'Pin_2', -5.08, -2.54, 0, 3.81]],
    body: [['rectangle', ['start', -1.27, 1.27], ['end', 1.27, -3.81], ['stroke', ['width', 0.254], ['type', 'default']], ['fill', ['type', 'background']]]],
    refAt: [0, 2.54], valAt: [0, -5.08],
  },
}

const hideTok = f => (f.boolHide ? ['hide', 'yes'] : 'hide')
const effects = (f, { hide = false, justify = null, size = 1.27 } = {}) =>
  ['effects', font(size), justify ? ['justify', ...justify.split(' ')] : null, hide ? hideTok(f) : null]

function libSymbol(f, name) {
  const s = SYMBOLS[name]
  const prop = (k, v, at, hide = false) => ['property', q(k), q(v), ['at', ...at, 0], effects(f, { hide })]
  return ['symbol', q(`Samples:${name}`),
    ['pin_names', ['offset', 0]],
    f.simFlags ? ['exclude_from_sim', 'no'] : null,
    ['in_bom', 'yes'], ['on_board', 'yes'],
    prop('Reference', s.ref, s.refAt), prop('Value', name, s.valAt),
    prop('Footprint', '', [0, 0], true), prop('Datasheet', '', [0, 0], true),
    ['symbol', q(`${name}_0_1`), ...s.body],
    ['symbol', q(`${name}_1_1`), ...s.pins.map(([n, label, x, y, a, len]) =>
      ['pin', 'passive', 'line', ['at', x, y, a], ['length', len],
        ['name', q(label), effects(f)], ['number', q(n), effects(f)]])],
    f.embeddedFonts ? ['embedded_fonts', 'no'] : null,
  ]
}

/** Unit vector of a pin's outward direction, in schematic coordinates (y down). */
function outward(angle) {
  const a = (angle * Math.PI) / 180
  // the pin points from its connection point into the body; outward is the opposite
  return [-Math.round(Math.cos(a)), Math.round(Math.sin(a))]
}
const labelAngle = ([dx, dy]) => (dx > 0 ? 0 : dx < 0 ? 180 : dy < 0 ? 90 : 270)
const labelJustify = a => (a === 0 || a === 90 ? 'left bottom' : 'right bottom')
const portJustify = a => (a === 0 || a === 90 ? 'left' : 'right')

/**
 * One schematic file. parts: { sym, value, footprint, at:[x,y], key, pins:{num:net},
 * refs:{instancePath: ref} }; sheets: { key, name, file, at, size, pins: [[name, net]] };
 * ports: names of this sheet's hierarchical labels (a net with a port name ends in a
 * hierarchical label instead of a local one).
 */
function schematicFile(f, board, file) {
  const id = (...k) => uuidFor(board.name, file.path, ...k)
  const items = []
  const wireTo = (key, [x, y], dir, net) => {
    const end = [x + dir[0] * 2.54, y + dir[1] * 2.54]
    items.push(['wire', ['pts', ['xy', x, y], ['xy', ...end]], ['stroke', ['width', 0], ['type', 'default']], ['uuid', q(id('wire', key))]])
    const ang = labelAngle(dir)
    if ((file.ports ?? []).includes(net))
      items.push(['hierarchical_label', q(net), ['shape', 'passive'], ['at', ...end, ang],
        effects(f, { justify: portJustify(ang) }), ['uuid', q(id('port', key))]])
    else
      items.push(['label', q(net), ['at', ...end, ang], effects(f, { justify: labelJustify(ang) }), ['uuid', q(id('label', key))]])
  }

  const used = [...new Set((file.parts ?? []).map(p => p.sym))]
  const symbols = []
  for (const p of file.parts ?? []) {
    const s = SYMBOLS[p.sym]
    const [sx, sy] = p.at
    const prop = (k, v, at, o) => ['property', q(k), q(v), ['at', ...at, 0], effects(f, o)]
    const firstRef = Object.values(p.refs)[0]
    for (const [num, , px, py, a] of s.pins) wireTo(`${p.key}.${num}`, [sx + px, sy - py], outward(a), p.pins[num])
    symbols.push(['symbol',
      ['lib_id', q(`Samples:${p.sym}`)], ['at', sx, sy, 0], ['unit', 1],
      f.simFlags ? ['exclude_from_sim', 'no'] : null,
      ['in_bom', 'yes'], ['on_board', 'yes'], ['dnp', 'no'],
      ['uuid', q(p.uuid)],
      prop('Reference', firstRef, [sx + s.refAt[0], sy - s.refAt[1]], { justify: s.refAt[0] ? 'left' : null }),
      prop('Value', p.value, [sx + s.valAt[0], sy - s.valAt[1]], { justify: s.valAt[0] ? 'left' : null }),
      prop('Footprint', `Samples:${p.footprint}`, [sx, sy], { hide: true }),
      prop('Datasheet', '', [sx, sy], { hide: true }),
      ...s.pins.map(([num]) => ['pin', q(num), ['uuid', q(id('pin', p.key, num))]]),
      ['instances', ['project', q(board.name),
        ...Object.entries(p.refs).map(([path, ref]) => ['path', q(path), ['reference', q(ref)], ['unit', 1]])]],
    ])
  }

  const sheets = []
  for (const sh of file.sheets ?? []) {
    const [x, y] = sh.at
    const pins = sh.pins.map(([name, net], i) => {
      const py = y + 2.54 * (i + 1)
      wireTo(`${sh.key}.${name}`, [x, py], [-1, 0], net)
      return ['pin', q(name), 'passive', ['at', x, py, 180], ['uuid', q(id('sheetpin', sh.key, name))], effects(f, { justify: 'left' })]
    })
    sheets.push(['sheet', ['at', x, y], ['size', ...sh.size],
      ...(f.sheetFlags ? [['exclude_from_sim', 'no'], ['in_bom', 'yes'], ['on_board', 'yes'], ['dnp', 'no']] : []),
      ['stroke', ['width', 0.1524], ['type', 'solid']], ['fill', ['color', 0, 0, 0, 0]],
      ['uuid', q(sh.uuid)],
      ['property', q('Sheetname'), q(sh.name), ['at', x, y - 0.7116, 0], effects(f, { justify: 'left bottom' })],
      ['property', q('Sheetfile'), q(sh.file), ['at', x, y + sh.size[1] + 0.5846, 0], effects(f, { justify: 'left top' })],
      ...pins,
      ['instances', ['project', q(board.name), ...Object.entries(sh.pages).map(([path, page]) => ['path', q(path), ['page', q(page)]])]],
    ])
  }

  const tree = ['kicad_sch', ['version', f.sch],
    ['generator', f.generatorVersion ? q('eeschema') : 'eeschema'],
    f.generatorVersion ? ['generator_version', q(f.generatorVersion)] : null,
    ['uuid', q(file.uuid)],
    ['paper', q('A4')],
    titleBlock(board, file.title),
    ['lib_symbols', ...used.map(n => libSymbol(f, n))],
    file.note ? ['text', q(file.note), ['at', 30.48, 25.4, 0], effects(f, { justify: 'left bottom' }), ['uuid', q(id('note'))]] : null,
    ...items, ...symbols, ...sheets,
    file.root ? ['sheet_instances', ['path', q('/'), ['page', q('1')]]] : null,
    f.embeddedFonts ? ['embedded_fonts', 'no'] : null,
  ]
  return serialize(clean(tree)) + '\n'
}

function titleBlock(board, title) {
  return ['title_block', ['title', q(title ?? board.name)], ['date', q('2026-10-09')], ['rev', q('A')],
    ['company', q('KiView samples (CC0 1.0)')], ['comment', 1, q(board.comment)]]
}

// ===================================================================================
// Board side
// ===================================================================================

/** Footprints (front side, local coordinates). */
const FOOTPRINTS = {
  R_0805: {
    attr: 'smd', model: 'Resistor_SMD.3dshapes/R_0805_2012Metric.wrl',
    pads: [['1', -0.9125, 0], ['2', 0.9125, 0]].map(([n, x, y]) => ({ n, x, y, kind: 'smd', shape: 'roundrect', size: [1.025, 1.4], rratio: 0.243902 })),
    silk: [[[-0.227, -0.735], [0.227, -0.735]], [[-0.227, 0.735], [0.227, 0.735]]],
    fab: [-1, -0.625, 1, 0.625], crtyd: [-1.68, -0.95, 1.68, 0.95], refY: -1.65,
  },
  C_0805: {
    attr: 'smd', model: 'Capacitor_SMD.3dshapes/C_0805_2012Metric.wrl',
    pads: [['1', -0.95, 0], ['2', 0.95, 0]].map(([n, x, y]) => ({ n, x, y, kind: 'smd', shape: 'roundrect', size: [1, 1.45], rratio: 0.25 })),
    silk: [[[-0.261, -0.735], [0.261, -0.735]], [[-0.261, 0.735], [0.261, 0.735]]],
    fab: [-1, -0.625, 1, 0.625], crtyd: [-1.7, -0.98, 1.7, 0.98], refY: -1.68,
  },
  LED_0805: {
    attr: 'smd', model: 'LED_SMD.3dshapes/LED_0805_2012Metric.wrl',
    pads: [['1', -0.9375, 0], ['2', 0.9375, 0]].map(([n, x, y]) => ({ n, x, y, kind: 'smd', shape: 'roundrect', size: [0.975, 1.4], rratio: 0.25 })),
    silk: [[[1, -0.96], [-1.685, -0.96]], [[-1.685, -0.96], [-1.685, 0.96]], [[-1.685, 0.96], [1, 0.96]]],
    fab: [-1, -0.6, 1, 0.6], crtyd: [-1.68, -0.95, 1.68, 0.95], refY: -1.65,
  },
  PinHeader_1x02: {
    attr: 'through_hole', model: 'Connector_PinHeader_2.54mm.3dshapes/PinHeader_1x02_P2.54mm_Vertical.wrl',
    pads: [
      { n: '1', x: 0, y: 0, kind: 'thru_hole', shape: 'rect', size: [1.7, 1.7], drill: 1 },
      { n: '2', x: 0, y: 2.54, kind: 'thru_hole', shape: 'oval', size: [1.7, 1.7], drill: 1 },
    ],
    silk: [[[-1.33, 3.87], [1.33, 3.87]], [[-1.33, 1.27], [-1.33, 3.87]], [[1.33, 1.27], [1.33, 3.87]], [[-1.33, 1.27], [1.33, 1.27]], [[-1.33, 0], [-1.33, -1.33]], [[-1.33, -1.33], [0, -1.33]]],
    fab: [-1.27, -1.27, 1.27, 3.81], crtyd: [-1.8, -1.8, 1.8, 4.35], refY: -2.33,
  },
}

const flipLayer = l => l.replace(/^F\./, 'X.').replace(/^B\./, 'F.').replace(/^X\./, 'B.')

function footprint(f, board, fp, padNet) {
  const def = FOOTPRINTS[fp.fp]
  const back = fp.side === 'back'
  const L = l => (back ? flipLayer(l) : l)
  const X = x => (back ? -x : x)
  const id = (...k) => [f.id, q(uuidFor(board.name, 'fp', fp.ref, ...k))]
  const line = (key, [a, b], layer, width) =>
    ['fp_line', ['start', X(a[0]), a[1]], ['end', X(b[0]), b[1]], ['stroke', ['width', width], ['type', 'solid']], ['layer', q(L(layer))], id('line', key)]
  const rect = (key, [x1, y1, x2, y2], layer, width) => [
    line(`${key}a`, [[x1, y1], [x2, y1]], layer, width), line(`${key}b`, [[x2, y1], [x2, y2]], layer, width),
    line(`${key}c`, [[x2, y2], [x1, y2]], layer, width), line(`${key}d`, [[x1, y2], [x1, y1]], layer, width)]
  const textEffects = ['effects', ['font', ['size', 1, 1], ['thickness', 0.15]], back ? ['justify', 'mirror'] : null]
  const fieldsOld = [
    ['fp_text', 'reference', q(fp.ref), ['at', 0, def.refY], ['layer', q(L('F.SilkS'))], textEffects, id('ref')],
    ['fp_text', 'value', q(fp.value), ['at', 0, -def.refY + (def.fab[3] > 1 ? 2.54 : 0)], ['layer', q(L('F.Fab'))], textEffects, id('val')],
  ]
  const fieldsNew = [
    ['property', q('Reference'), q(fp.ref), ['at', 0, def.refY, 0], ['layer', q(L('F.SilkS'))], id('ref'), textEffects],
    ['property', q('Value'), q(fp.value), ['at', 0, -def.refY + (def.fab[3] > 1 ? 2.54 : 0), 0], ['layer', q(L('F.Fab'))], id('val'), textEffects],
  ]
  const pads = def.pads.map(p => {
    const net = padNet(fp.ref, p.n)
    const layers = p.kind === 'smd' ? ['F.Cu', 'F.Paste', 'F.Mask'].map(L) : ['*.Cu', '*.Mask']
    return ['pad', q(p.n), p.kind, p.shape, ['at', X(p.x), p.y], ['size', ...p.size],
      p.drill ? ['drill', p.drill] : null,
      ['layers', ...layers.map(q)],
      p.rratio ? ['roundrect_rratio', p.rratio] : null,
      net ? ['net', net.code, q(net.name)] : null,
      ['pintype', q('passive')],
      id('pad', p.n)]
  })
  return ['footprint', q(`Samples:${fp.fp}`), ['layer', q(back ? 'B.Cu' : 'F.Cu')], id(),
    ['at', fp.at[0], fp.at[1]],
    ...(f.fpText ? [] : fieldsNew),
    ['path', q(fp.path)],
    ['attr', def.attr],
    ...(f.fpText ? fieldsOld : []),
    ...def.silk.map((s, i) => line(`silk${i}`, s, 'F.SilkS', 0.12)),
    ...rect('fab', def.fab, 'F.Fab', 0.1),
    ...rect('crtyd', def.crtyd, 'F.CrtYd', 0.05),
    ...pads,
    f.embeddedFonts ? ['embedded_fonts', 'no'] : null,
    ['model', q(`\${KICAD${f.major}_3DMODEL_DIR}/${def.model}`),
      ['offset', ['xyz', 0, 0, 0]], ['scale', ['xyz', 1, 1, 1]], ['rotate', ['xyz', 0, 0, back ? 180 : 0]]],
  ]
}

function stackup(board) {
  const copper = board.copper
  const inner = copper - 2
  const core = (1.6 - copper * 0.035 - 0.02 - (inner ? 2 * 0.2 : 0))
  const L = []
  L.push(['layer', q('F.SilkS'), ['type', q('Top Silk Screen')], ['color', q('White')]])
  L.push(['layer', q('F.Paste'), ['type', q('Top Solder Paste')]])
  L.push(['layer', q('F.Mask'), ['type', q('Top Solder Mask')], ['color', q(board.mask)], ['thickness', 0.01]])
  L.push(['layer', q('F.Cu'), ['type', q('copper')], ['thickness', 0.035]])
  const diel = (n, type, t) => ['layer', q(`dielectric ${n}`), ['type', q(type)], ['thickness', t], ['material', q('FR4')], ['epsilon_r', 4.5], ['loss_tangent', 0.02]]
  if (inner) {
    L.push(diel(1, 'prepreg', 0.2))
    L.push(['layer', q('In1.Cu'), ['type', q('copper')], ['thickness', 0.035]])
    L.push(diel(2, 'core', core))
    L.push(['layer', q('In2.Cu'), ['type', q('copper')], ['thickness', 0.035]])
    L.push(diel(3, 'prepreg', 0.2))
  } else {
    L.push(diel(1, 'core', core))
  }
  L.push(['layer', q('B.Cu'), ['type', q('copper')], ['thickness', 0.035]])
  L.push(['layer', q('B.Mask'), ['type', q('Bottom Solder Mask')], ['color', q(board.mask)], ['thickness', 0.01]])
  L.push(['layer', q('B.Paste'), ['type', q('Bottom Solder Paste')]])
  L.push(['layer', q('B.SilkS'), ['type', q('Bottom Silk Screen')], ['color', q('White')]])
  return ['stackup', ...L, ['copper_finish', q(board.finish)], ['dielectric_constraints', 'no']]
}

function pcbFile(f, board, nets, fills) {
  const copperNames = board.copper === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu']
  const layers = f.layers.filter(([, n]) => !/^In\d/.test(n) || copperNames.includes(n))
  const tid = (...k) => [f.id, q(uuidFor(board.name, ...k))]
  const netRef = name => {
    const n = nets.byName.get(name)
    if (!n) throw new Error(`${board.name}: unknown net ${name}`)
    return n.code
  }
  const padNet = (ref, pad) => nets.byPad.get(`${ref}.${pad}`) ?? null

  const [x0, y0, x1, y1] = board.outline
  const edges = [[[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]]
  const items = []
  edges.forEach(([a, b], i) => items.push(['gr_line', ['start', ...a], ['end', ...b], ['stroke', ['width', 0.1], ['type', 'default']], ['layer', q('Edge.Cuts')], tid('edge', i)]))
  for (const [i, t] of (board.texts ?? []).entries()) {
    const back = t.layer.startsWith('B.')
    items.push(['gr_text', q(t.text), ['at', ...t.at, 0], ['layer', q(t.layer)], tid('text', i),
      ['effects', ['font', ['size', t.size ?? 1, t.size ?? 1], ['thickness', 0.15]], back ? ['justify', 'mirror'] : null]])
  }
  for (const fp of board.footprints) items.push(footprint(f, board, fp, padNet))
  for (const [i, [net, layer, pts]] of board.tracks.entries())
    for (let j = 0; j + 1 < pts.length; j++)
      items.push(['segment', ['start', ...pts[j]], ['end', ...pts[j + 1]], ['width', board.track ?? 0.25], ['layer', q(layer)], ['net', netRef(net)], tid('seg', i, j)])
  for (const [i, [net, at]] of board.vias.entries())
    items.push(['via', ['at', ...at], ['size', 0.6], ['drill', 0.3], ['layers', q('F.Cu'), q('B.Cu')], ['net', netRef(net)], tid('via', i)])
  for (const [i, z] of (board.zones ?? []).entries()) {
    const zid = uuidFor(board.name, 'zone', i)
    items.push(['zone', ['net', netRef(z.net)], ['net_name', q(nets.byName.get(z.net).name)], ['layer', q(z.layer)],
      [f.id, q(zid)], ['name', q(z.net)], ['hatch', 'edge', 0.5],
      ['connect_pads', ['clearance', 0.3]], ['min_thickness', 0.25], ['filled_areas_thickness', 'no'],
      ['fill', 'yes', ['thermal_gap', 0.5], ['thermal_bridge_width', 0.5]],
      ['polygon', ['pts', ...z.pts.map(p => ['xy', ...p])]],
      ...(fills?.get(zid) ?? [])])
  }

  const tree = ['kicad_pcb', ['version', f.pcb],
    ['generator', f.generatorVersion ? q('pcbnew') : 'pcbnew'],
    f.generatorVersion ? ['generator_version', q(f.generatorVersion)] : null,
    ['general', ['thickness', 1.6]],
    ['paper', q('A4')],
    titleBlock(board),
    ['layers', ...layers.map(([n, name, type, user]) => [n, q(name), type, user ? q(user) : null])],
    ['setup', stackup(board), ['pad_to_mask_clearance', 0]],
    ...nets.list.map(n => ['net', n.code, q(n.name)]),
    ...items,
    f.embeddedFonts ? ['embedded_fonts', 'no'] : null,
  ]
  return serialize(clean(tree)) + '\n'
}

function projectFile(board, sheets) {
  return JSON.stringify({
    meta: { filename: `${board.name}.kicad_pro`, version: 1 },
    sheets,
    text_variables: {},
  }, null, 2) + '\n'
}

// ===================================================================================
// The samples
// ===================================================================================

const rootId = name => uuidFor(name, 'root-sheet')
const symId = (name, key) => uuidFor(name, 'symbol', key)

/** A flat one-sheet project: J1 feeds VIN/GND, R1 + D1 (+ caps). */
function flatSchematic(name, extraParts = [], note) {
  const root = rootId(name)
  const parts = [
    { key: 'J1', sym: 'Conn_01x02', value: 'VIN', footprint: 'PinHeader_1x02', at: [50.8, 76.2], pins: { 1: 'VIN', 2: 'GND' } },
    { key: 'R1', sym: 'R', value: '330', footprint: 'R_0805', at: [76.2, 76.2], pins: { 1: 'VIN', 2: 'LED_A' } },
    { key: 'D1', sym: 'LED', value: 'red', footprint: 'LED_0805', at: [101.6, 76.2], pins: { 1: 'GND', 2: 'LED_A' } },
    ...extraParts,
  ].map(p => ({ ...p, uuid: symId(name, p.key), refs: { [`/${root}`]: p.key } }))
  return {
    files: [{ path: `${name}.kicad_sch`, root: true, uuid: root, parts, note }],
    sheetList: [[root, 'Root']],
    paths: Object.fromEntries(parts.map(p => [p.key, `/${p.uuid}`])),
  }
}

/** The 3-level hierarchy: root -> 2 x channels/channel.kicad_sch -> channels/led.kicad_sch. */
function hierarchySchematic(name) {
  const root = rootId(name)
  const chA = uuidFor(name, 'sheet', 'chA')
  const chB = uuidFor(name, 'sheet', 'chB')
  const led = uuidFor(name, 'sheet', 'led')   // the same sheet symbol in both channel instances
  const rUuid = symId(name, 'R')
  const dUuid = symId(name, 'D')
  const jUuid = symId(name, 'J1')
  return {
    files: [
      {
        path: `${name}.kicad_sch`, root: true, uuid: root,
        note: 'Hierarchy sample: two instances of channels/channel.kicad_sch, each with channels/led.kicad_sch inside.',
        parts: [{ key: 'J1', uuid: jUuid, sym: 'Conn_01x02', value: 'VIN', footprint: 'PinHeader_1x02', at: [50.8, 76.2], pins: { 1: 'VIN', 2: 'GND' }, refs: { [`/${root}`]: 'J1' } }],
        sheets: [
          { key: 'chA', uuid: chA, name: 'Channel A', file: 'channels/channel.kicad_sch', at: [88.9, 63.5], size: [25.4, 10.16], pins: [['VIN', 'VIN'], ['GND', 'GND']], pages: { [`/${root}`]: '2' } },
          { key: 'chB', uuid: chB, name: 'Channel B', file: 'channels/channel.kicad_sch', at: [88.9, 88.9], size: [25.4, 10.16], pins: [['VIN', 'VIN'], ['GND', 'GND']], pages: { [`/${root}`]: '4' } },
        ],
      },
      {
        path: 'channels/channel.kicad_sch', uuid: uuidFor(name, 'file', 'channel'), title: 'Channel', ports: ['VIN', 'GND'],
        parts: [{ key: 'R', uuid: rUuid, sym: 'R', value: '330', footprint: 'R_0805', at: [63.5, 76.2], pins: { 1: 'VIN', 2: 'LED_A' },
          refs: { [`/${root}/${chA}`]: 'R1', [`/${root}/${chB}`]: 'R2' } }],
        sheets: [{ key: 'led', uuid: led, name: 'LED', file: 'led.kicad_sch', at: [88.9, 76.2], size: [20.32, 10.16], pins: [['A', 'LED_A'], ['K', 'GND']],
          pages: { [`/${root}/${chA}`]: '3', [`/${root}/${chB}`]: '5' } }],
      },
      {
        path: 'channels/led.kicad_sch', uuid: uuidFor(name, 'file', 'led'), title: 'LED', ports: ['A', 'K'],
        parts: [{ key: 'D', uuid: dUuid, sym: 'LED', value: 'green', footprint: 'LED_0805', at: [76.2, 76.2], pins: { 1: 'K', 2: 'A' },
          refs: { [`/${root}/${chA}/${led}`]: 'D1', [`/${root}/${chB}/${led}`]: 'D2' } }],
      },
    ],
    sheetList: [[root, 'Root'], [chA, 'Channel A'], [led, 'LED'], [chB, 'Channel B']],
    paths: { J1: `/${jUuid}`, R1: `/${chA}/${rUuid}`, R2: `/${chB}/${rUuid}`, D1: `/${chA}/${led}/${dUuid}`, D2: `/${chB}/${led}/${dUuid}` },
  }
}

const SAMPLES = [
  {
    name: 'Legacy7', format: 7, copper: 2, mask: 'Green', finish: 'HAL SnPb',
    comment: 'KiCad 7 file format (pcb 20221018, sch 20230121)',
    readme: 'a KiCad 7 format project (board `20221018`, schematic `20230121`): 2 layers, a header, a 330 R and an LED, routed on both layers',
    outline: [100, 100, 130, 120],
    schematic: n => flatSchematic(n, [], 'Legacy7: written in the KiCad 7 file format.'),
    footprints: [
      { ref: 'J1', fp: 'PinHeader_1x02', value: 'VIN', at: [105, 108.73] },
      { ref: 'R1', fp: 'R_0805', value: '330', at: [115, 108.73] },
      { ref: 'D1', fp: 'LED_0805', value: 'red', at: [121, 114] },
    ],
    tracks: [
      ['VIN', 'F.Cu', [[105, 108.73], [114.0875, 108.73]]],
      ['LED_A', 'F.Cu', [[115.9125, 108.73], [117, 108.73], [117, 106], [124, 106], [124, 114], [121.9375, 114]]],
      ['GND', 'F.Cu', [[120.0625, 114], [118.5, 114]]],
      ['GND', 'B.Cu', [[118.5, 114], [105, 114], [105, 111.27]]],
    ],
    vias: [['GND', [118.5, 114]]],
    texts: [{ text: 'Legacy7 (KiCad 7 format)', at: [115, 102.5], layer: 'F.SilkS' }],
  },
  {
    name: 'Legacy8', format: 8, copper: 2, mask: 'Black', finish: 'ENIG',
    comment: 'KiCad 8 file format (pcb 20240108, sch 20231120)',
    readme: 'a KiCad 8 format project (board `20240108`, schematic `20231120`): 2 layers, black mask, the LED on the back side',
    outline: [100, 100, 130, 120],
    schematic: n => flatSchematic(n, [], 'Legacy8: written in the KiCad 8 file format; D1 sits on the back.'),
    footprints: [
      { ref: 'J1', fp: 'PinHeader_1x02', value: 'VIN', at: [105, 108.73] },
      { ref: 'R1', fp: 'R_0805', value: '330', at: [115, 108.73] },
      { ref: 'D1', fp: 'LED_0805', value: 'red', at: [121, 114], side: 'back' },
    ],
    tracks: [
      ['VIN', 'F.Cu', [[105, 108.73], [114.0875, 108.73]]],
      ['LED_A', 'F.Cu', [[115.9125, 108.73], [118, 108.73]]],
      ['LED_A', 'B.Cu', [[118, 108.73], [118, 114], [120.0625, 114]]],
      ['GND', 'B.Cu', [[121.9375, 114], [124, 114], [124, 117], [105, 117], [105, 111.27]]],
    ],
    vias: [['LED_A', [118, 108.73]]],
    texts: [
      { text: 'Legacy8 (KiCad 8 format)', at: [115, 102.5], layer: 'F.SilkS' },
      { text: 'LED on this side', at: [115, 104.5], layer: 'B.SilkS' },
    ],
  },
  {
    name: 'FourLayer', format: 9, copper: 4, mask: 'Blue', finish: 'ENIG',
    comment: 'KiCad 9 file format (pcb 20241229, sch 20250114), 4 layers',
    readme: 'a KiCad 9 format project (board `20241229`, schematic `20250114`): 4 layers, a GND plane on In1.Cu and a VIN plane on In2.Cu, every SMD pad dropped into its plane through a via, blue mask',
    outline: [100, 100, 140, 130],
    schematic: n => flatSchematic(n, [
      { key: 'C1', sym: 'C', value: '100n', footprint: 'C_0805', at: [76.2, 101.6], pins: { 1: 'VIN', 2: 'GND' } },
      { key: 'C2', sym: 'C', value: '10u', footprint: 'C_0805', at: [101.6, 101.6], pins: { 1: 'VIN', 2: 'GND' } },
    ], 'FourLayer: KiCad 9 file format, 4 layers with GND and VIN planes.'),
    footprints: [
      { ref: 'J1', fp: 'PinHeader_1x02', value: 'VIN', at: [104, 113.73] },
      { ref: 'C1', fp: 'C_0805', value: '100n', at: [115, 110] },
      { ref: 'C2', fp: 'C_0805', value: '10u', at: [115, 120] },
      { ref: 'R1', fp: 'R_0805', value: '330', at: [125, 110] },
      { ref: 'D1', fp: 'LED_0805', value: 'red', at: [125, 120] },
    ],
    tracks: [
      ['VIN', 'F.Cu', [[114.05, 110], [114.05, 108]]],
      ['GND', 'F.Cu', [[115.95, 110], [115.95, 112]]],
      ['VIN', 'F.Cu', [[114.05, 120], [114.05, 118]]],
      ['GND', 'F.Cu', [[115.95, 120], [115.95, 122]]],
      ['VIN', 'F.Cu', [[124.0875, 110], [124.0875, 108]]],
      ['LED_A', 'F.Cu', [[125.9125, 110], [127.5, 110], [127.5, 120], [125.9375, 120]]],
      ['GND', 'F.Cu', [[124.0625, 120], [124.0625, 122]]],
    ],
    vias: [
      ['VIN', [114.05, 108]], ['GND', [115.95, 112]], ['VIN', [114.05, 118]], ['GND', [115.95, 122]],
      ['VIN', [124.0875, 108]], ['GND', [124.0625, 122]],
    ],
    zones: [
      { net: 'GND', layer: 'In1.Cu', pts: [[100.5, 100.5], [139.5, 100.5], [139.5, 129.5], [100.5, 129.5]] },
      { net: 'VIN', layer: 'In2.Cu', pts: [[100.5, 100.5], [139.5, 100.5], [139.5, 129.5], [100.5, 129.5]] },
    ],
    texts: [
      { text: 'FourLayer (KiCad 9 format)', at: [120, 103], layer: 'F.SilkS' },
      { text: 'In1 GND / In2 VIN', at: [120, 127], layer: 'B.SilkS' },
    ],
  },
  {
    name: 'Hierarchy', format: 8, copper: 2, mask: 'Red', finish: 'HAL lead-free',
    comment: 'KiCad 8 file format, 3-level hierarchy with sheets in channels/',
    readme: 'a KiCad 8 format project with a 3-level hierarchical schematic: the root sheet places `channels/channel.kicad_sch` twice (Channel A, Channel B), and each channel places `channels/led.kicad_sch`, a sheet in a sub-directory; 5 parts, red mask',
    outline: [100, 100, 140, 125],
    schematic: hierarchySchematic,
    footprints: [
      { ref: 'J1', fp: 'PinHeader_1x02', value: 'VIN', at: [104, 111.23] },
      { ref: 'R1', fp: 'R_0805', value: '330', at: [115, 108] },
      { ref: 'D1', fp: 'LED_0805', value: 'green', at: [125, 108] },
      { ref: 'R2', fp: 'R_0805', value: '330', at: [115, 118] },
      { ref: 'D2', fp: 'LED_0805', value: 'green', at: [125, 118] },
    ],
    tracks: [
      ['VIN', 'F.Cu', [[104, 111.23], [108, 111.23]]],
      ['VIN', 'F.Cu', [[108, 111.23], [108, 108], [114.0875, 108]]],
      ['VIN', 'F.Cu', [[108, 111.23], [108, 118], [114.0875, 118]]],
      ['/Channel A/LED_A', 'F.Cu', [[115.9125, 108], [118, 108], [118, 105.5], [128, 105.5], [128, 108], [125.9375, 108]]],
      ['/Channel B/LED_A', 'F.Cu', [[115.9125, 118], [118, 118], [118, 115.5], [128, 115.5], [128, 118], [125.9375, 118]]],
      ['GND', 'F.Cu', [[124.0625, 108], [122.5, 108]]],
      ['GND', 'F.Cu', [[124.0625, 118], [122.5, 118]]],
      ['GND', 'B.Cu', [[122.5, 108], [122.5, 118], [122.5, 121.5], [104, 121.5], [104, 113.77]]],
    ],
    vias: [['GND', [122.5, 108]], ['GND', [122.5, 118]]],
    texts: [
      { text: 'Channel A', at: [133, 108], layer: 'F.SilkS' },
      { text: 'Channel B', at: [133, 118], layer: 'F.SilkS' },
      { text: 'Hierarchy (KiCad 8 format)', at: [120, 102.5], layer: 'F.SilkS', size: 0.8 },
    ],
  },
]

// ===================================================================================
// Netlist (names from KiCad) and zone fills
// ===================================================================================

/** Net names as KiCad derives them from the schematic, keyed by "REF.PAD". */
function netsFromSchematic(sch) {
  const out = join(mkdtempSync(join(tmpdir(), 'kwv-net-')), 'net.net')
  kicad('sch', 'export', 'netlist', '--format', 'kicadsexpr', '--output', out, sch)
  const tree = parse(readFileSync(out, 'utf8'))
  rmSync(dirname(out), { recursive: true, force: true })
  const list = [{ code: 0, name: '' }]
  const byPad = new Map()
  const byName = new Map()
  const names = kids(kid(tree, 'nets'), 'net').map(n => ({ name: str(kid(n, 'name')[1]), nodes: kids(n, 'node') }))
  names.sort((a, b) => a.name.localeCompare(b.name))
  for (const [i, n] of names.entries()) {
    const net = { code: i + 1, name: n.name }
    list.push(net)
    // short aliases: "/VIN" -> VIN, "/Channel A/LED_A" stays as is
    byName.set(n.name, net)
    byName.set(n.name.replace(/^\/(?=[^/]+$)/, ''), net)
    for (const node of n.nodes) byPad.set(`${str(kid(node, 'ref')[1])}.${str(kid(node, 'pin')[1])}`, net)
  }
  return { list, byPad, byName }
}

/** Fills every zone with KiCad on a scratch copy; returns zone uuid -> filled_polygon nodes. */
function zoneFills(pcbText, name) {
  const dir = mkdtempSync(join(tmpdir(), 'kwv-fill-'))
  const pcb = join(dir, `${name}.kicad_pcb`)
  writeFileSync(pcb, pcbText)
  try {
    kicad('pcb', 'drc', '--refill-zones', '--save-board', '--output', join(dir, 'drc.rpt'), pcb)
  } catch (e) {
    // a violation exit code is fine, the board is saved anyway
    if (!existsSync(pcb)) throw e
  }
  const tree = parse(readFileSync(pcb, 'utf8'))
  rmSync(dir, { recursive: true, force: true })
  const fills = new Map()
  for (const z of kids(tree, 'zone')) {
    const id = str((kid(z, 'uuid') ?? kid(z, 'tstamp'))[1])
    fills.set(id, kids(z, 'filled_polygon').map(fp => ['filled_polygon', ['layer', kid(fp, 'layer')[1]],
      ['pts', ...kids(kid(fp, 'pts'), 'xy').map(([, x, y]) => ['xy', Number(x), Number(y)])]]))
  }
  return fills
}

// ===================================================================================
// Main
// ===================================================================================

function readme(s, files) {
  return `# ${s.name}

Generated sample project for KiView: ${s.readme}.

Written by \`examples/scripts/generate-samples.mjs\` (do not edit by hand; re-run the
script). Files: ${files.map(f => `\`${f}\``).join(', ')}.

The design files in this folder are dedicated to the public domain under CC0 1.0. The
symbols and footprints are drawn by the generator; only the 3D model paths point at
KiCad's stock model library, which is not included.
`
}

function generate(s) {
  const f = FORMATS[s.format]
  const dir = join(BOARDS, s.name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const board = { name: s.name, comment: s.comment, copper: s.copper, mask: s.mask, finish: s.finish, outline: s.outline, footprints: [], tracks: s.tracks, vias: s.vias, zones: s.zones, texts: s.texts }
  const sch = s.schematic(s.name)
  const written = []
  for (const file of sch.files) {
    const path = join(dir, file.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, schematicFile(f, board, file))
    written.push(file.path)
  }
  writeFileSync(join(dir, `${s.name}.kicad_pro`), projectFile(board, sch.sheetList))
  written.push(`${s.name}.kicad_pro`)

  const nets = netsFromSchematic(join(dir, `${s.name}.kicad_sch`))
  board.footprints = s.footprints.map(fp => ({ ...fp, path: sch.paths[fp.ref] }))
  let text = pcbFile(f, board, nets, null)
  if (s.zones?.length) text = pcbFile(f, board, nets, zoneFills(text, s.name))
  writeFileSync(join(dir, `${s.name}.kicad_pcb`), text)
  written.push(`${s.name}.kicad_pcb`)
  writeFileSync(join(dir, 'README.md'), readme(s, written.sort()))
  console.log(`${s.name}: ${written.length} files (KiCad ${s.format} format, nets: ${nets.list.slice(1).map(n => n.name).join(', ')})`)
}

function validate(s) {
  const dir = join(BOARDS, s.name)
  const tmp = mkdtempSync(join(tmpdir(), 'kwv-val-'))
  const run = (...a) => { try { kicad(...a) } catch (e) { if (!existsSync(a[a.indexOf('--output') + 1])) throw e } }
  const count = (file, key) => {
    const r = JSON.parse(readFileSync(file, 'utf8'))
    const all = key === 'drc' ? [...r.violations, ...r.unconnected_items, ...r.schematic_parity] : r.sheets.flatMap(sh => sh.violations)
    const by = {}
    for (const v of all) by[v.severity] = (by[v.severity] ?? 0) + 1
    return { by, types: [...new Set(all.map(v => `${v.severity}:${v.type}`))] }
  }
  // copy, so DRC / ERC cannot touch the sample
  execFileSync('cp', ['-R', dir, tmp])
  const d = join(tmp, s.name)
  run('pcb', 'drc', '--schematic-parity', '--severity-all', '--format', 'json', '--output', join(tmp, 'drc.json'), join(d, `${s.name}.kicad_pcb`))
  run('sch', 'erc', '--severity-all', '--format', 'json', '--output', join(tmp, 'erc.json'), join(d, `${s.name}.kicad_sch`))
  kicad('pcb', 'export', 'svg', '--layers', 'F.Cu,B.Cu,Edge.Cuts', '--output', join(tmp, 'board.svg'), join(d, `${s.name}.kicad_pcb`))
  kicad('sch', 'export', 'svg', '--output', join(tmp, 'sch'), join(d, `${s.name}.kicad_sch`))
  const drc = count(join(tmp, 'drc.json'), 'drc')
  const erc = count(join(tmp, 'erc.json'), 'erc')
  const sheets = execFileSync('ls', [join(tmp, 'sch')], { encoding: 'utf8' }).trim().split('\n')
  console.log(`${s.name}: DRC ${JSON.stringify(drc.by)} ${drc.types.join(' ')}`)
  console.log(`${s.name}: ERC ${JSON.stringify(erc.by)} ${erc.types.join(' ')}`)
  console.log(`${s.name}: exported board SVG and ${sheets.length} schematic SVG(s): ${sheets.join(', ')}`)
  rmSync(tmp, { recursive: true, force: true })
  return (drc.by.error ?? 0) + (erc.by.error ?? 0)
}

console.log(`kicad-cli: ${CLI} (${kicad('version').trim()})`)
for (const s of SAMPLES) generate(s)
if (args.validate) {
  let errors = 0
  for (const s of SAMPLES) errors += validate(s)
  if (errors) { console.error(`${errors} DRC/ERC error(s)`); process.exitCode = 1 }
}
