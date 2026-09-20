import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The package serves two audiences, and they must not blur.
 *
 * `@undefineds.co/ai-connections` is published (`private: false`) and the server
 * imports it through its subpaths (`/client`, `/provider-catalog`,
 * `/client-config`, `/manifest`) while the browser applet imports the root entry.
 * Anything the *server* can reach is a shared, open, interoperable surface: it
 * may describe what a provider is and how to talk to it, and nothing else.
 *
 * What must never appear there:
 *
 * - **React or components** - behaviour belongs to the applet (`AGENTS.md`:
 *   行为留 applet).
 * - **Third-party brand assets** - the provider logos are trademarks; shipping
 *   them inside the shared contract surface would put them in every consumer's
 *   bundle by default. They live in `provider-visuals.ts`, which only the applet
 *   entry reaches.
 * - **Product copy** - user-facing wording is the applet's, and the ownership doc
 *   already assigns `label` / `consoleUrl` / `subscriptionUrl` / provider-level
 *   `region` there rather than to the shared catalog.
 *
 * The check walks the *transitive* import closure of the contract entries, so a
 * new module added behind them is covered without editing this list.
 */

const packageRoot = path.resolve(__dirname, '..')
const sourceRoot = path.join(packageRoot, 'src')

/** Entry files reachable through the package's published contract subpaths. */
const CONTRACT_ENTRIES = [
  'ai-connections-client.ts',
  'provider-catalog.ts',
  'manifest.ts',
  path.join('client-config', 'index.ts'),
]

const IMPORT_PATTERN = /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/g

function modulePath(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [ `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base ]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function contractClosure(): Map<string, string> {
  const seen = new Map<string, string>()
  const queue = CONTRACT_ENTRIES.map((entry) => path.join(sourceRoot, entry))
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    const source = readFileSync(file, 'utf8')
    seen.set(file, source)
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const resolved = modulePath(file, match[1]!)
      if (resolved && resolved.startsWith(sourceRoot)) queue.push(resolved)
    }
  }
  return seen
}

describe('shared contract surface', () => {
  const closure = contractClosure()

  it('reaches a meaningful part of the package', () => {
    // Guards the guard: a broken resolver would make every other assertion pass.
    expect(closure.size).toBeGreaterThanOrEqual(5)
    expect([ ...closure.keys() ].some((file) => file.endsWith('provider-catalog.ts'))).toBe(true)
  })

  it('pulls in no React and no component module', () => {
    const offenders = [ ...closure ]
      .filter(([ file, source ]) =>
        /from\s+['"]react(-dom)?['"]/.test(source)
        || file.endsWith('.tsx')
        || /from\s+['"][^'"]*Ai[A-Z][^'"]*['"]/.test(source))
      .map(([ file ]) => path.relative(sourceRoot, file))
    expect(offenders).toEqual([])
  })

  it('carries no third-party brand asset', () => {
    const offenders = [ ...closure ]
      .filter(([ , source ]) => source.includes('data:image'))
      .map(([ file ]) => path.relative(sourceRoot, file))
    expect(offenders).toEqual([])
  })

  /**
   * Product copy is a **ratchet**, not a clean assertion yet.
   *
   * The ownership doc already assigns auth-method labels and provider display
   * names to the applet, but the shared catalog still carries eight of them. The
   * test therefore freezes exactly those: adding a ninth fails here, and moving
   * one out is the intended next step (see `docs/package-boundary.md`). The list
   * is keyed by `module :: literal` so moving code around does not churn it.
   */
  const FROZEN_PRODUCT_COPY = [
    'provider-catalog.ts :: \'添加 API Key\'',
    'provider-catalog.ts :: \'浏览器登录\'',
    'provider-catalog.ts :: \'智谱 AI\'',
    'provider-catalog.ts :: \'百炼\'',
    'provider-catalog.ts :: \'设备码登录\'',
    'provider-catalog.ts :: \'已有登录态\'',
  ]

  it('carries no new user-facing product copy', () => {
    // Comments may be Chinese - the repository documents in Chinese. What must
    // not appear is a Chinese *string literal*, which is product wording.
    const offenders = new Set<string>()
    for (const [ file, source ] of closure) {
      for (const line of source.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
        for (const literal of line.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
          if (/[\u4e00-\u9fff]/.test(literal[0])) {
            offenders.add(`${path.relative(sourceRoot, file)} :: ${literal[0]}`)
          }
        }
      }
    }
    expect([ ...offenders ].sort()).toEqual(FROZEN_PRODUCT_COPY.sort())
  })

  it('keeps the published contract subpaths pointing at contract modules', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, { import?: string }>
    }
    for (const subpath of [ './client', './provider-catalog', './client-config', './manifest' ]) {
      const entry = manifest.exports[subpath]?.import
      expect(entry, `${subpath} must stay exported`).toBeTruthy()
    }
    // The root entry is the applet: it is the only one allowed to pull React in.
    expect(manifest.exports['.']?.import).toBeTruthy()
  })
})
