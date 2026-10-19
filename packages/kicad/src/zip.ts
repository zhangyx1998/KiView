// A small, deterministic zip writer (no dependencies): the same entries always give
// the same bytes. Entries are sorted by name, every timestamp is 1980-01-01 00:00,
// permissions are 0644, there are no extra fields, and data is deflated (level 9,
// Node's zlib) unless storing is smaller. Names are UTF-8 (general-purpose flag 11).
// No ZIP64: entries and archives must stay below 4 GiB.
//
// listZip() reads the central directory back (tests, sanity checks).

import { writeFile } from 'node:fs/promises'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  /** Path inside the archive, '/'-separated, no leading '/'. */
  name: string
  data: Buffer | Uint8Array | string
}

const DOS_TIME = 0                         // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1   // 1980-01-01
const UTF8 = 1 << 11
const LIMIT = 0xffffffff

function checkName(name: string): void {
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(p => p === '..' || p === '.' || p === ''))
    throw new Error(`zip: bad entry name "${name}"`)
}

/** The archive as a buffer. Throws on duplicate or unsafe names. */
export function zipBuffer(entries: ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  let prev: string | null = null
  for (const e of sorted) {
    checkName(e.name)
    if (e.name === prev) throw new Error(`zip: duplicate entry "${e.name}"`)
    prev = e.name
    const name = Buffer.from(e.name, 'utf8')
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : Buffer.from(e.data)
    const deflated = deflateRawSync(raw, { level: 9 })
    const store = deflated.length >= raw.length
    const body = store ? raw : deflated
    const crc = crc32(raw)
    if (raw.length >= LIMIT || offset >= LIMIT) throw new Error('zip: archive too large (no ZIP64 support)')

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)                  // version needed: 2.0
    lh.writeUInt16LE(UTF8, 6)
    lh.writeUInt16LE(store ? 0 : 8, 8)
    lh.writeUInt16LE(DOS_TIME, 10)
    lh.writeUInt16LE(DOS_DATE, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)
    local.push(lh, name, body)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE((3 << 8) | 20, 4)       // made by: Unix, 2.0
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(UTF8, 8)
    ch.writeUInt16LE(store ? 0 : 8, 10)
    ch.writeUInt16LE(DOS_TIME, 12)
    ch.writeUInt16LE(DOS_DATE, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(name.length, 28)
    // extra 30, comment 32, disk 34, internal attrs 36: 0
    ch.writeUInt32LE(((0o100644 << 16) >>> 0), 38)   // regular file, rw-r--r--
    ch.writeUInt32LE(offset, 42)
    central.push(ch, name)

    offset += lh.length + name.length + body.length
  }
  const cd = Buffer.concat(central)
  if (sorted.length > 0xffff || offset + cd.length >= LIMIT) throw new Error('zip: archive too large (no ZIP64 support)')
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(sorted.length, 8)
  end.writeUInt16LE(sorted.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, cd, end])
}

/** Write the archive; returns its size and the entry names in archive order. */
export async function writeZip(file: string, entries: ZipEntry[]): Promise<{ bytes: number; names: string[] }> {
  const buf = zipBuffer(entries)
  await writeFile(file, buf)
  return { bytes: buf.length, names: entries.map(e => e.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) }
}

export interface ZipListing { name: string; size: number; compressed: number; crc: number; data(): Buffer }

/** Entries of a zip (single-disk, no ZIP64), from its central directory. */
export function listZip(buf: Buffer): ZipListing[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('zip: no end of central directory')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: ZipListing[] = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory')
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compressed = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const n = buf.readUInt16LE(p + 28), x = buf.readUInt16LE(p + 30), c = buf.readUInt16LE(p + 32)
    const lho = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + n).toString('utf8')
    out.push({
      name, size, compressed, crc,
      data() {
        const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28)
        const body = buf.subarray(start, start + compressed)
        return method === 0 ? Buffer.from(body) : inflateRawSync(body)
      },
    })
    p += 46 + n + x + c
  }
  return out
}
