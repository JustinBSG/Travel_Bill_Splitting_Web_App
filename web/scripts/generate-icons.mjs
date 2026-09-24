// Generates the PWA PNG icons into web/public with no image dependencies.
// Design: the "split" coin (two half circles) in the Washi theme colours:
// vermilion (shu) square, left half paper (kinari), right half sumi ink.
// Keep in sync with public/favicon.svg and the Washi tokens in src/index.css.
// (public/favicon-classic.svg is the browser-tab icon for the Classic theme.)
// Run: node scripts/generate-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
mkdirSync(outDir, { recursive: true })

const BG = [192, 70, 42] // #c0462a  --accent (shu)
const LEFT = [251, 248, 242] // #fbf8f2  --sheet (kinari paper)
const RIGHT = [38, 34, 29] // #26221d  --ink (sumi)

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y)
      const o = y * (size * 4 + 1) + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// radius as a fraction of size; maskable keeps everything inside the 80% safe zone
function icon(size, radiusFrac) {
  const SS = 4
  const c = size / 2
  const r = size * radiusFrac
  const gap = size * 0.018
  return png(size, (x, y) => {
    let acc = [0, 0, 0]
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS
        const py = y + (sy + 0.5) / SS
        const inCircle = (px - c) ** 2 + (py - c) ** 2 <= r * r
        let col = BG
        if (inCircle && Math.abs(px - c) > gap) col = px < c ? LEFT : RIGHT
        acc = acc.map((v, i) => v + col[i])
      }
    }
    return acc.map((v) => Math.round(v / (SS * SS)))
  })
}

writeFileSync(join(outDir, 'pwa-192x192.png'), icon(192, 0.32))
writeFileSync(join(outDir, 'pwa-512x512.png'), icon(512, 0.32))
writeFileSync(join(outDir, 'maskable-512x512.png'), icon(512, 0.26))
writeFileSync(join(outDir, 'apple-touch-icon-180x180.png'), icon(180, 0.3))
console.log('icons written to', outDir)
