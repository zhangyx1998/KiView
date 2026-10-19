// Help-text fixtures for the probe tests (tests/probe.test.ts).
//
//   node tests/fixtures/help/tool.ts capture <kicad-cli> <outDir>
//       Captured: runs `kicad-cli version` and `<path> --help` for every command path,
//       recursively, and writes them as they are.
//
//   node tests/fixtures/help/tool.ts reconstruct <kicad source>/kicad/cli <outDir> <version>
//       Reconstructed: rebuilds argparse-style help texts from KiCad's CLI command
//       definitions (kicad/cli/kicad_cli.cpp for the command tree, command_*.{cpp,h} for
//       the arguments) at a release tag, for versions we have no binary of. A small
//       interpreter walks each command's constructor (base classes, add*Arg helpers, and
//       `if( m_format == ... )` branches on the constructor arguments) and records every
//       `add_argument`. Branches it cannot decide are included. The layout follows the
//       argparse bundled with KiCad (Usage / description / Positional arguments /
//       Optional arguments / Subcommands); wrapping and column widths are approximate,
//       but the facts the probe reads (subcommands, long flags) are exact up to that.
//
// Files: VERSION (the `kicad-cli version` output) and one `<path>.txt` per command path,
// words joined by "_" ("kicad-cli.txt" is the root, "pcb_export_svg.txt" ...), plus
// SOURCE saying how the set was made.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const fileOf = (path: string[]) => (path.length ? path.join('_') : 'kicad-cli') + '.txt'

// ------------------------------------------------------------------------------ capture

function capture(cli: string, out: string) {
  mkdirSync(out, { recursive: true })
  const v = spawnSync(cli, ['version'], { encoding: 'utf8' })
  writeFileSync(join(out, 'VERSION'), v.stdout.trim() + '\n')
  const walk = (path: string[]) => {
    const r = spawnSync(cli, [...path, '--help'], { encoding: 'utf8' })
    const text = (r.stdout + r.stderr).replace(/\r\n/g, '\n')
    writeFileSync(join(out, fileOf(path)), text)
    const subs = subcommandsOf(text)
    for (const s of subs) if (path.length || s === "pcb" || s === "sch") walk([...path, s])
  }
  walk([])
  writeFileSync(join(out, 'SOURCE'), `captured from ${cli} (kicad-cli version: ${v.stdout.trim()})\n`)
}

function subcommandsOf(text: string): string[] {
  const lines = text.split('\n')
  const i = lines.findIndex(l => l.trim() === 'Subcommands:')
  if (i < 0) return []
  const out: string[] = []
  for (const l of lines.slice(i + 1)) {
    const m = /^\s+([a-z0-9][\w-]*)/.exec(l)
    if (!m) break
    out.push(m[1]!)
  }
  return out
}

// -------------------------------------------------------------------------- reconstruct

/** Strip comments, keep strings. */
function stripComments(s: string): string {
  let out = ''
  for (let i = 0; i < s.length;) {
    const c = s[i]!
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1
      out += s.slice(i, j + 1); i = j + 1
    } else if (s.startsWith('//', i)) {
      while (i < s.length && s[i] !== '\n') i++
    } else if (s.startsWith('/*', i)) {
      const j = s.indexOf('*/', i + 2); i = j < 0 ? s.length : j + 2
    } else { out += c; i++ }
  }
  return out
}

/** Index just past the bracket matching the one at `open`. */
function matching(s: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' }
  const stack: string[] = []
  for (let i = open; i < s.length; i++) {
    const c = s[i]!
    if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1; i = j; continue }
    if (pairs[c]) stack.push(pairs[c]!)
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i + 1 }
  }
  return s.length
}

/** Split a comma list at depth 0. */
function splitArgs(s: string): string[] {
  const out: string[] = []
  let depth = 0, cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1; cur += s.slice(i, j + 1); i = j; continue }
    if ('({[<'.includes(c)) depth++
    if (')}]>'.includes(c)) depth--
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = '' } else cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const unescape = (s: string) => s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\')

interface Method { params: { name: string; def?: string }[]; init: string; body: string; file: string }
interface Klass { name: string; base: string | null; methods: Map<string, Method> }
interface Arg { names: string[]; help: string; metavar: string | null }
interface Cmd { name: string; description: string; args: Arg[]; subs: Cmd[] }

class Source {
  macros = new Map<string, string>()
  /** Macros per file: a file's own #defines win over same-named ones elsewhere. */
  fileMacros = new Map<string, Map<string, string>>()
  file = ''
  classes = new Map<string, Klass>()
  notes: string[] = []
  tree = ''

  constructor(dir: string) {
    const files = readdirSync(dir).filter(f => /\.(cpp|h)$/.test(f)).sort()
    const texts = new Map(files.map(f => [f, stripComments(readFileSync(join(dir, f), 'utf8'))]))
    for (const [f, t] of texts) this.readMacros(t, f)
    for (const [f, t] of texts) if (f.endsWith('.h')) { this.file = f; this.readHeader(t) }
    for (const [f, t] of texts) if (f.endsWith('.cpp')) { this.file = f; this.readDefinitions(t) }
    this.tree = texts.get('kicad_cli.cpp') ?? ''
  }

  readMacros(t: string, file: string) {
    const local = new Map<string, string>()
    this.fileMacros.set(file, local)
    const re = /^#define\s+(\w+)\s+((?:[^\n\\]|\\\n|\\.)*)/gm
    for (const m of t.matchAll(re)) {
      const strs = [...m[2]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => unescape(x[1]!))
      if (strs.length) { this.macros.set(m[1]!, strs.join('')); local.set(m[1]!, strs.join('')) }
    }
  }

  klass(name: string): Klass {
    let k = this.classes.get(name)
    if (!k) { k = { name, base: null, methods: new Map() }; this.classes.set(name, k) }
    return k
  }

  parseParams(s: string): Method['params'] {
    return splitArgs(s).filter(p => p && p !== 'void').map(p => {
      const [decl, def] = p.split('=').map(x => x.trim())
      return { name: /(\w+)\s*$/.exec(decl!)![1]!, def }
    })
  }

  readHeader(t: string) {
    for (const m of t.matchAll(/\b(?:struct|class)\s+(\w+)\s*:\s*public\s+(?:CLI::)?(\w+)\s*\{/g)) {
      const k = this.klass(m[1]!)
      k.base = m[2]!
      const body = t.slice(m.index! + m[0].length - 1, matching(t, m.index! + m[0].length - 1))
      // declarations with default arguments, and inline constructors
      for (const d of body.matchAll(new RegExp(`\\b${m[1]}\\s*\\(`, 'g'))) {
        const open = d.index! + d[0].length - 1
        const close = matching(body, open)
        const params = this.parseParams(body.slice(open + 1, close - 1))
        const rest = body.slice(close)
        const inline = /^\s*:\s*/.exec(rest)
        if (inline) {
          const braceAt = this.bodyStart(rest)
          const bodyEnd = matching(rest, braceAt)
          k.methods.set(`${m[1]}#${params.length}`, { params, init: rest.slice(inline[0].length, braceAt), body: rest.slice(braceAt + 1, bodyEnd - 1), file: this.file })
        } else if (/^\s*\{/.test(rest)) {
          const braceAt = rest.indexOf('{')
          k.methods.set(`${m[1]}#${params.length}`, { params, init: '', body: rest.slice(braceAt + 1, matching(rest, braceAt) - 1), file: this.file })
        } else if (params.some(p => p.def !== undefined)) {
          k.methods.set(`decl:${m[1]}#${params.length}`, { params, init: '', body: '', file: this.file })
        }
      }
    }
  }

  /** The `{` that opens a body after an initialiser list. */
  bodyStart(s: string): number {
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(' || s[i] === '[') { i = matching(s, i) - 1; continue }
      if (s[i] === '{') {
        // `m_x{ 1 }` initialisers: a brace right after an identifier
        if (/\w\s*$/.test(s.slice(0, i)) && !/\)\s*$/.test(s.slice(0, i))) { i = matching(s, i) - 1; continue }
        return i
      }
    }
    return -1
  }

  readDefinitions(t: string) {
    for (const m of t.matchAll(/^(?:[\w:<>&*\s]+\s)?CLI::(\w+)::(~?\w+)\s*\(/gm)) {
      const open = m.index! + m[0].length - 1
      const close = matching(t, open)
      const rest = t.slice(close)
      const inline = /^\s*(const\s*)?(:\s*)?/.exec(rest)!
      const braceAt = this.bodyStart(rest)
      if (braceAt < 0) continue
      const k = this.klass(m[1]!)
      const params = this.parseParams(t.slice(open + 1, close - 1))
      const decl = k.methods.get(`decl:${m[2]}#${params.length}`)
      if (decl) params.forEach((p, i) => { p.def ??= decl.params[i]?.def })
      k.methods.set(m[2] === m[1] ? `${m[2]}#${params.length}` : m[2]!, {
        params, init: inline[2] ? rest.slice(inline[0].length, braceAt) : '',
        body: rest.slice(braceAt + 1, matching(rest, braceAt) - 1), file: this.file,
      })
    }
  }

  /** A C++ expression as a string value, if it is one (literals, macros, _(), UTF8STDSTR()). */
  str(e: string, env: Map<string, string>): string | null {
    e = e.trim()
    const parts: string[] = []
    let rest = e
    // peel wrappers
    for (;;) {
      const w = /^(?:UTF8STDSTR|_|wxT|wxS|std::string|wxString)\s*\(([\s\S]*)\)$/.exec(rest)
      if (!w) break
      rest = w[1]!.trim()
    }
    const toks = rest.match(/"(?:[^"\\]|\\.)*"|\w+/g) ?? []
    if (!toks.length) return null
    for (const tk of toks) {
      if (tk.startsWith('"')) parts.push(unescape(tk.slice(1, -1)))
      else if (this.fileMacros.get(this.file)?.has(tk)) parts.push(this.fileMacros.get(this.file)!.get(tk)!)
      else if (this.macros.has(tk)) parts.push(this.macros.get(tk)!)
      else if (env.has(tk)) parts.push(env.get(tk)!)
      else if (/^(UTF8STDSTR|_|wxT|wxS|std|string|wxString|c_str|ToStdString)$/.test(tk)) continue
      else return null
    }
    return parts.join('')
  }

  /** Evaluate a condition; null when it depends on something unknown. */
  cond(c: string, env: Map<string, string>): boolean | null {
    let s = c.trim()
    const val = (x: string): string | null => {
      x = x.trim()
      if (x === 'true' || x === 'false') return x
      const id = /^[\w:]+$/.test(x) ? x : null
      if (!id) return null
      if (env.has(id)) return env.get(id)!
      if (id.includes('::')) return id.split('::').pop()!   // enum value
      return null
    }
    const term = (t: string): boolean | null => {
      t = t.trim()
      while (t.startsWith('(') && matching(t, 0) === t.length) t = t.slice(1, -1).trim()
      if (/\|\||&&/.test(t)) return this.cond(t, env)
      if (t.startsWith('!') && !t.startsWith('!=')) { const v = term(t.slice(1)); return v === null ? null : !v }
      const m = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(t)
      if (m) {
        const a = val(m[1]!), b = val(m[3]!)
        if (a === null || b === null) return null
        return m[2] === '==' ? a === b : a !== b
      }
      const v = val(t)
      return v === null ? null : v === 'true'
    }
    // split on || then && at depth 0
    const split = (x: string, op: string) => {
      const out: string[] = []; let depth = 0, cur = ''
      for (let i = 0; i < x.length; i++) {
        if (x[i] === '(') depth++
        if (x[i] === ')') depth--
        if (depth === 0 && x.startsWith(op, i)) { out.push(cur); cur = ''; i += op.length - 1 } else cur += x[i]
      }
      out.push(cur); return out
    }
    while (s.startsWith('(') && matching(s, 0) === s.length) s = s.slice(1, -1).trim()
    const ors = split(s, '||')
    if (ors.length > 1) {
      const vs = ors.map(o => this.cond(o, env))
      return vs.includes(true) ? true : vs.includes(null) ? null : false
    }
    const ands = split(s, '&&')
    if (ands.length > 1) {
      const vs = ands.map(a => this.cond(a, env))
      return vs.includes(false) ? false : vs.includes(null) ? null : true
    }
    return term(s)
  }

  findMethod(cls: string, name: string): { k: Klass; m: Method } | null {
    for (let k = this.classes.get(cls); k; k = k.base ? this.classes.get(k.base) : undefined) {
      const m = k.methods.get(name)
      if (m) return { k, m }
    }
    return null
  }

  /** A call argument as a value: string, bool, enum value (last segment) or a bound name. */
  argValue(a: string, env: Map<string, string>): string | null {
    const t = a.trim()
    if (t === 'true' || t === 'false') return t
    if (env.has(t)) return env.get(t)!
    if (/^[\w:]+::\w+$/.test(t)) return t.split('::').pop()!
    return this.str(t, env) ?? this.cond(t, env)?.toString() ?? null
  }

  /** Run a constructor: base first, then the body. */
  construct(cls: string, args: string[], cmd: Cmd, callerEnv = new Map<string, string>()) {
    const k = this.classes.get(cls)
    if (!k) { this.notes.push(`unknown class ${cls}`); return }
    const ctor = [...k.methods].find(([key, m]) => key.startsWith(`${cls}#`)
      && m.params.filter(p => p.def === undefined).length <= args.length && args.length <= m.params.length)?.[1]
    const env = new Map<string, string>()
    if (ctor) {
      ctor.params.forEach((p, i) => {
        const a = args[i] ?? p.def
        if (a === undefined) return
        const v = this.argValue(a, callerEnv)
        if (v !== null) env.set(p.name, v)
      })
      // initialiser list: base call and member bindings
      for (const part of splitArgs(ctor.init)) {
        const m = /^(?:CLI::)?(\w+)\s*[({]([\s\S]*)[)}]$/.exec(part)
        if (!m) continue
        if (m[1] === cls) { this.construct(cls, splitArgs(m[2]!), cmd, env); continue }
        if (m[1] === k.base) {
          this.construct(k.base, splitArgs(m[2]!), cmd, env)
        } else if (m[1]!.startsWith('m_')) {
          const v = this.argValue(m[2]!, env)
          if (v !== null) env.set(m[1]!, v)
        }
      }
      if (k.base === 'COMMAND' && !/\bCOMMAND\s*\(/.test(ctor.init)) this.notes.push(`${cls}: no COMMAND() in initialiser`)
    }
    if (cls === 'COMMAND') cmd.name = env.get(ctor?.params[0]?.name ?? '') ?? cmd.name
    if (ctor) this.inFile(ctor.file, () => this.exec(ctor.body, env, cmd, cls))
    // an instance-level description argument (PCB_EXPORT_3D_COMMAND( name, description, format ))
  }

  inFile(file: string, fn: () => void) {
    const prev = this.file
    this.file = file
    try { fn() } finally { this.file = prev }
  }

  exec(body: string, env: Map<string, string>, cmd: Cmd, cls: string) {
    let i = 0
    const s = body
    while (i < s.length) {
      const rest = s.slice(i)
      const ws = /^\s+/.exec(rest)
      if (ws) { i += ws[0].length; continue }
      const iff = /^if\s*\(/.exec(rest)
      if (iff) {
        const open = i + iff[0].length - 1
        const close = matching(s, open)
        const c = this.cond(s.slice(open + 1, close - 1), env)
        const [thenBody, afterThen] = this.block(s, close)
        let j = afterThen
        let elseBody: string | null = null
        const el = /^\s*else\b/.exec(s.slice(j))
        if (el) {
          j += el[0].length
          const [eb, after] = this.block(s, j)
          elseBody = eb; j = after
        }
        if (c !== false) this.exec(thenBody, env, cmd, cls)
        if (elseBody !== null && c !== true) this.exec(elseBody, env, cmd, cls)
        i = j
        continue
      }
      if (rest.startsWith('{')) { const e = matching(s, i); this.exec(s.slice(i + 1, e - 1), env, cmd, cls); i = e; continue }
      // one statement up to `;` at depth 0
      let j = i, depth = 0
      for (; j < s.length; j++) {
        const c = s[j]!
        if (c === '"' || c === "'") { let q = j + 1; while (q < s.length && s[q] !== c) q += s[q] === '\\' ? 2 : 1; j = q; continue }
        if ('({['.includes(c)) depth++
        if (')}]'.includes(c)) depth--
        if (c === ';' && depth === 0) break
      }
      this.statement(s.slice(i, j), env, cmd, cls)
      i = j + 1
    }
  }

  /** A braced block or a single statement starting at `at`; returns [body, end]. */
  block(s: string, at: number): [string, number] {
    let i = at
    while (/\s/.test(s[i] ?? '')) i++
    if (s[i] === '{') { const e = matching(s, i); return [s.slice(i + 1, e - 1), e] }
    if (s.startsWith('if', i)) {
      // else if: take the whole chain
      const open = s.indexOf('(', i); const close = matching(s, open)
      const [, e1] = this.block(s, close)
      const el = /^\s*else\b/.exec(s.slice(e1))
      if (el) { const [, e2] = this.block(s, e1 + el[0].length); return [s.slice(i, e2), e2] }
      return [s.slice(i, e1), e1]
    }
    const semi = s.indexOf(';', i)
    return [s.slice(i, semi + 1), semi + 1]
  }

  statement(st: string, env: Map<string, string>, cmd: Cmd, cls: string) {
    st = st.trim()
    const add = /m_argParser\s*\.\s*add_argument\s*\(/.exec(st)
    if (add) {
      const open = add.index + add[0].length - 1
      const close = matching(st, open)
      const names = splitArgs(st.slice(open + 1, close - 1)).map(a => this.str(a, env)).filter((x): x is string => !!x)
      const chain = st.slice(close)
      const h = /\.\s*help\s*\(/.exec(chain)
      const help = h ? this.str(chain.slice(h.index + h[0].length, matching(chain, h.index + h[0].length - 1) - 1), env) ?? '' : ''
      const mv = /\.\s*metavar\s*\(\s*("(?:[^"\\]|\\.)*"|\w+)\s*\)/.exec(chain)
      const metavar = mv ? this.str(mv[1]!, env) : null
      if (!names.length) { this.notes.push(`${cls}: unresolved add_argument(${st.slice(open + 1, close - 1)})`); return }
      names.sort((x, y) => x.length - y.length || (x < y ? -1 : 1))
      if (!cmd.args.some(a => a.names.join() === names.join())) cmd.args.push({ names, help: help.replace(/\s+/g, ' ').trim(), metavar })
      return
    }
    const desc = /m_argParser\s*\.\s*add_description\s*\(/.exec(st)
    if (desc) {
      const open = desc.index + desc[0].length - 1
      cmd.description = this.str(st.slice(open + 1, matching(st, open) - 1), env) ?? cmd.description
      return
    }
    const assign = /^(m_\w+)\s*=\s*([\s\S]+)$/.exec(st)
    if (assign) {
      const v = this.str(assign[2]!, env) ?? (env.get(assign[2]!.trim()) ?? null)
      if (v !== null) env.set(assign[1]!, v)
      return
    }
    const call = /^(add\w+)\s*\(([\s\S]*)\)$/.exec(st)
    if (call) {
      const found = this.findMethod(cls, call[1]!)
      if (!found) { this.notes.push(`${cls}: unknown helper ${call[1]}`); return }
      const local = new Map(env)
      const args = splitArgs(call[2]!)
      found.m.params.forEach((p, i) => {
        const a = args[i] ?? p.def
        if (a === undefined) return
        const v = this.argValue(a, env)
        if (v !== null) local.set(p.name, v)
      })
      this.inFile(found.m.file, () => this.exec(found.m.body, local, cmd, found.k.name))
    }
  }

  /** The command tree from kicad_cli.cpp. */
  commands(): Cmd {
    const instances = new Map<string, { cls: string; args: string[] }>()
    for (const m of this.tree.matchAll(/static\s+CLI::(\w+)\s+(\w+)\s*\{/g)) {
      const open = m.index! + m[0].length - 1
      instances.set(m[2]!, { cls: m[1]!, args: splitArgs(this.tree.slice(open + 1, matching(this.tree, open) - 1)) })
    }
    const at = this.tree.indexOf('commandStack')
    const open = this.tree.indexOf('{', at)
    const stack = this.tree.slice(open, matching(this.tree, open))
    const build = (inst: string): Cmd => {
      const def = instances.get(inst)!
      const cmd: Cmd = { name: inst, description: '', args: [], subs: [] }
      this.construct(def.cls, def.args, cmd)
      if (!cmd.description && def.args[1]) cmd.description = this.str(def.args[1], new Map()) ?? ''
      return cmd
    }
    // entries: { &handler, { sub entries } } or &handler
    const parseEntries = (s: string): Cmd[] => {
      const out: Cmd[] = []
      for (const part of splitArgs(s)) {
        const p = part.trim()
        if (p.startsWith('&')) { out.push(build(p.slice(1).trim())); continue }
        if (!p.startsWith('{')) continue
        const inner = splitArgs(p.slice(1, -1))
        const head = inner[0]!.trim()
        if (head.startsWith('{')) { out.push(...parseEntries(inner.join(','))); continue }
        const cmd = build(head.replace(/^&/, '').trim())
        if (inner[1]) cmd.subs = parseEntries(inner[1].trim().replace(/^\{([\s\S]*)\}$/, '$1'))
        out.push(cmd)
      }
      return out
    }
    const root: Cmd = {
      name: 'kicad-cli', description: '',
      args: [{ names: ['-v', '--version'], help: 'prints version information and exits', metavar: null },
             { names: ['-h', '--help'], help: 'Shows help message and exits', metavar: null }],
      subs: parseEntries(stack.slice(1, -1)),
    }
    return root
  }
}

function formatHelp(cmd: Cmd): string {
  const pos = cmd.args.filter(a => !a.names[0]!.startsWith('-'))
  const opt = cmd.args.filter(a => a.names[0]!.startsWith('-'))
  const subs = [...cmd.subs].sort((a, b) => (a.name < b.name ? -1 : 1))
  const label = (a: Arg) => (a.names[0]!.startsWith('-') ? a.names.join(', ') : a.metavar ?? a.names[0]!)
  const width = Math.max(4, ...cmd.args.map(a => label(a).length), ...subs.map(s => s.name.length + 2)) + 2
  const usage = ['Usage:', cmd.name,
    ...opt.map(a => {
      const long = a.names.find(n => n.startsWith('--')) ?? a.names[0]!
      return a.metavar ? `[${long} ${a.metavar}]` : `[${long}]`
    }),
    ...pos.map(a => a.metavar ?? a.names[0]!),
    ...(subs.length ? [`{${subs.map(s => s.name).join(',')}}`] : [])].join(' ')
  let t = usage + '\n\n'
  if (cmd.description) t += cmd.description + '\n\n'
  if (pos.length) {
    t += 'Positional arguments:\n'
    for (const a of pos) t += `  ${label(a).padEnd(width)}${a.help}\n`
  }
  if (opt.length) {
    t += (pos.length ? '\n' : '') + 'Optional arguments:\n'
    for (const a of opt) t += `  ${label(a).padEnd(width)}${a.help}\n`
  }
  if (subs.length) {
    t += (pos.length || opt.length ? '\n' : '') + 'Subcommands:\n'
    for (const s of subs) t += `  ${s.name.padEnd(width)}${s.description}\n`
  }
  return t
}

function reconstruct(dir: string, out: string, version: string) {
  const src = new Source(dir)
  const root = src.commands()
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'VERSION'), version + '\n')
  const walk = (cmd: Cmd, path: string[]) => {
    writeFileSync(join(out, fileOf(path)), formatHelp(cmd))
    for (const s of cmd.subs) if (path.length || s.name === "pcb" || s.name === "sch") walk(s, [...path, s.name])
  }
  walk(root, [])
  const notes = [...new Set(src.notes)]
  writeFileSync(join(out, 'SOURCE'),
    `RECONSTRUCTED (not captured) from gitlab.com/kicad/code/kicad tag ${version}, kicad/cli/*.{cpp,h},\n` +
    `by tests/fixtures/help/tool.ts reconstruct. Layout approximates KiCad's argparse;\n` +
    `subcommands and flags are what the sources register.\n` +
    (notes.length ? `\nNotes:\n${notes.map(n => `  ${n}`).join('\n')}\n` : ''))
  if (notes.length) console.error(notes.join('\n'))
}

const [mode, a, b, c] = process.argv.slice(2)
if (mode === 'capture' && a && b) capture(a, b)
else if (mode === 'reconstruct' && a && b && c) reconstruct(a, b, c)
else {
  console.error('usage: tool.ts capture <kicad-cli> <outDir> | reconstruct <kicad/cli dir> <outDir> <version>')
  process.exit(2)
}
