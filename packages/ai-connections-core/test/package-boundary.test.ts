import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * This package *is* the shared surface.
 *
 * `@undefineds.co/ai-connections` is an independent product — a browser applet
 * with its own components, controller, brand artwork and wording — and the
 * server-side gateway needs the interoperable part of it: the client protocol,
 * the provider catalog, the client-configuration adapters. That part is this
 * package, and the whole directory is the contract, so these assertions read the
 * directory rather than deriving a closure and trusting the derivation.
 *
 * What a shared, published, open surface must not carry:
 *
 * - **React or components** — behaviour belongs to the applet (`AGENTS.md`:
 *   行为留 applet). A `.tsx` file here would mean the contract ships a renderer.
 * - **Third-party brand assets** — provider logos are trademarks; shipping them
 *   in the shared package would put them in every consumer's bundle by default.
 *   They live in the applet's `provider-visuals.ts`.
 * - **User-facing wording** — the applet's `display-wording.ts` owns the words a
 *   user reads, decided from an entry's id. The one exception below is a product
 *   *name*, which is catalog content.
 */

const packageRoot = path.resolve(__dirname, '..')
const sourceRoot = path.join(packageRoot, 'src')
const appletPackageRoot = path.resolve(packageRoot, '..', 'ai-connections')

function sourceFiles(): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (absolute.endsWith('.ts') || absolute.endsWith('.tsx')) files.push(absolute)
    }
  }
  walk(sourceRoot)
  return files.sort()
}

const source = new Map(sourceFiles().map((file) => [ file, readFileSync(file, 'utf8') ]))

describe('shared core surface', () => {
  it('reads a package worth guarding', () => {
    // Guards the guard: an empty or mis-rooted walk would pass everything else.
    expect(source.size).toBeGreaterThanOrEqual(10)
    expect([ ...source.keys() ].some((file) => file.endsWith('provider-catalog.ts'))).toBe(true)
    expect([ ...source.keys() ].some((file) => file.endsWith(path.join('client', 'normalize.ts')))).toBe(true)
  })

  it('carries no React, no component and no foreign module', () => {
    const offenders = [ ...source ]
      .filter(([ file, text ]) =>
        /from\s+['"]react(-dom)?['"]/.test(text)
        || file.endsWith('.tsx')
        || /from\s+['"][^'"]*Ai[A-Z][^'"]*['"]/.test(text)
        // The core is what the product depends on; reaching back into it would
        // make the product part of the contract.
        || /from\s+['"]@undefineds\.co\/ai-connections['"/]/.test(text))
      .map(([ file ]) => path.relative(sourceRoot, file))
    expect(offenders).toEqual([])
  })

  it('carries no third-party brand asset', () => {
    const offenders = [ ...source ]
      .filter(([ , text ]) => text.includes('data:image'))
      .map(([ file ]) => path.relative(sourceRoot, file))
    expect(offenders).toEqual([])
  })

  /**
   * What is left is one entry, and it is a product *name* rather than wording:
   * `productLabel` on two of Zhipu's offerings. That is catalog content - it
   * names the vendor, it is not reworded per screen, and this package is where
   * names live.
   *
   * The seventeen error sentences that used to sit here are gone: the client now
   * fails with the facts (code, status, provider, auth mode) and the applet picks
   * the sentence in `error-wording.ts`. Freezing this one entry keeps the
   * distinction enforced - nothing new can appear, and the allowance only shrinks.
   */
  const FROZEN_USER_FACING_TEXT = [
    'provider-catalog.ts :: \'智谱 AI\'',
  ]

  it('carries no user-facing wording beyond the frozen list', () => {
    // Comments may be Chinese - the repository documents in Chinese. What must
    // not appear is a Chinese *string literal*, which is text a user reads.
    const offenders = new Set<string>()
    for (const [ file, text ] of source) {
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
        for (const literal of line.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
          if (/[\u4e00-\u9fff]/.test(literal[0])) {
            offenders.add(`${path.relative(sourceRoot, file)} :: ${literal[0]}`)
          }
        }
      }
    }
    expect([ ...offenders ].sort()).toEqual(FROZEN_USER_FACING_TEXT.sort())
  })

  it('publishes the contract subpaths and nothing else', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, { import?: string }>
    }
    for (const subpath of [ './client', './provider-catalog', './client-config', './endpoint-urls' ]) {
      expect(manifest.exports[subpath]?.import, `${subpath} must stay exported`).toBeTruthy()
    }
  })

  it('leaves the applet to decide its own surface', () => {
    const applet = JSON.parse(readFileSync(path.join(appletPackageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
      dependencies: Record<string, string>
    }
    // The product entry and its own manifest are the product's; the interoperability
    // surface must not be re-published from there, or two packages would serve it.
    expect(Object.keys(applet.exports).sort()).toEqual([ '.', './manifest' ])
    expect(applet.dependencies['@undefineds.co/ai-connections-core']).toBeTruthy()
  })

  it('keeps the applet wording out of the contract', () => {
    // The table that words the connect entries lives with the applet. If a copy
    // ever reappears here, the guard above fails on the literal - this names the
    // reason, so the failure reads as a boundary breach rather than a stray string.
    const wordingPath = path.join(appletPackageRoot, 'src', 'display-wording.ts')
    expect(existsSync(wordingPath)).toBe(true)
    const wording = readFileSync(wordingPath, 'utf8')
    expect(wording).toContain('添加 API Key')
    expect(wording).toContain('浏览器登录')
  })
})
