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

/**
 * Both `import` and `export ... from` are traversed, and that matters: the
 * published `/client` entry is a barrel that reaches payload normalisation
 * through `export { ... } from './client/normalize'`. An import-only walk
 * reported a clean surface while seventeen user-facing error messages sat one
 * re-export away, which is why the closure assertions below name the modules the
 * walk has to reach.
 */
const IMPORT_PATTERN = /(?:\bimport\b|\bexport\b)[^'";()]*?\bfrom\s+['"]([^'"]+)['"]/g

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
    // These two are reached only through `export ... from`, so their presence is
    // what proves the walk follows re-exports rather than only imports.
    expect([ ...closure.keys() ].some((file) => file.endsWith(path.join('client', 'normalize.ts')))).toBe(true)
    expect([ ...closure.keys() ].some((file) => file.endsWith(path.join('client', 'request.ts')))).toBe(true)
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
   * What is left is a **ratchet**, and it is two different debts.
   *
   * One entry is a product *name*: `productLabel` on two of Zhipu's offerings.
   * That is catalog content rather than UI wording - it names the vendor, it is
   * not reworded per screen, and this package is where names live.
   *
   * The other seventeen are user-facing error messages in
   * `client/normalize.ts`, and they are the next slice rather than an accepted
   * state: the client formats text where it should throw a typed failure, and the
   * applet should render the sentence - the same split the connect-entry wording
   * already went through. Until then the list is frozen instead of ignored, so
   * nothing new can appear and the entries can only be removed. Each line carries
   * the module that holds it, so a move shows up as a deletion plus an addition
   * rather than silently.
   */
  const FROZEN_PRODUCT_COPY = [
    // Catalog content: the vendor's own name.
    'provider-catalog.ts :: \'智谱 AI\'',
    // Debt: error wording the client should hand to the applet as a typed failure.
    'client/normalize.ts :: \' 上游返回：\'',
    'client/normalize.ts :: \'Pod 中未找到此 API Key 的原文，无法复制配置。请创建新的 Key，更新客户端后再删除旧 Key。\'',
    'client/normalize.ts :: \'代理地址必须是无账号密码的 HTTP 或 HTTPS 地址。\'',
    'client/normalize.ts :: \'密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。\'',
    'client/normalize.ts :: \'当前凭证密钥不可用，请重新保存后再查询额度。\'',
    'client/normalize.ts :: \'当前身份没有可用的额度凭证。\'',
    'client/normalize.ts :: \'模型列表获取失败。请检查密钥、服务地址或网络后重试。\'',
    'client/normalize.ts :: \'模型已获取，但保存到 Pod 失败。请重试同步模型。\'',
    'client/normalize.ts :: \'模型服务地址不正确。请检查服务地址后重试。\'',
    'client/normalize.ts :: \'模型服务暂时没有响应。请稍后重试。\'',
    'client/normalize.ts :: \'订阅登录态不可用，请重读登录态或重新登录后再同步模型。\'',
    'client/normalize.ts :: \'订阅登录态已失效，请在原客户端重新登录后重读，或使用设备码登录。\'',
    'client/normalize.ts :: \'订阅登录态自动刷新失败，请稍后重试。\'',
    'client/normalize.ts :: \'该接入方式不支持查询官方额度。\'',
    'client/normalize.ts :: \'该服务地址指向 Xpod 不允许访问的网络，请改用公网 HTTPS 地址。\'',
    'client/normalize.ts :: \'请求太频繁。请稍等一会儿再试。\'',
    'client/normalize.ts :: `${message} 上游返回：${sanitized}`',
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
