import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'

const assetsDir = path.join(import.meta.dir, '..', 'assets')

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
  const bytes = readFileSync(filePath)
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
  const previous = Buffer.alloc(stride)
  const current = Buffer.alloc(stride)
  let min = 255
  let max = 0
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
    for (let x = 3; x < stride; x += 4) {
      min = Math.min(min, current[x])
      max = Math.max(max, current[x])
    }
    current.copy(previous)
    sourceOffset += stride
  }
  return { min, max }
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
    for (const state of ['healthy', 'starting', 'degraded', 'failed', 'stopped']) {
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
