import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ClaudeCodeConfigAdapter,
  CodeBuddyConfigAdapter,
  CodexConfigAdapter,
  PiConfigAdapter,
  hashWebId,
} from '../src/client-config'

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const XPOD_CLIENT_CREDENTIAL = 'sk-Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ='
const PROVIDER_API_KEY = 'sk-real-provider-secret'

function tempHome(): string {
  const root = path.resolve(import.meta.dirname, '../../../.test-data/client-config-adapters')
  fs.mkdirSync(root, { recursive: true })
  return fs.mkdtempSync(path.join(root, 'home-'))
}

function parseToml(content: string): Record<string, any> {
  return JSON.parse(execFileSync('bun', ['-e',
    'console.log(JSON.stringify(Bun.TOML.parse(await Bun.stdin.text())))',
  ], { input: content, encoding: 'utf8' }))
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: 'https://pod.example/alice/api/ai',
    apiKey: XPOD_CLIENT_CREDENTIAL,
    webId: WEB_ID,
    model: 'gpt-5.4',
    activeModels: [{ id: 'gpt-5.4', provider: 'openai', availability: 'available' }],
    ...overrides,
  }
}

function redactGeneratedConfig<T extends Record<string, string>>(generated: T): T {
  return Object.fromEntries(
    Object.entries(generated).map(([key, value]) => [
      key,
      value.replaceAll(XPOD_CLIENT_CREDENTIAL, '[xpod-client-credential]'),
    ]),
  ) as T
}

async function legacyCodex(home: string, original?: Record<string, unknown>) {
  const dir = path.join(home, '.codex')
  const configPath = path.join(dir, 'config.toml')
  const authPath = path.join(dir, 'auth.json')
  const statePath = path.join(dir, '.xpod-ai-connections-codex.json')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(configPath, 'model_provider = "openai"\nmodel = "native-model"\n')
  const adapter = new CodexConfigAdapter({ homeDir: home })
  await adapter.apply(await adapter.plan(profile()))
  const config = fs.readFileSync(configPath, 'utf8')
    .replace(/^experimental_bearer_token.*\n/m, '').replace('requires_openai_auth = false', 'requires_openai_auth = true')
  fs.writeFileSync(configPath, config)
  const auth = JSON.stringify({ ...original, auth_mode: 'apikey', OPENAI_API_KEY: XPOD_CLIENT_CREDENTIAL })
  fs.writeFileSync(authPath, auth)
  const backupPath = `${authPath}.original`
  if (original) fs.writeFileSync(backupPath, JSON.stringify(original))
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  state.files.push({ path: authPath, existed: !!original, ...(original ? { backupPath } : {}) })
  state.projectionHashes[configPath] = createHash('sha256').update(config).digest('hex')
  state.projectionHashes[authPath] = createHash('sha256').update(auth).digest('hex')
  fs.writeFileSync(statePath, JSON.stringify(state))
  return { adapter, configPath, authPath, statePath, backupPath }
}

describe('publishable AI client config adapters', () => {
  it.each([CodexConfigAdapter, ClaudeCodeConfigAdapter, CodeBuddyConfigAdapter, PiConfigAdapter])('preserves user model settings without a catalog: %s', async (Adapter) => {
    const home = tempHome()
    try {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
      fs.writeFileSync(path.join(home, '.codex/config.toml'), 'model = "user-model"\nmodel_reasoning_effort = "high"\n')
      for (const dir of ['.claude', '.codebuddy', '.pi/agent']) {
        fs.mkdirSync(path.join(home, dir), { recursive: true })
        fs.writeFileSync(path.join(home, dir, 'settings.json'), JSON.stringify({ model: 'user-model', defaultModel: 'user-model', custom: true }))
      }
      const connection = profile({ model: undefined, activeModels: undefined })
      const adapter = new Adapter({ homeDir: home })
      await adapter.apply(await adapter.plan(connection))
      expect(await adapter.verify(connection)).toEqual({ ok: true })
      if (Adapter === CodexConfigAdapter) {
        expect(parseToml(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8'))).toMatchObject({ model: 'user-model', model_reasoning_effort: 'high' })
      } else {
        const dir = Adapter === PiConfigAdapter ? '.pi/agent' : Adapter === ClaudeCodeConfigAdapter ? '.claude' : '.codebuddy'
        expect(JSON.parse(fs.readFileSync(path.join(home, dir, 'settings.json'), 'utf8'))).toMatchObject({ model: 'user-model', defaultModel: 'user-model', custom: true })
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('projects gateway model ids into a native Codex catalog without changing the selected model', async () => {
    const home = tempHome()
    try {
      const dir = path.join(home, '.codex')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "user-model"\n')
      const adapter = new CodexConfigAdapter({ homeDir: home })
      const connection = profile({ model: undefined, activeModels: [
        { id: 'kimi-k2.5', provider: 'moonshot', displayName: 'Kimi K2.5', contextWindow: 262144, inputModalities: ['text', 'image'] },
        { id: 'deepseek-reasoner', provider: 'deepseek', displayName: 'DeepSeek Reasoner', capabilities: ['reasoning'] },
      ] })
      await adapter.apply(await adapter.plan(connection))
      const config = parseToml(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'))
      expect(config.model).toBe('user-model')
      expect(config.model_catalog_json).toBe(path.join(dir, 'xpod-model-catalog.json'))
      const catalog = JSON.parse(fs.readFileSync(config.model_catalog_json, 'utf8'))
      expect(catalog.models.map((model: { slug: string }) => model.slug)).toEqual(['kimi-k2.5', 'deepseek-reasoner'])
      expect(catalog.models[0]).toMatchObject({ display_name: 'Kimi K2.5', context_window: 262144, input_modalities: ['text', 'image'] })
      expect(catalog.models[1]).toMatchObject({
        default_reasoning_level: 'high',
        supported_reasoning_levels: [
          { effort: 'low', description: 'DeepSeek low reasoning depth' },
          { effort: 'high', description: 'DeepSeek standard reasoning depth' },
          { effort: 'max', description: 'DeepSeek maximum reasoning depth' },
        ],
      })
      expect(await adapter.verify(connection)).toEqual({ ok: true })
      expect((await adapter.inspect()).projectionMatches).toBe(true)
      await adapter.restore(WEB_ID)
      expect(fs.existsSync(config.model_catalog_json)).toBe(false)
      expect(parseToml(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'))).toEqual({ model: 'user-model' })
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('upgrades config-only ownership without drift and restores a pre-existing catalog backup', async () => {
    const home = tempHome()
    try {
      const adapter = new CodexConfigAdapter({ homeDir: home })
      const connection = profile({ model: undefined, activeModels: undefined })
      await adapter.apply(await adapter.plan(connection))
      const catalogPath = path.join(home, '.codex/xpod-model-catalog.json')
      expect(fs.existsSync(catalogPath)).toBe(false)
      expect((await adapter.inspect()).projectionMatches).toBe(true)
      const originalCatalog = '{"models": [], "user": true}'
      fs.writeFileSync(catalogPath, originalCatalog)
      const upgraded = profile({ model: undefined, activeModels: [{ id: 'deepseek-chat' }] })
      await adapter.apply(await adapter.plan(upgraded))
      const applied = fs.readFileSync(catalogPath, 'utf8')
      expect(JSON.parse(applied).models[0].slug).toBe('deepseek-chat')
      expect(parseToml(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8')).model_catalog_json).toBe(catalogPath)
      await adapter.apply(await adapter.plan(connection))
      expect(fs.readFileSync(catalogPath, 'utf8')).toBe(applied)
      const beforeEmpty = fs.readdirSync(path.join(home, '.codex')).map((file) => [file, fs.readFileSync(path.join(home, '.codex', file), 'utf8')])
      await expect(adapter.plan({ ...connection, activeModels: [] })).rejects.toMatchObject({ code: 'model_catalog_empty' })
      expect(fs.readdirSync(path.join(home, '.codex')).map((file) => [file, fs.readFileSync(path.join(home, '.codex', file), 'utf8')])).toEqual(beforeEmpty)
      await adapter.restore(WEB_ID)
      expect(fs.readFileSync(catalogPath, 'utf8')).toBe(originalCatalog)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('restores the original catalog pointer and rolls back a failed catalog write', async () => {
    const home = tempHome()
    try {
      const dir = path.join(home, '.codex')
      fs.mkdirSync(dir, { recursive: true })
      const configPath = path.join(dir, 'config.toml')
      const catalogPath = path.join(dir, 'xpod-model-catalog.json')
      const original = 'model = "native-model"\nmodel_catalog_json = "/user/catalog.json"\n'
      fs.writeFileSync(configPath, original)
      const adapter = new CodexConfigAdapter({ homeDir: home })
      const connection = profile({ model: undefined })
      const plan = await adapter.plan(connection)
      const rename = fs.promises.rename.bind(fs.promises)
      const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (to === catalogPath) throw new Error('catalog write failed')
        return rename(from, to)
      })
      try { await expect(new CodexConfigAdapter({ homeDir: home }).apply(plan)).rejects.toThrow('catalog write failed') }
      finally { spy.mockRestore() }
      expect(fs.readFileSync(configPath, 'utf8')).toBe(original)
      expect(fs.existsSync(catalogPath)).toBe(false)
      await adapter.apply(await adapter.plan(connection))
      await adapter.restore(WEB_ID)
      expect(parseToml(fs.readFileSync(configPath, 'utf8'))).toEqual({ model: 'native-model', model_catalog_json: '/user/catalog.json' })
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it.each([{ models: [] }, { models: [{ id: 'unavailable-model', availability: 'unavailable' }] }])('rejects an empty or unavailable catalog without writing files: %j', async ({ models }) => {
    const home = tempHome()
    try {
      const adapter = new CodexConfigAdapter({ homeDir: home })
      const connection = profile({ model: undefined, activeModels: models })
      await expect(adapter.plan(connection)).rejects.toMatchObject({ code: 'model_catalog_empty' })
      expect(fs.existsSync(path.join(home, '.codex/config.toml'))).toBe(false)
      expect(fs.existsSync(path.join(home, '.codex/xpod-model-catalog.json'))).toBe(false)
      expect(fs.existsSync(path.join(home, '.codex/.xpod-ai-connections-codex.json'))).toBe(false)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('preserves exact native model metadata without borrowing capabilities or adding native-only models', async () => {
    const home = tempHome()
    try {
      const dir = path.join(home, '.codex')
      fs.mkdirSync(dir, { recursive: true })
      const cachePath = path.join(dir, 'models_cache.json')
      const native = {
        slug: 'gpt-6', display_name: 'GPT-6', description: 'Native model',
        supported_reasoning_levels: [{ effort: 'ultra', description: 'More reasoning' }],
        default_reasoning_level: 'high', shell_type: 'local', support_verbosity: true,
        supports_parallel_tool_calls: true, base_instructions: 'Native coding instructions',
        model_messages: { instructions_template: 'Native template' },
        input_modalities: ['text', 'image'], context_window: 400000, max_context_window: 400000,
        experimental_supported_tools: ['some-native-tool'], future_native_field: { retained: true },
      }
      const cache = JSON.stringify({ models: [native, { ...native, slug: 'not-in-gateway' }] })
      fs.writeFileSync(cachePath, cache)
      fs.writeFileSync(path.join(dir, 'cc-switch-model-catalog.json'), JSON.stringify({ models: [{ ...native, slug: 'deepseek-chat' }] }))
      const adapter = new CodexConfigAdapter({ homeDir: home })
      const connection = profile({ model: undefined, activeModels: [
        { id: 'gpt-6', displayName: 'GPT 6 via Xpod', inputModalities: ['text'], contextWindow: 200000 },
        { id: 'deepseek-chat', inputModalities: ['text'] },
      ] })
      await adapter.apply(await adapter.plan(connection))
      const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'xpod-model-catalog.json'), 'utf8'))
      expect(catalog.models.map((model: { slug: string }) => model.slug)).toEqual(['gpt-6', 'deepseek-chat'])
      expect(catalog.models[0]).toMatchObject({
        ...native, display_name: 'GPT 6 via Xpod', input_modalities: ['text'], context_window: 200000, max_context_window: 200000,
      })
      expect(catalog.models[1]).toMatchObject({ supported_reasoning_levels: [], input_modalities: ['text'], supports_parallel_tool_calls: false })
      expect(catalog.models[1]).not.toHaveProperty('future_native_field')
      expect(fs.readFileSync(cachePath, 'utf8')).toBe(cache)
      fs.writeFileSync(cachePath, JSON.stringify({ models: [{ ...native, base_instructions: 'Refreshed cache instructions' }] }))
      expect(await adapter.verify(connection)).toEqual({ ok: true })
      expect((await adapter.inspect()).projectionMatches).toBe(true)
      await adapter.restore(WEB_ID)
      expect(fs.readFileSync(cachePath, 'utf8')).toContain('Refreshed cache instructions')
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('rejects malformed native metadata instead of silently losing model capabilities', async () => {
    const home = tempHome()
    try {
      const dir = path.join(home, '.codex')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'models_cache.json'), '{invalid')
      const adapter = new CodexConfigAdapter({ homeDir: home })
      await expect(adapter.plan(profile())).rejects.toThrow('Codex native model cache')
      expect(fs.existsSync(path.join(dir, 'config.toml'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'xpod-model-catalog.json'))).toBe(false)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('detects externally edited model catalogs and refuses to delete them on restore', async () => {
    const home = tempHome()
    try {
      const adapter = new CodexConfigAdapter({ homeDir: home })
      await adapter.apply(await adapter.plan(profile()))
      const catalogPath = path.join(home, '.codex/xpod-model-catalog.json')
      fs.writeFileSync(catalogPath, '{"models": [], "edited": true}')
      expect((await adapter.inspect()).projectionMatches).toBe(false)
      await expect(adapter.restore(WEB_ID)).rejects.toThrow('catalog changed')
      expect(fs.readFileSync(catalogPath, 'utf8')).toContain('edited')
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('keeps Pi model definitions and provider parameters when applying only a connection', async () => {
    const home = tempHome()
    try {
      const dir = path.join(home, '.pi/agent')
      fs.mkdirSync(dir, { recursive: true })
      const models = [{ id: 'user-model', contextWindow: 12345, reasoning: true }]
      fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { xpod: { models, compat: { supportsDeveloperRole: false } } } }))
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ defaultModel: 'user-model' }))
      const adapter = new PiConfigAdapter({ homeDir: home })
      const connection = { endpoint: 'https://gateway.example', apiKey: XPOD_CLIENT_CREDENTIAL, webId: WEB_ID }
      await adapter.apply(await adapter.plan(connection))
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')).providers.xpod).toMatchObject({
        models, compat: { supportsDeveloperRole: false }, baseUrl: 'https://gateway.example/v1',
      })
      expect(await adapter.verify(connection)).toEqual({ ok: true })
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('writes Pi connection settings without inventing a model on a fresh installation', async () => {
    const home = tempHome()
    try {
      const adapter = new PiConfigAdapter({ homeDir: home })
      const connection = { endpoint: 'https://gateway.example', apiKey: XPOD_CLIENT_CREDENTIAL, webId: WEB_ID }
      await adapter.apply(await adapter.plan(connection))
      const dir = path.join(home, '.pi/agent')
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))).not.toHaveProperty('defaultModel')
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')).providers.xpod.models).toEqual([])
      expect(await adapter.verify(connection)).toEqual({ ok: true })
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('recovers the applied key fingerprint only while the actual configuration still matches', async () => {
    const home = tempHome()
    try {
      const adapter = new CodexConfigAdapter({ homeDir: home })
      await adapter.apply(await adapter.plan(profile()))
      const restoredAdapter = new CodexConfigAdapter({ homeDir: home })
      const inspection = await restoredAdapter.inspect()
      expect(inspection.projectionMatches).toBe(true)
      expect(inspection.apiKeyFingerprint).toMatch(/^[a-f0-9]{64}$/)
      const target = path.join(home, '.codex/config.toml')
      fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(XPOD_CLIENT_CREDENTIAL, 'another-key'))
      expect(await restoredAdapter.inspect()).toMatchObject({ projectionMatches: false })
      expect((await restoredAdapter.inspect()).apiKeyFingerprint).toBeUndefined()
      await expect(restoredAdapter.restore(WEB_ID)).rejects.toThrow('API key changed since projection was applied')
      expect(fs.readFileSync(target, 'utf8')).toContain('another-key')
      expect(await restoredAdapter.inspect()).toMatchObject({ projectionMatches: false })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it.each(['chatgpt', 'apikey', undefined])('restores the original Codex auth mode %s and keeps login tokens', async (authMode) => {
    const home = tempHome()
    try {
      const target = path.join(home, '.codex/auth.json')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const original = { auth_mode: authMode, tokens: { access_token: 'native-token' }, OPENAI_API_KEY: 'native-api-key' }
      fs.writeFileSync(target, JSON.stringify(original))
      const adapter = new CodexConfigAdapter({ homeDir: home })
      await adapter.apply(await adapter.plan(profile()))
      const auth = JSON.parse(fs.readFileSync(target, 'utf8'))
      expect(fs.readFileSync(target, 'utf8')).toBe(JSON.stringify(original))
      expect(auth).toEqual(JSON.parse(JSON.stringify(original)))
      expect((await adapter.verify(profile())).ok).toBe(true)
      auth.tokens.access_token = 'refreshed-native-token'
      fs.writeFileSync(target, JSON.stringify(auth))
      await adapter.restore(WEB_ID)
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({
        ...JSON.parse(JSON.stringify(original)), tokens: { access_token: 'refreshed-native-token' },
      })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('detects and preserves a later switch back to native ChatGPT login', async () => {
    const home = tempHome()
    try {
      const adapter = new CodexConfigAdapter({ homeDir: home })
      await adapter.apply(await adapter.plan(profile()))
      const target = path.join(home, '.codex/auth.json')
      const auth: Record<string, unknown> = {}
      auth.auth_mode = 'chatgpt'
      auth.tokens = { access_token: 'new-native-token' }
      fs.writeFileSync(target, JSON.stringify(auth))
      expect((await adapter.verify(profile())).ok).toBe(true)
      expect((await adapter.inspect()).projectionMatches).toBe(true)
      await adapter.restore(WEB_ID)
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({
        auth_mode: 'chatgpt', tokens: { access_token: 'new-native-token' },
      })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it.each(['chatgpt', 'apikey', undefined])('migrates legacy Codex auth mode %s while preserving refreshed OAuth state', async (authMode) => {
    const home = tempHome()
    try {
      const original = { auth_mode: authMode, OPENAI_API_KEY: 'native-key', tokens: { access_token: 'old' } }
      const { adapter, authPath, statePath } = await legacyCodex(home, original)
      const refreshed = { tokens: { access_token: 'fresh', refresh_token: 'fresh-refresh' }, last_refresh: 'today' }
      fs.writeFileSync(authPath, JSON.stringify({ ...original, ...refreshed, auth_mode: 'apikey', OPENAI_API_KEY: XPOD_CLIENT_CREDENTIAL }))
      const rotated = profile({ apiKey: 'rotated-key' })
      const plan = await adapter.plan(rotated)
      expect(plan.writes.map((write) => write.path)).toContain(authPath)
      await adapter.apply(plan)
      expect(JSON.parse(fs.readFileSync(authPath, 'utf8'))).toEqual(JSON.parse(JSON.stringify({ ...original, ...refreshed })))
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      expect(state.files.map((file: { path: string }) => file.path)).not.toContain(authPath)
      expect(state.projectionHashes).not.toHaveProperty(authPath)
      expect(await adapter.verify(rotated)).toEqual({ ok: true })
      expect((await adapter.inspect()).projectionMatches).toBe(true)
      const migratedAuth = fs.readFileSync(authPath, 'utf8')
      await adapter.restore(WEB_ID)
      expect(fs.readFileSync(authPath, 'utf8')).toBe(migratedAuth)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it.each(['migration', 'restore'])('preserves later native login mode during legacy %s', async (action) => {
    const home = tempHome()
    try {
      const { adapter, authPath } = await legacyCodex(home)
      fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: XPOD_CLIENT_CREDENTIAL, tokens: { access_token: 'new-login' } }))
      if (action === 'migration') await adapter.apply(await adapter.plan(profile()))
      else await adapter.restore(WEB_ID)
      expect(JSON.parse(fs.readFileSync(authPath, 'utf8'))).toEqual({ auth_mode: 'chatgpt', tokens: { access_token: 'new-login' } })
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it.each(['new-user-key', null])('leaves legacy auth untouched when the user changed the key to %s', async (key) => {
    const home = tempHome()
    try {
      const { adapter, authPath } = await legacyCodex(home, { auth_mode: 'chatgpt' })
      const content = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: key, tokens: { access_token: 'new-login' } })
      fs.writeFileSync(authPath, content)
      const plan = await adapter.plan(profile())
      expect(plan.writes.map((write) => write.path)).not.toContain(authPath)
      await adapter.apply(plan)
      await adapter.restore(WEB_ID)
      expect(fs.readFileSync(authPath, 'utf8')).toBe(content)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('fails closed when the legacy auth backup is missing', async () => {
    const home = tempHome()
    try {
      const { adapter, backupPath, configPath, authPath } = await legacyCodex(home, { auth_mode: 'chatgpt' })
      fs.unlinkSync(backupPath)
      const before = [configPath, authPath].map((file) => fs.readFileSync(file, 'utf8'))
      await expect(adapter.plan(profile())).rejects.toThrow('Missing Codex auth.json backup')
      expect([configPath, authPath].map((file) => fs.readFileSync(file, 'utf8'))).toEqual(before)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('rolls back config and auth migration if the ownership write fails', async () => {
    const home = tempHome()
    try {
      const { adapter, configPath, authPath, statePath } = await legacyCodex(home, { auth_mode: 'chatgpt' })
      const paths = [configPath, authPath, statePath]
      const before = paths.map((file) => fs.readFileSync(file, 'utf8'))
      const plan = await adapter.plan(profile())
      const rename = fs.promises.rename.bind(fs.promises)
      let failed = false
      const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (to === statePath && !failed) { failed = true; throw new Error('write failed') }
        return rename(from, to)
      })
      try { await expect(new CodexConfigAdapter({ homeDir: home }).apply(plan)).rejects.toThrow('write failed') }
      finally { spy.mockRestore() }
      expect(paths.map((file) => fs.readFileSync(file, 'utf8'))).toEqual(before)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('rejects a stale legacy auth migration plan without changing refreshed login data', async () => {
    const home = tempHome()
    try {
      const { adapter, configPath, authPath, statePath } = await legacyCodex(home, { auth_mode: 'chatgpt' })
      const plan = await adapter.plan(profile())
      const configBefore = fs.readFileSync(configPath, 'utf8')
      const stateBefore = fs.readFileSync(statePath, 'utf8')
      const refreshed = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: XPOD_CLIENT_CREDENTIAL, tokens: { access_token: 'refreshed-after-plan' } })
      fs.writeFileSync(authPath, refreshed)
      await expect(adapter.apply(plan)).rejects.toThrow('changed since planning')
      expect(fs.readFileSync(authPath, 'utf8')).toBe(refreshed)
      expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore)
      expect(fs.readFileSync(statePath, 'utf8')).toBe(stateBefore)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it.each(['before-auth-write', 'after-auth-write', 'during-rollback-stage'])('preserves concurrent login refresh %s when rolling back migration', async (timing) => {
    const home = tempHome()
    try {
      const { adapter, configPath, authPath, statePath } = await legacyCodex(home, { auth_mode: 'chatgpt' })
      const plan = await adapter.plan(profile())
      const configBefore = fs.readFileSync(configPath, 'utf8')
      const stateBefore = fs.readFileSync(statePath, 'utf8')
      const refreshed = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'concurrent-refresh' } })
      const rename = fs.promises.rename.bind(fs.promises)
      let injected = false
      let authStages = 0
      const chmod = fs.promises.chmod.bind(fs.promises)
      const chmodSpy = vi.spyOn(fs.promises, 'chmod').mockImplementation(async (target, mode) => {
        await chmod(target, mode)
        if (timing === 'during-rollback-stage' && String(target).includes('.auth.json.xpod-tmp-') && ++authStages === 2) {
          fs.writeFileSync(authPath, refreshed)
        }
      })
      const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (timing !== 'before-auth-write' && to === statePath && !injected) {
          injected = true
          if (timing === 'after-auth-write') fs.writeFileSync(authPath, refreshed)
          throw new Error('ownership write failed')
        }
        await rename(from, to)
        if (timing === 'before-auth-write' && to === configPath && !injected) {
          injected = true
          fs.writeFileSync(authPath, refreshed)
        }
      })
      try {
        await expect(new CodexConfigAdapter({ homeDir: home }).apply(plan)).rejects.toThrow(
          timing === 'before-auth-write' ? 'changed since planning' : 'ownership write failed',
        )
      } finally { spy.mockRestore(); chmodSpy.mockRestore() }
      expect(fs.readFileSync(authPath, 'utf8')).toBe(refreshed)
      expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore)
      expect(fs.readFileSync(statePath, 'utf8')).toBe(stateBefore)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('never reads or replaces unmanaged auth files', async () => {
    const home = tempHome()
    try {
      const authPath = path.join(home, '.codex/auth.json')
      fs.mkdirSync(path.dirname(authPath), { recursive: true })
      fs.writeFileSync(authPath, 'not valid JSON')
      const adapter = new CodexConfigAdapter({ homeDir: home })
      await adapter.apply(await adapter.plan(profile()))
      expect(await adapter.verify(profile())).toEqual({ ok: true })
      await adapter.restore(WEB_ID)
      expect(fs.readFileSync(authPath, 'utf8')).toBe('not valid JSON')
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('removes legacy auth created by Xpod when it contains no user login state', async () => {
    const home = tempHome()
    try {
      const { adapter, authPath } = await legacyCodex(home)
      await adapter.apply(await adapter.plan(profile()))
      expect(fs.existsSync(authPath)).toBe(false)
      await adapter.apply(await adapter.plan(profile({ apiKey: 'rotated-key' })))
      expect(await adapter.verify(profile({ apiKey: 'rotated-key' }))).toEqual({ ok: true })
      expect(fs.existsSync(authPath)).toBe(false)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('keeps Codex root and table scopes valid through apply, reapply, and restore', async () => {
    const home = tempHome()
    try {
      const target = path.join(home, '.codex/config.toml')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const original = 'model_provider = "openai"\nmodel = "native-model"\napproval_policy = "never"\n[mcp_servers.keep]\ncommand = "keep"\n[profiles.work]\nmodel_provider = "custom"\nmodel = "work-model"\n'
      fs.writeFileSync(target, original)
      const adapter = new CodexConfigAdapter({ homeDir: home })
      let projected: string | undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        await adapter.apply(await adapter.plan(profile()))
        const content = fs.readFileSync(target, 'utf8')
        if (projected) expect(content).toBe(projected)
        projected = content
        const parsed = parseToml(content)
        expect(parsed.model_provider).toBe('xpod')
        expect(parsed.model).toBe('openai/gpt-5.4')
        expect(parsed.approval_policy).toBe('never')
        expect(parsed.mcp_servers.keep).toEqual({ command: 'keep' })
        expect(parsed.profiles.work).toEqual({ model_provider: 'custom', model: 'work-model' })
        expect(parsed.model_providers.xpod.base_url).toBe('https://pod.example/alice/api/ai/v1')
        expect((await adapter.verify(profile())).ok).toBe(true)
      }
      fs.appendFileSync(target, '\n[features]\nkeep_later = true\n')
      await adapter.restore(WEB_ID)
      expect(parseToml(fs.readFileSync(target, 'utf8'))).toEqual({
        ...parseToml(original), features: { keep_later: true },
      })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects Codex projection values that appear only inside another table', async () => {
    const home = tempHome()
    try {
      const adapter = new CodexConfigAdapter({ homeDir: home })
      await adapter.apply(await adapter.plan(profile()))
      const target = path.join(home, '.codex/config.toml')
      const projected = fs.readFileSync(target, 'utf8')
      fs.writeFileSync(target, projected.replace('requires_openai_auth = false', 'requires_openai_auth = true'))
      expect((await adapter.verify(profile())).ok).toBe(false)
      fs.writeFileSync(target, '[profiles.fake]\n' + projected)
      expect((await adapter.verify(profile())).ok).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it.each([
    '[model_providers.xpod]',
    '["model_providers"."xpod"]',
  ])('fails planning when unmanaged Codex provider table exists: %s', async (tableHeader) => {
    const home = tempHome()
    try {
      const target = path.join(home, '.codex/config.toml')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, `${tableHeader}\nbase_url = "https://user.example/v1"\n`)
      const adapter = new CodexConfigAdapter({ homeDir: home })
      await expect(adapter.plan(profile())).rejects.toThrow('already defines [model_providers.xpod]')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not treat quoted single-segment model_providers table as a managed-name conflict', async () => {
    const home = tempHome()
    try {
      const target = path.join(home, '.codex/config.toml')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, '["model_providers.xpod"]\nbase_url = "https://user.example/v1"\n')
      const adapter = new CodexConfigAdapter({ homeDir: home })
      await adapter.apply(await adapter.plan(profile()))
      expect(fs.readFileSync(target, 'utf8')).toContain('["model_providers.xpod"]')
      expect(await adapter.verify(profile())).toMatchObject({ ok: true })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps nested Codex models when projecting without a selected root model', async () => {
    const home = tempHome()
    try {
      const target = path.join(home, '.codex/config.toml')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, 'model = "native-model"\n[profiles.work]\nmodel = "work-model"\n')
      const adapter = new CodexConfigAdapter({ homeDir: home })
      const connection = profile({ model: undefined, activeModels: undefined })
      await adapter.apply(await adapter.plan(connection))
      const parsed = parseToml(fs.readFileSync(target, 'utf8'))
      expect(parsed.model).toBe('native-model')
      expect(parsed.profiles.work.model).toBe('work-model')
      expect((await adapter.verify(connection)).ok).toBe(true)
      await adapter.restore(WEB_ID)
      expect(parseToml(fs.readFileSync(target, 'utf8')).model).toBe('native-model')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects restore when Codex key changed to a different value after apply', async () => {
    const home = tempHome()
    try {
      const adapter = new CodexConfigAdapter({ homeDir: home })
      await adapter.apply(await adapter.plan(profile()))
      const target = path.join(home, '.codex/config.toml')
      fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(XPOD_CLIENT_CREDENTIAL, 'another-native-api-key'))
      await expect(adapter.restore(WEB_ID)).rejects.toThrow('API key changed since projection was applied')
      expect(fs.readFileSync(target, 'utf8')).toContain('another-native-api-key')
      expect(fs.existsSync(path.join(home, '.codex', '.xpod-ai-connections-codex.json'))).toBe(true)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('exports native Codex, Claude Code, Pi, and CodeBuddy adapter semantics', async () => {
    const home = tempHome()
    try {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
      fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "user-model"\n[mcp_servers.keep_me]\ncommand = "keep"\n')
      fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ legacy: 'keep-me' }))
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
        model: 'opus',
        env: { KEEP_ME: 'yes', ANTHROPIC_BASE_URL: 'https://old.example' },
      }))
      fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true })
      fs.writeFileSync(path.join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ theme: 'dark' }))
      fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'), JSON.stringify({
        providers: { custom: { baseUrl: 'https://keep.example', apiKey: 'keep' } },
      }))
      fs.mkdirSync(path.join(home, '.codebuddy'), { recursive: true })
      fs.writeFileSync(path.join(home, '.codebuddy', 'settings.json'), JSON.stringify({
        enabledPlugins: { keep: true },
        env: { KEEP_ME: 'yes' },
      }))

      const adapters = [
        new CodexConfigAdapter({ homeDir: home }),
        new ClaudeCodeConfigAdapter({ homeDir: home }),
        new PiConfigAdapter({ homeDir: home }),
        new CodeBuddyConfigAdapter({ homeDir: home }),
      ]

      for (const adapter of adapters) {
        const plan = await adapter.plan(profile())
        expect(plan.webIdHash).toBe(hashWebId(WEB_ID))
        await adapter.apply(plan)
        expect((await adapter.verify(profile())).ok).toBe(true)
      }

      const codexToml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
      const codexAuth = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'))
      expect(codexToml).toContain('command = "keep"')
      expect(codexToml).toContain('model_provider = "xpod"')
      expect(codexToml).toContain('base_url = "https://pod.example/alice/api/ai/v1"')
      expect(codexAuth).toEqual({ legacy: 'keep-me' })
      expect(codexToml).toContain(`experimental_bearer_token = ${JSON.stringify(XPOD_CLIENT_CREDENTIAL)}`)

      const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
      expect(claude.model).toBe('openai/gpt-5.4')
      expect(claude.env).toMatchObject({
        KEEP_ME: 'yes',
        ANTHROPIC_BASE_URL: 'https://pod.example/alice/api/ai',
        ANTHROPIC_AUTH_TOKEN: XPOD_CLIENT_CREDENTIAL,
      })
      expect(claude.env.ANTHROPIC_API_KEY).toBeUndefined()

      const piSettings = JSON.parse(fs.readFileSync(path.join(home, '.pi', 'agent', 'settings.json'), 'utf8'))
      const piModels = JSON.parse(fs.readFileSync(path.join(home, '.pi', 'agent', 'models.json'), 'utf8'))
      expect(piSettings).toMatchObject({ theme: 'dark', defaultProvider: 'xpod', defaultModel: 'openai/gpt-5.4' })
      expect(piModels.providers.custom.baseUrl).toBe('https://keep.example')
      expect(piModels.providers.xpod).toMatchObject({
        baseUrl: 'https://pod.example/alice/api/ai/v1',
        apiKey: XPOD_CLIENT_CREDENTIAL,
        authHeader: true,
      })

      const codebuddy = JSON.parse(fs.readFileSync(path.join(home, '.codebuddy', 'settings.json'), 'utf8'))
      expect(codebuddy.enabledPlugins).toEqual({ keep: true })
      expect(codebuddy.env).toMatchObject({
        KEEP_ME: 'yes',
        CODEBUDDY_BASE_URL: 'https://pod.example/alice/api/ai/v1',
        CODEBUDDY_API_KEY: XPOD_CLIENT_CREDENTIAL,
      })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('projects only the Xpod-issued client credential into reviewable redacted client configs', async () => {
    const home = tempHome()
    try {
      const adapters = [
        new CodexConfigAdapter({ homeDir: home }),
        new ClaudeCodeConfigAdapter({ homeDir: home }),
        new PiConfigAdapter({ homeDir: home }),
        new CodeBuddyConfigAdapter({ homeDir: home }),
      ]

      for (const adapter of adapters) {
        const plan = await adapter.plan(profile({ providerApiKey: PROVIDER_API_KEY }))
        await adapter.apply(plan)
        expect((await adapter.verify(profile())).ok).toBe(true)
      }

      const generated = {
        codexConfig: fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'),
        codexAuth: fs.existsSync(path.join(home, '.codex', 'auth.json')) ? fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8') : '',
        claudeCode: fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),
        piSettings: fs.readFileSync(path.join(home, '.pi', 'agent', 'settings.json'), 'utf8'),
        piModels: fs.readFileSync(path.join(home, '.pi', 'agent', 'models.json'), 'utf8'),
        codeBuddy: fs.readFileSync(path.join(home, '.codebuddy', 'settings.json'), 'utf8'),
      }
      const serialized = JSON.stringify(generated)
      expect(serialized).toContain(XPOD_CLIENT_CREDENTIAL)
      expect(serialized).not.toContain(PROVIDER_API_KEY)
      expect(serialized).not.toContain('providerApiKey')

      const redacted = redactGeneratedConfig(generated)
      expect(JSON.stringify(redacted)).toContain('[xpod-client-credential]')
      expect(JSON.stringify(redacted)).not.toContain(XPOD_CLIENT_CREDENTIAL)
      expect(JSON.stringify(redacted)).not.toContain(PROVIDER_API_KEY)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('restore strips previous xpod-managed content without reviving older managed keys and preserves later edits', async () => {
    const home = tempHome()
    try {
      const dir = path.join(home, '.claude')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
        env: {
          KEEP_BEFORE: 'yes',
          ANTHROPIC_BASE_URL: 'https://old-xpod.example',
          ANTHROPIC_AUTH_TOKEN: 'old-xpod-secret',
        },
      }))
      const adapter = new ClaudeCodeConfigAdapter({ homeDir: home })
      await adapter.apply(await adapter.plan(profile()))
      const target = path.join(dir, 'settings.json')
      const current = JSON.parse(fs.readFileSync(target, 'utf8'))
      current.after = true
      current.env.KEEP_AFTER = 'yes'
      fs.writeFileSync(target, JSON.stringify(current))

      await adapter.restore(WEB_ID)

      const restored = JSON.parse(fs.readFileSync(target, 'utf8'))
      expect(restored.after).toBe(true)
      expect(restored.env.KEEP_AFTER).toBe('yes')
      expect(restored.env.KEEP_BEFORE).toBe('yes')
      expect(restored.env.ANTHROPIC_BASE_URL).toBeUndefined()
      expect(restored.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      assert.equal((await adapter.inspect()).ownership, 'unowned')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('restore strips previous native and legacy xpod state for Codex, Pi, and CodeBuddy without user edits', async () => {
    const home = tempHome()
    try {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
      fs.writeFileSync(path.join(home, '.codex', 'config.toml'), [
        'model_provider = "xpod"',
        'model = "legacy-model"',
        '# >>> xpod-ai-connections managed',
        '[model_providers.xpod]',
        'base_url = "https://old-xpod.example/v1"',
        '# <<< xpod-ai-connections managed',
        '',
      ].join('\n'))
      fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'old-xpod-secret' }))
      const codex = new CodexConfigAdapter({ homeDir: home })
      await codex.apply(await codex.plan(profile()))
      await codex.restore(WEB_ID)
      expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).not.toContain('old-xpod')
      expect(JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'))).toEqual({ OPENAI_API_KEY: 'old-xpod-secret' })

      fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true })
      fs.writeFileSync(path.join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({
        xpod: { webId: 'old-web-id' },
        defaultProvider: 'xpod',
        defaultModel: 'legacy-model',
      }))
      fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'), JSON.stringify({
        providers: {
          xpod: { baseUrl: 'https://old-xpod.example/v1', apiKey: 'old-xpod-secret' },
        },
      }))
      const pi = new PiConfigAdapter({ homeDir: home })
      await pi.apply(await pi.plan(profile()))
      await pi.restore(WEB_ID)
      expect(JSON.stringify(JSON.parse(fs.readFileSync(path.join(home, '.pi', 'agent', 'settings.json'), 'utf8')))).not.toContain('old-web-id')
      expect(JSON.stringify(JSON.parse(fs.readFileSync(path.join(home, '.pi', 'agent', 'models.json'), 'utf8')))).not.toContain('old-xpod')

      fs.mkdirSync(path.join(home, '.codebuddy'), { recursive: true })
      fs.writeFileSync(path.join(home, '.codebuddy', 'settings.json'), JSON.stringify({
        xpod: { webId: 'old-web-id' },
        env: {
          CODEBUDDY_BASE_URL: 'https://old-xpod.example/v1',
          CODEBUDDY_API_KEY: 'old-xpod-secret',
        },
      }))
      const codebuddy = new CodeBuddyConfigAdapter({ homeDir: home })
      await codebuddy.apply(await codebuddy.plan(profile()))
      await codebuddy.restore(WEB_ID)
      const restoredCodeBuddy = JSON.stringify(JSON.parse(fs.readFileSync(path.join(home, '.codebuddy', 'settings.json'), 'utf8')))
      expect(restoredCodeBuddy).not.toContain('old-xpod')
      expect(restoredCodeBuddy).not.toContain('old-web-id')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
