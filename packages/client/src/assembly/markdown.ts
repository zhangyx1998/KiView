// A small, safe markdown renderer for assembly notes (pure, no dependencies). All text
// is HTML-escaped first; only this subset becomes markup:
//
//   # / ## / ### headings, paragraphs, blank-line separated
//   - / * / + bullet lists and 1. numbered lists, nested by indentation
//   > quotes, ``` fenced code, --- rules
//   **bold**, *italic* / _italic_, `code`, [text](https://...) links (http, https, mailto
//   and relative URLs only; they open in a new tab)

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function safeUrl(u: string): string | null {
  const t = u.trim()
  if (/^(https?:|mailto:)/i.test(t)) return t
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null   // javascript:, data:, ...
  return t
}

/** Inline markup of one escaped line. */
export function inline(text: string): string {
  const codes: string[] = []
  let s = esc(text).replace(/`([^`]+)`/g, (_, c: string) => { codes.push(c); return `\u0000${codes.length - 1}\u0000` })
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) => {
    const u = safeUrl(href.replace(/&amp;/g, '&'))
    return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m
  })
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>').replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`)
}

const HR = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/

interface ListFrame { indent: number; tag: 'ul' | 'ol' }

/** Render markdown to HTML (safe to bind with v-html). */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  const lists: ListFrame[] = []
  let quote = false
  let fence: string[] | null = null

  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = [] } }
  const closeLists = (toIndent = -1) => {
    while (lists.length && lists[lists.length - 1]!.indent > toIndent) out.push(`</li></${lists.pop()!.tag}>`)
  }
  const closeQuote = () => { if (quote) { flushPara(); out.push('</blockquote>'); quote = false } }

  for (const raw of lines) {
    if (fence) {
      if (/^\s*```/.test(raw)) { out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`); fence = null }
      else fence.push(raw)
      continue
    }
    if (/^\s*```/.test(raw)) { flushPara(); closeLists(); closeQuote(); fence = []; continue }
    if (!raw.trim()) { flushPara(); continue }

    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw)
    if (item && !HR.test(raw)) {
      flushPara()
      const indent = item[1]!.replace(/\t/g, '    ').length
      const tag = /\d/.test(item[2]!) ? 'ol' : 'ul'
      const top = lists[lists.length - 1]
      if (!top || indent > top.indent) { out.push(`<${tag}><li>`); lists.push({ indent, tag }) }
      else {
        closeLists(indent)
        const cur = lists[lists.length - 1]
        if (cur && cur.tag === tag) out.push('</li><li>')
        else { if (cur) out.push(`</li></${lists.pop()!.tag}>`); out.push(`<${tag}><li>`); lists.push({ indent, tag }) }
      }
      out.push(inline(item[3]!))
      continue
    }
    if (lists.length && /^\s+\S/.test(raw)) { out.push(' ' + inline(raw.trim())); continue }   // continuation of an item
    closeLists()

    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw)
    if (h) { flushPara(); closeQuote(); const n = Math.min(6, h[1]!.length + 2); out.push(`<h${n}>${inline(h[2]!)}</h${n}>`); continue }
    if (HR.test(raw)) { flushPara(); closeQuote(); out.push('<hr>'); continue }
    const q = /^\s*>\s?(.*)$/.exec(raw)
    if (q) { if (!quote) { flushPara(); out.push('<blockquote>'); quote = true } para.push(q[1]!); continue }
    closeQuote()
    para.push(raw.trim())
  }
  if (fence) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`)
  flushPara()
  closeLists()
  closeQuote()
  return out.join('')
}
