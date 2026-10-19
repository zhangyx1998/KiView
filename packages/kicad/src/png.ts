// Tiny PNG helper for thumbnails: decode 8-bit RGBA/RGB (non-interlaced, as
// kicad-cli writes them), crop to the opaque content, downscale by an integer
// factor (box filter, premultiplied alpha) and encode again. No dependencies.

import { deflateSync, inflateSync } from 'node:zlib'

export interface Image { width: number; height: number; data: Uint8Array }   // RGBA, row-major

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function decodePng(buf: Buffer): Image {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG')
  let off = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0
  const idat: Buffer[] = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const kind = buf.toString('latin1', off + 4, off + 8)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4)
      depth = body[8]!; type = body[9]!; interlace = body[12]!
    } else if (kind === 'IDAT') idat.push(body)
    else if (kind === 'IEND') break
    off += 12 + len
  }
  if (depth !== 8 || (type !== 6 && type !== 2) || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${type})`)
  const bpp = type === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const px = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!
    const src = y * (stride + 1) + 1
    const row = y * stride, prev = row - stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp]! : 0
      const b = y > 0 ? px[prev + x]! : 0
      const c = x >= bpp && y > 0 ? px[prev + x - bpp]! : 0
      let v = raw[src + x]!
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[row + x] = v & 255
    }
  }
  if (bpp === 4) return { width, height, data: px }
  const data = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    data[j] = px[i]!; data[j + 1] = px[i + 1]!; data[j + 2] = px[i + 2]!; data[j + 3] = 255
  }
  return { width, height, data }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(b: Buffer): number {
  let c = 0xffffffff
  for (const v of b) c = CRC_TABLE[(c ^ v) & 255]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(kind: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(kind, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

export function encodePng(img: Image): Buffer {
  const { width, height, data } = img
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1)
    raw[o] = 1   // Sub filter: cheap and compresses renders well
    for (let x = 0; x < stride; x++) {
      const v = data[y * stride + x]!
      const left = x >= 4 ? data[y * stride + x - 4]! : 0
      raw[o + 1 + x] = (v - left) & 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** Bounding box of pixels with alpha above `threshold`, or null when the image is empty. */
export function opaqueBox(img: Image, threshold = 24): { x: number; y: number; w: number; h: number } | null {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3]! > threshold) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/** Crop to the opaque content plus `pad` (fraction of the larger side), then shrink by `factor`. */
export function trimAndShrink(img: Image, factor: number, pad = 0.04): Image {
  const box = opaqueBox(img) ?? { x: 0, y: 0, w: img.width, h: img.height }
  const p = Math.round(Math.max(box.w, box.h) * pad)
  // output size in destination pixels; source window is factor times larger
  const w = Math.max(1, Math.ceil((box.w + 2 * p) / factor))
  const h = Math.max(1, Math.ceil((box.h + 2 * p) / factor))
  const sx = box.x - p - Math.floor((w * factor - (box.w + 2 * p)) / 2)
  const sy = box.y - p - Math.floor((h * factor - (box.h + 2 * p)) / 2)
  const out = new Uint8Array(w * h * 4)
  const n = factor * factor
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let dy = 0; dy < factor; dy++)
        for (let dx = 0; dx < factor; dx++) {
          const X = sx + x * factor + dx, Y = sy + y * factor + dy
          if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue
          const i = (Y * img.width + X) * 4
          const al = img.data[i + 3]!
          r += img.data[i]! * al; g += img.data[i + 1]! * al; b += img.data[i + 2]! * al; a += al
        }
      const o = (y * w + x) * 4
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a) }
      out[o + 3] = Math.round(a / n)
    }
  return { width: w, height: h, data: out }
}
