import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'

const assetsDir = path.join(import.meta.dir, '..', 'assets')

/**
 * Authoritative hashes from homepage/public/brand/manifest.json (selectedAt
 * 2026-09-26, selection "B · 留缝折角"). Pinned here so the regression proves
 * the generated assets came from the selected source without reading the
 * sibling homepage checkout at test time.
 */
const SELECTED_SOURCE = {
  'xpod-app.svg': 'a7eacfade11a11252a65c0e7b691b095f06c9b3af749fc68d1fcfb177df7656b',
  'xpod-symbol.svg': '1d6f23f4256fe442bdb22ad34e0edc231896e97d9a29feeafdf897462f898a49',
  'xpod-app.png': '415585c548edc845d4f74bd811b6d4c8516d3c8fa3e0337d8e3e86e5152d2ab8',
} as const

const SYMBOL_BODY = 'M31 24H52V45H73V73Q73 76 70 76H31Q28 76 28 73V27Q28 24 31 24Z'
const SYMBOL_FOLD = 'M58 24L76 39H58Z'
const TRAY_STATES = ['healthy', 'starting', 'degraded', 'failed', 'stopped'] as const

interface PngImage {
  width: number
  height: number
  pixels: Buffer
}

function pngFilterDelta(filter: number, left: number, above: number, upperLeft: number): number {
  if (filter === 0) return 0
  if (filter === 1) return left
  if (filter === 2) return above
  if (filter === 3) return Math.floor((left + above) / 2)
  const estimate = left + above - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance ? above : upperLeft
}

function decodePng(filePath: string): PngImage {
  const bytes = readFileSync(filePath)
  expect(bytes.subarray(1, 4).toString()).toBe('PNG')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  expect(bytes[25]).toBe(6)

  const idat: Buffer[] = []
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString()
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }

  const filtered = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const pixels = Buffer.alloc(height * stride)
  const previous = Buffer.alloc(stride)
  const current = Buffer.alloc(stride)
  let sourceOffset = 0

  for (let y = 0; y < height; y += 1) {
    const filter = filtered[sourceOffset]
    sourceOffset += 1
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[sourceOffset + x]
      const left = x >= 4 ? current[x - 4] : 0
      const above = previous[x]
      const upperLeft = x >= 4 ? previous[x - 4] : 0
      current[x] = (raw + pngFilterDelta(filter, left, above, upperLeft)) & 0xff
    }
    current.copy(pixels, y * stride)
    current.copy(previous)
    sourceOffset += stride
  }

  return { width, height, pixels }
}

function pngMetadata(filePath: string): { width: number; height: number; colorType: number } {
  const bytes = readFileSync(filePath)
  expect(bytes.subarray(1, 4).toString()).toBe('PNG')
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
  }
}

function pngAlphaRange(filePath: string): { min: number; max: number } {
  const { pixels } = decodePng(filePath)
  let min = 255
  let max = 0
  for (let offset = 3; offset < pixels.length; offset += 4) {
    min = Math.min(min, pixels[offset])
    max = Math.max(max, pixels[offset])
  }
  return { min, max }
}

function pngPixel(filePath: string, x: number, y: number): [number, number, number, number] {
  const { width, pixels } = decodePng(filePath)
  const offset = (y * width + x) * 4
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]]
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

interface Provenance {
  selectedAt: string
  selection: string
  source: { assets: Record<string, { sha256: string }> }
  geometry: { symbolPaths: string[] }
  generated: Record<string, { sha256: string; bytes: number }>
}

const provenance = JSON.parse(
  readFileSync(path.join(assetsDir, 'brand-provenance.json'), 'utf8'),
) as Provenance

function icnsChunkTypes(filePath: string): Set<string> {
  const bytes = readFileSync(filePath)
  expect(bytes.subarray(0, 4).toString()).toBe('icns')
  expect(bytes.readUInt32BE(4)).toBe(bytes.length)
  const types = new Set<string>()
  for (let offset = 8; offset < bytes.length;) {
    types.add(bytes.subarray(offset, offset + 4).toString())
    offset += bytes.readUInt32BE(offset + 4)
  }
  return types
}

describe('desktop application icon assets', () => {
  it('keeps transparent outer corners in the 1024px Dock source', () => {
    expect(pngMetadata(path.join(assetsDir, 'icon.png'))).toEqual({
      width: 1024,
      height: 1024,
      colorType: 6,
    })
  })

  it('packages the compiled macOS icon instead of regenerating it from an opaque PNG', () => {
    const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
      build?: { mac?: { icon?: string } }
    }
    expect(manifest.build?.mac?.icon).toBe('assets/icon.icns')
  })

  it('keeps paired 1x and 2x macOS menu-bar template assets for every runtime state', () => {
    for (const state of TRAY_STATES) {
      expect(pngMetadata(path.join(assetsDir, `tray-${state}Template.png`))).toEqual({
        width: 16,
        height: 16,
        colorType: 6,
      })
      expect(pngMetadata(path.join(assetsDir, `tray-${state}Template@2x.png`))).toEqual({
        width: 32,
        height: 32,
        colorType: 6,
      })
      expect(pngAlphaRange(path.join(assetsDir, `tray-${state}Template.png`))).toEqual({
        min: 0,
        max: 255,
      })
      expect(pngAlphaRange(path.join(assetsDir, `tray-${state}Template@2x.png`))).toEqual({
        min: 0,
        max: 255,
      })
    }
  })
})

describe('desktop brand provenance', () => {
  it('records the selected Xpod brand and its pinned source hashes', () => {
    expect(provenance.selection).toBe('B · 留缝折角')
    expect(provenance.selectedAt).toBe('2026-09-26')
    for (const [name, expected] of Object.entries(SELECTED_SOURCE)) {
      expect(provenance.source.assets[name]?.sha256).toBe(expected)
    }
  })

  it('derives the app icon from the selected source raster, not relabelled old art', () => {
    expect(provenance.generated['icon.png']?.sha256).toBe(SELECTED_SOURCE['xpod-app.png'])
    expect(provenance.generated['icon-master.png']?.sha256).toBe(SELECTED_SOURCE['xpod-app.png'])
    expect(sha256File(path.join(assetsDir, 'icon.png'))).toBe(SELECTED_SOURCE['xpod-app.png'])
    expect(sha256File(path.join(assetsDir, 'icon-master.png'))).toBe(SELECTED_SOURCE['xpod-app.png'])
    expect(sha256File(path.join(assetsDir, '../../ui/src/assets/xpod-app.svg'))).toBe(SELECTED_SOURCE['xpod-app.svg'])
  })

  it('keeps the selected paper fold inside an ink tile with transparent outside', () => {
    const icon = path.join(assetsDir, 'icon.png')
    expect(pngPixel(icon, 512, 512)).toEqual([247, 244, 237, 255])
    expect(pngPixel(icon, 0, 0)[3]).toBe(0)
    expect(pngPixel(icon, 1023, 0)[3]).toBe(0)
    expect(pngPixel(icon, 0, 1023)[3]).toBe(0)
    expect(pngPixel(icon, 1023, 1023)[3]).toBe(0)
  })

  it('records generated hashes that still match the files on disk', () => {
    const files = Object.keys(provenance.generated)
    expect(files.length).toBeGreaterThan(30)
    for (const file of files) {
      const record = provenance.generated[file]
      const filePath = path.join(assetsDir, file)
      expect(sha256File(filePath)).toBe(record.sha256)
      expect(readFileSync(filePath).length).toBe(record.bytes)
    }
  })
})

describe('desktop tray template geometry', () => {
  it('imports the selected symbol geometry into every state template', () => {
    for (const state of TRAY_STATES) {
      const svg = readFileSync(path.join(assetsDir, `tray-${state}Template.svg`), 'utf8')
      expect(svg).toContain(SYMBOL_BODY)
      expect(svg).toContain(SYMBOL_FOLD)
    }
    expect(provenance.geometry.symbolPaths).toEqual([SYMBOL_BODY, SYMBOL_FOLD])
  })

  it('drops the superseded shield/X art from the tray templates', () => {
    const legacyShield = 'M8 1.25 13 3.2'
    const legacyX = 'M4 4L14 14'
    const fallback = readFileSync(path.join(assetsDir, 'trayTemplate.svg'), 'utf8')
    expect(fallback).toContain(SYMBOL_BODY)
    expect(fallback).not.toContain(legacyX)
    for (const state of TRAY_STATES) {
      const svg = readFileSync(path.join(assetsDir, `tray-${state}Template.svg`), 'utf8')
      expect(svg).not.toContain(legacyShield)
    }
  })

  it('keeps a distinct single-color state glyph per template', () => {
    const glyphs = TRAY_STATES.map((state) => {
      const svg = readFileSync(path.join(assetsDir, `tray-${state}Template.svg`), 'utf8')
      expect(svg).toContain('fill-rule="evenodd"')
      expect(svg).toContain('fill="#000"')
      return svg
    })
    expect(new Set(glyphs).size).toBe(TRAY_STATES.length)
  })
})

describe('desktop macOS icon packaging', () => {
  it('ships every required iconset slice at the exact pixel size', () => {
    const slices: Array<[string, number]> = [
      ['icon_16x16.png', 16],
      ['icon_16x16@2x.png', 32],
      ['icon_32x32.png', 32],
      ['icon_32x32@2x.png', 64],
      ['icon_128x128.png', 128],
      ['icon_128x128@2x.png', 256],
      ['icon_256x256.png', 256],
      ['icon_256x256@2x.png', 512],
      ['icon_512x512.png', 512],
      ['icon_512x512@2x.png', 1024],
    ]
    for (const [name, size] of slices) {
      expect(pngMetadata(path.join(assetsDir, 'icon.iconset', name))).toEqual({
        width: size,
        height: size,
        colorType: 6,
      })
      expect(pngAlphaRange(path.join(assetsDir, 'icon.iconset', name))).toEqual({
        min: 0,
        max: 255,
      })
    }
  })

  it('compiles a well-formed ICNS with the Dock-size representations', () => {
    const types = icnsChunkTypes(path.join(assetsDir, 'icon.icns'))
    for (const type of ['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']) {
      expect(types.has(type)).toBe(true)
    }
  })

  it('keeps the review preview at the documented strip size', () => {
    expect(pngMetadata(path.join(assetsDir, 'icon-size-preview.png'))).toEqual({
      width: 800,
      height: 160,
      colorType: 2,
    })
  })
})
