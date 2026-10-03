#!/usr/bin/env node
/**
 * Deterministic desktop brand asset generator.
 *
 * Imports the selected Xpod brand geometry from the sibling homepage checkout
 * (`homepage/public/brand`) and regenerates every product asset under
 * `desktop/assets/`. No new dependencies: it only shells out to the macOS
 * system tools `sips` / `iconutil` and the already-installed ImageMagick.
 *
 * The selected brand is "Xpod B · 留缝折角" (selectedAt 2026-09-26). Source
 * hashes are pinned below so a drifted or relabelled source fails loudly
 * instead of silently producing wrong art.
 *
 * Usage:
 *   node desktop/scripts/generate-brand-assets.mjs [sourceDir]
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(scriptDir, '..')
const assetsDir = path.join(desktopDir, 'assets')
const iconsetDir = path.join(assetsDir, 'icon.iconset')

const sourceDir = process.argv[2] || path.resolve(desktopDir, '../../homepage/public/brand')

/** Authoritative values from homepage/public/brand/manifest.json (2026-09-26). */
const SELECTED_AT = '2026-09-26'
const SELECTION = 'B · 留缝折角'
const SOURCE_ASSETS = {
  'xpod-app.png': {
    sha256: '415585c548edc845d4f74bd811b6d4c8516d3c8fa3e0337d8e3e86e5152d2ab8',
    role: 'App/Dock/installer master raster (1024px, transparent outside rounded tile)',
  },
  'xpod-app.svg': {
    sha256: 'a7eacfade11a11252a65c0e7b691b095f06c9b3af749fc68d1fcfb177df7656b',
    role: 'App tile geometry authority (ink tile + paper fold)',
  },
  'xpod-symbol.svg': {
    sha256: '1d6f23f4256fe442bdb22ad34e0edc231896e97d9a29feeafdf897462f898a49',
    role: 'Single-color symbol geometry authority for menu-bar templates',
  },
}

/** macOS iconset slice names and their pixel sizes. */
const ICONSET_SLICES = [
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

/**
 * State glyphs are our own content (not brand geometry): each is a subpath in
 * the symbol's `18 18 64 64` coordinate space, punched out of the imported
 * silhouette with fill-rule="evenodd" so the template stays single-color.
 */
const STATE_GLYPHS = {
  healthy: 'M43 58.5 49.5 65 64 50.5 60.5 47 49.5 58 46.5 55Z',
  starting:
    'M52 49a11 11 0 1 0 0 22 11 11 0 1 0 0-22Z M50 50H54V57.8H61V62.2H50Z',
  degraded: 'M44 57.5H60V62.5H44Z',
  failed:
    'M50 50H54V61H50Z M50.5 63.5A1.5 1.5 0 1 0 53.5 63.5 1.5 1.5 0 1 0 50.5 63.5Z',
  stopped: 'M45.5 53.5H58.5V66.5H45.5Z',
}

const TRAY_STATES = Object.keys(STATE_GLYPHS)

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function sha256File(filePath) {
  return sha256(readFileSync(filePath))
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function magickVersion() {
  return run('magick', ['-version']).split('\n')[0].trim()
}

function sourcePath(name) {
  return path.join(sourceDir, name)
}

function verifySource() {
  const records = {}
  for (const [name, expected] of Object.entries(SOURCE_ASSETS)) {
    const filePath = sourcePath(name)
    let bytes
    try {
      bytes = readFileSync(filePath)
    } catch {
      throw new Error(`Missing brand source ${filePath}`)
    }
    const actual = sha256(bytes)
    if (actual !== expected.sha256) {
      throw new Error(
        `Brand source drift for ${name}: expected ${expected.sha256}, got ${actual}`,
      )
    }
    records[name] = { sha256: actual, role: expected.role, bytes: bytes.length }
  }
  return records
}

function readSymbolGeometry() {
  const svg = readFileSync(sourcePath('xpod-symbol.svg'), 'utf8')
  const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1])
  if (paths.length !== 2) {
    throw new Error(`Expected 2 symbol paths, found ${paths.length}`)
  }
  return paths
}

function writeTraySvg(fileName, symbolPaths, glyph) {
  const subpaths = glyph ? [...symbolPaths, glyph] : symbolPaths
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 64 64">\n' +
    `<path fill="#000" fill-rule="evenodd" d="${subpaths.join(' ')}"/>\n` +
    '</svg>\n'
  writeFileSync(path.join(assetsDir, fileName), svg)
}

function rasterizeSvg(svgPath, outPath, size, { color = 'black' } = {}) {
  const args = [
    '-background',
    'none',
    svgPath,
    '-resize',
    `${size}x${size}`,
  ]
  if (color !== 'black') {
    // Recolor the single-color geometry without changing its alpha.
    args.push('-fill', color, '-colorize', '100')
  }
  args.push(
    '-strip',
    '-define',
    'png:exclude-chunks=date,time',
    '-define',
    'png:color-type=6',
    `PNG32:${outPath}`,
  )
  run('magick', args)
}

function buildAppIcon() {
  copyFileSync(sourcePath('xpod-app.png'), path.join(assetsDir, 'icon.png'))
  copyFileSync(sourcePath('xpod-app.png'), path.join(assetsDir, 'icon-master.png'))
  copyFileSync(sourcePath('xpod-app.svg'), path.resolve(desktopDir, '../ui/src/assets/xpod-app.svg'))
  const providerVisualsPath = path.resolve(desktopDir, '../packages/ai-connections/src/provider-visuals.ts')
  const providerVisuals = readFileSync(providerVisualsPath, 'utf8')
  const avatarPattern = /export const XPOD_AVATAR =\n  'data:image\/svg\+xml;base64,[^']*'/
  if (!avatarPattern.test(providerVisuals)) {
    throw new Error('Cannot locate the existing XPOD_AVATAR declaration')
  }
  const avatar = readFileSync(sourcePath('xpod-app.svg')).toString('base64')
  writeFileSync(providerVisualsPath, providerVisuals.replace(
    avatarPattern,
    `export const XPOD_AVATAR =\n  'data:image/svg+xml;base64,${avatar}'`,
  ))
}

function buildIconset() {
  rmSync(iconsetDir, { recursive: true, force: true })
  mkdirSync(iconsetDir, { recursive: true })
  const master = path.join(assetsDir, 'icon-master.png')
  for (const [name, size] of ICONSET_SLICES) {
    run('sips', ['-z', String(size), String(size), master, '--out', path.join(iconsetDir, name)])
  }
  run('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(assetsDir, 'icon.icns')])
}

function buildPreview() {
  const master = path.join(assetsDir, 'icon-master.png')
  const out = path.join(assetsDir, 'icon-size-preview.png')
  const layouts = [
    [128, 24, 16],
    [64, 184, 48],
    [32, 280, 64],
    [16, 336, 72],
  ]
  const args = ['-size', '800x160', 'xc:#F7F4ED']
  for (const [size, x, y] of layouts) {
    args.push('(', master, '-resize', `${size}x${size}`, ')', '-geometry', `+${x}+${y}`, '-composite')
  }
  args.push('-strip', '-define', 'png:exclude-chunks=date,time', out)
  run('magick', args)
}

function buildTrayAssets(symbolPaths) {
  for (const state of TRAY_STATES) {
    writeTraySvg(`tray-${state}Template.svg`, symbolPaths, STATE_GLYPHS[state])
  }
  // Legacy single-color fallback template (no state glyph).
  writeTraySvg('trayTemplate.svg', symbolPaths, null)

  for (const state of TRAY_STATES) {
    const svg = path.join(assetsDir, `tray-${state}Template.svg`)
    rasterizeSvg(svg, path.join(assetsDir, `tray-${state}Template.png`), 16)
    rasterizeSvg(svg, path.join(assetsDir, `tray-${state}Template@2x.png`), 32)
  }

  const templateSvg = path.join(assetsDir, 'trayTemplate.svg')
  rasterizeSvg(templateSvg, path.join(assetsDir, 'trayTemplate.png'), 16)
  rasterizeSvg(templateSvg, path.join(assetsDir, 'trayTemplate@2x.png'), 32)

  // Colored product tray fallbacks (ink symbol, transparent background).
  const inkSvg = path.join(assetsDir, 'trayTemplate.svg')
  rasterizeSvg(inkSvg, path.join(assetsDir, 'tray.png'), 32, { color: '#563E84' })
  rasterizeSvg(inkSvg, path.join(assetsDir, 'tray@2x.png'), 64, { color: '#563E84' })
}

function hashGeneratedAssets() {
  const files = [
    'icon.png',
    'icon-master.png',
    'icon.icns',
    'icon-size-preview.png',
    ...ICONSET_SLICES.map(([name]) => `icon.iconset/${name}`),
    ...TRAY_STATES.flatMap((state) => [
      `tray-${state}Template.svg`,
      `tray-${state}Template.png`,
      `tray-${state}Template@2x.png`,
    ]),
    'trayTemplate.svg',
    'trayTemplate.png',
    'trayTemplate@2x.png',
    'tray.png',
    'tray@2x.png',
  ]
  const records = {}
  for (const file of files) {
    const filePath = path.join(assetsDir, file)
    statSync(filePath)
    records[file] = { sha256: sha256File(filePath), bytes: statSync(filePath).size }
  }
  return records
}

function main() {
  mkdirSync(assetsDir, { recursive: true })
  const source = verifySource()
  const symbolPaths = readSymbolGeometry()

  buildAppIcon()
  buildIconset()
  buildPreview()
  buildTrayAssets(symbolPaths)

  const generated = hashGeneratedAssets()
  const provenance = {
    selectedAt: SELECTED_AT,
    selection: SELECTION,
    source: {
      directory: 'homepage/public/brand',
      manifest: 'homepage/public/brand/manifest.json',
      assets: source,
    },
    geometry: {
      viewBox: '18 18 64 64',
      symbolPaths,
      appTile:
        'xpod-app.svg: rect x=10 y=10 width=80 height=80 rx=18 fill #563E84; paper fold #F7F4ED',
      note: 'Tray geometry is extracted verbatim from xpod-symbol.svg; state glyphs are product content punched out with evenodd.',
    },
    generation: {
      script: 'desktop/scripts/generate-brand-assets.mjs',
      tools: {
        magick: magickVersion(),
        sips: 'macOS sips (iconset slices)',
        iconutil: 'macOS iconutil (icns packaging)',
      },
      steps: [
        'verify xpod-app.png / xpod-app.svg / xpod-symbol.svg sha256 against pinned selected-source hashes',
        'copy selected xpod-app.png to icon.png and icon-master.png verbatim',
        'copy selected xpod-app.svg verbatim to ui/src/assets/xpod-app.svg for XpodLoginBrand',
        'inline the same selected xpod-app.svg in the existing ai-connections XPOD_AVATAR declaration',
        'derive icon.iconset slices with sips -z and package icon.icns with iconutil',
        'compose icon-size-preview.png from icon-master.png on paper background',
        'extract xpod-symbol.svg path geometry and emit tray template SVGs with evenodd state glyphs',
        'rasterize tray PNG pairs at 16/32 (and 32/64 color fallbacks) with ImageMagick PNG32',
      ],
    },
    generated,
  }
  writeFileSync(
    path.join(assetsDir, 'brand-provenance.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
  )

  console.log(
    `Regenerated ${Object.keys(generated).length} desktop brand assets from ${sourceDir} (${SELECTION}).`,
  )
}

main()
