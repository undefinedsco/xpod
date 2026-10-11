import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/** The capability runtime owns the only implementation; the applet preserves public forwards.
 * Runtime guards reject React, assets, wording and reverse applet dependencies.
 */

const packageRoot = path.resolve(__dirname, '..')
const sourceRoot = path.join(packageRoot, 'src')
const runtimeRoot = path.resolve(packageRoot, '../ai-connections-runtime')
const contractRoot = path.join(runtimeRoot, 'src/contract')

function contractFiles(): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (absolute.endsWith('.ts') || absolute.endsWith('.tsx')) files.push(absolute)
    }
  }
  walk(contractRoot)
  return files.sort()
}

const contract = new Map(contractFiles().map((file) => [ file, readFileSync(file, 'utf8') ]))

/** True when a relative import in `file` leaves the contract directory. */
function escapesContract(file: string, text: string): boolean {
  for (const match of text.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
    const resolved = path.resolve(path.dirname(file), match[1])
    const relative = path.relative(contractRoot, resolved)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true
  }
  return false
}

describe('canonical ai-connections capability runtime', () => {
  it('reads a directory worth guarding', () => {
    // Guards the guard: an empty or mis-rooted walk would pass everything else.
    expect(contract.size).toBeGreaterThanOrEqual(10)
    expect([ ...contract.keys() ].some((file) => file.endsWith('provider-catalog.ts'))).toBe(true)
    expect([ ...contract.keys() ].some((file) => file.endsWith(path.join('client', 'normalize.ts')))).toBe(true)
  })

  it('carries no React, no component and no applet module', () => {
    const offenders = [ ...contract ]
      .filter(([ file, text ]) =>
        /from\s+['"]react(-dom)?['"]/.test(text)
        || file.endsWith('.tsx')
        || /from\s+['"][^'"]*Ai[A-Z][^'"]*['"]/.test(text)
        // Relative imports may walk around inside the contract, but they must
        // not leave it: reaching `src/AiConnectDialog.tsx` or
        // `src/display-wording.ts` would make the applet part of the contract.
        || escapesContract(file, text))
      .map(([ file ]) => path.relative(sourceRoot, file))
    expect(offenders).toEqual([])
  })

  it('carries no third-party brand asset', () => {
    const offenders = [ ...contract ]
      .filter(([ , text ]) => text.includes('data:image'))
      .map(([ file ]) => path.relative(sourceRoot, file))
    expect(offenders).toEqual([])
  })

  /**
   * These Chinese literals are provider/product names, which are catalog
   * content. Provider labels now have one authority here instead of copies in
   * the UI and server. Action wording and error sentences remain forbidden;
   * only these exact brand names are allowed.
   */
  const FROZEN_USER_FACING_TEXT = [
    'provider-catalog.ts :: \'百炼\'',
    'provider-catalog.ts :: \'智谱 AI\'',
  ]

  it('carries no user-facing wording beyond the frozen list', () => {
    // Comments may be Chinese - the repository documents in Chinese. What must
    // not appear is a Chinese *string literal*, which is text a user reads.
    const offenders = new Set<string>()
    for (const [ file, text ] of contract) {
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
        for (const literal of line.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
          if (/[\u4e00-\u9fff]/.test(literal[0])) {
            offenders.add(`${path.relative(contractRoot, file)} :: ${literal[0]}`)
          }
        }
      }
    }
    expect([ ...offenders ].sort()).toEqual(FROZEN_USER_FACING_TEXT.sort())
  })

  it('publishes both layers from the one package that owns them', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, { import?: string }>
    }
    // The interoperability subpaths are what the gateway and the scripts read.
    for (const subpath of [ './client', './provider-catalog', './client-config', './endpoint-urls', './service-access-resources' ]) {
      expect(manifest.exports[subpath]?.import, `${subpath} must stay exported`).toBeTruthy()
    }
    // The old public paths remain forwards, while only the runtime owns implementations.
    for (const subpath of [ '.', './manifest' ]) {
      expect(manifest.exports[subpath]?.import, `${subpath} must stay exported`).toBeTruthy()
    }
    expect(Object.keys(manifest.exports).sort()).toEqual(
      [ '.', './client', './client-config', './endpoint-urls', './manifest', './provider-catalog', './service-access-resources' ],
    )
  })

  it('keeps installation dependencies and implementation authority separate', () => {
    const runtime = JSON.parse(readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'))
    expect(Object.keys(runtime.dependencies).sort()).toEqual(['@undefineds.co/extension-host-contracts', '@undefineds.co/models'])
    expect(runtime.peerDependencies).toBeUndefined()
    for (const filename of ['ai-connections-client.ts', 'provider-catalog.ts', 'endpoint-urls.ts', 'credential-storage.ts']) {
      const adapter = readFileSync(path.join(sourceRoot, 'contract', filename), 'utf8')
      expect(adapter).toContain('@undefineds.co/ai-connections-runtime/')
      expect(adapter).not.toMatch(/(?:class|function|const)\s+/)
    }
  })

  it('keeps the applet wording in the applet layer', () => {
    // The table that words the connect entries lives with the applet. If a copy
    // ever reappears in the contract, the guard above fails on the literal - this
    // names the reason, so the failure reads as a boundary breach rather than a
    // stray string.
    const wordingPath = path.join(sourceRoot, 'display-wording.ts')
    expect(existsSync(wordingPath)).toBe(true)
    const wording = readFileSync(wordingPath, 'utf8')
    expect(wording).toContain('添加 API Key')
    expect(wording).toContain('浏览器登录')
  })

  it('keeps the applet-only files out of the contract directory', () => {
    // The contract is a directory, not a convention: components and brand
    // artwork belong next to the applet in `src`, never inside `src/contract`.
    const appletOnlyFiles = readdirSync(sourceRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && (entry.name.endsWith('.tsx') || entry.name === 'provider-visuals.ts'))
      .map((entry) => entry.name)
    expect(appletOnlyFiles.length).toBeGreaterThan(0)
    for (const name of appletOnlyFiles) {
      expect(statSync(path.join(contractRoot, name), { throwIfNoEntry: false })).toBeUndefined()
    }
  })
})
