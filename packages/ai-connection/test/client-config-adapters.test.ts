import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ClaudeCodeConfigAdapter,
  CodeBuddyConfigAdapter,
  CodexConfigAdapter,
  PiConfigAdapter,
  hashWebId,
} from '../src/client-config'

const WEB_ID = 'https://pod.example/alice/profile/card#me'

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'linx-ai-client-config-package-'))
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: 'https://pod.example/alice/api/ai',
    apiKey: 'sk-client-credentials-secret',
    webId: WEB_ID,
    model: 'gpt-5.4',
    activeModels: [{ id: 'gpt-5.4', provider: 'openai' }],
    ...overrides,
  }
}

describe('publishable AI client config adapters', () => {
  it.each([
    ['codex', () => new CodexConfigAdapter({ homeDir: tempHome() })],
    ['claude-code', () => new ClaudeCodeConfigAdapter({ homeDir: tempHome() })],
    ['pi', () => new PiConfigAdapter({ homeDir: tempHome() })],
    ['codebuddy', () => new CodeBuddyConfigAdapter({ homeDir: tempHome() })],
  ] as const)('%s rejects an empty active Gateway catalog before writing files', async (_client, createAdapter) => {
    const adapter = createAdapter()
    await expect(adapter.plan(profile({ activeModels: [] }))).rejects.toMatchObject({
      code: 'model_catalog_empty',
    })
  })

  it.each([
    ['codex', (home: string) => new CodexConfigAdapter({ homeDir: home })],
    ['claude-code', (home: string) => new ClaudeCodeConfigAdapter({ homeDir: home })],
    ['pi', (home: string) => new PiConfigAdapter({ homeDir: home })],
    ['codebuddy', (home: string) => new CodeBuddyConfigAdapter({ homeDir: home })],
  ] as const)('%s resolves a provider-qualified model and rejects an ambiguous unqualified alias', async (_client, createAdapter) => {
    const home = tempHome()
    try {
      const adapter = createAdapter(home)
      const catalog = [
        { id: 'gpt-5.4', provider: 'openai' },
        { id: 'gpt-5.4', provider: 'deepseek' },
      ]
      await expect(adapter.plan(profile({ model: 'gpt-5.4', activeModels: catalog }))).rejects.toMatchObject({
        code: 'model_not_available',
      })
      const plan = await adapter.plan(profile({ model: 'openai/gpt-5.4', activeModels: catalog }))
      const config = plan.writes.map((write) => write.content ?? '').join('\n')
      expect(config).toMatch(/(?:["']?(?:model|defaultModel)["']?)\s*[:=]\s*["']openai\/gpt-5\.4/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not project a model explicitly marked unavailable by the Gateway catalog', async () => {
    const home = tempHome()
    try {
      const adapter = new CodexConfigAdapter({ homeDir: home })
      await expect(adapter.plan(profile({
        model: 'openai/gpt-5.4',
        activeModels: [{ id: 'gpt-5.4', provider: 'openai', availability: 'unavailable' }],
      }))).rejects.toMatchObject({ code: 'model_catalog_empty' })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it.each([
    ['codex', (home: string) => new CodexConfigAdapter({ homeDir: home })],
    ['claude-code', (home: string) => new ClaudeCodeConfigAdapter({ homeDir: home })],
    ['pi', (home: string) => new PiConfigAdapter({ homeDir: home })],
    ['codebuddy', (home: string) => new CodeBuddyConfigAdapter({ homeDir: home })],
  ] as const)('%s removes an old unpicked model instead of projecting it to the Gateway', async (_client, createAdapter) => {
    const home = tempHome()
    try {
      if (_client === 'codex') {
        fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
        fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "old-unpicked-model"\n')
      } else if (_client === 'claude-code') {
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
        fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'old-unpicked-model' }))
      } else if (_client === 'pi') {
        fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true })
        fs.writeFileSync(path.join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ defaultModel: 'old-unpicked-model' }))
      } else {
        fs.mkdirSync(path.join(home, '.codebuddy'), { recursive: true })
        fs.writeFileSync(path.join(home, '.codebuddy', 'settings.json'), JSON.stringify({ model: 'old-unpicked-model' }))
      }
      const adapter = createAdapter(home)
      const plan = await adapter.plan(profile({ model: 'gpt-5.4', activeModels: [{ id: 'gpt-5.4', provider: 'openai' }] }))
      const serialized = plan.writes.map((write) => write.content ?? '').join('\n')
      expect(serialized).not.toContain('old-unpicked-model')
      await expect(adapter.plan(profile({ model: 'old-unpicked-model', activeModels: [{ id: 'gpt-5.4', provider: 'openai' }] }))).rejects.toMatchObject({
        code: 'model_not_available',
      })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not place an upstream provider URL or provider credential in generated client configuration', async () => {
    const home = tempHome()
    try {
      const adapters = [
        new CodexConfigAdapter({ homeDir: home }),
        new ClaudeCodeConfigAdapter({ homeDir: home }),
        new PiConfigAdapter({ homeDir: home }),
        new CodeBuddyConfigAdapter({ homeDir: home }),
      ]
      const generated = (await Promise.all(adapters.map((adapter) => adapter.plan(profile({
        endpoint: 'https://xpod.example/v1',
        apiKey: 'sk-gateway-only',
        activeModels: [{ id: 'gpt-5.4', provider: 'openai' }],
      }))))).flatMap((plan) => plan.writes.map((write) => write.content ?? '')).join('\n')
      expect(generated).toContain('https://xpod.example')
      expect(generated).toContain('sk-gateway-only')
      expect(generated).not.toContain('https://api.openai.com')
      expect(generated).not.toContain('sk-provider')
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
      fs.writeFileSync(path.join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({
        theme: 'dark',
        defaultModel: 'old-unpicked-model',
      }))
      fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'), JSON.stringify({
        providers: { custom: { baseUrl: 'https://keep.example', apiKey: 'keep' } },
      }))
      fs.mkdirSync(path.join(home, '.codebuddy'), { recursive: true })
      fs.writeFileSync(path.join(home, '.codebuddy', 'settings.json'), JSON.stringify({
        enabledPlugins: { keep: true },
        model: 'old-unpicked-model',
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
      expect(codexToml).not.toContain('model = "user-model"')
      expect(codexToml).toContain('base_url = "https://pod.example/alice/api/ai/v1"')
      expect(codexAuth).toMatchObject({ legacy: 'keep-me', OPENAI_API_KEY: 'sk-client-credentials-secret' })

      const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
      expect(claude.model).toBe('openai/gpt-5.4')
      expect(claude.env).toMatchObject({
        KEEP_ME: 'yes',
        ANTHROPIC_BASE_URL: 'https://pod.example/alice/api/ai',
        ANTHROPIC_AUTH_TOKEN: 'sk-client-credentials-secret',
      })
      expect(claude.env.ANTHROPIC_API_KEY).toBeUndefined()

      const piSettings = JSON.parse(fs.readFileSync(path.join(home, '.pi', 'agent', 'settings.json'), 'utf8'))
      const piModels = JSON.parse(fs.readFileSync(path.join(home, '.pi', 'agent', 'models.json'), 'utf8'))
      expect(piSettings).toMatchObject({ theme: 'dark', defaultProvider: 'xpod', defaultModel: 'openai/gpt-5.4' })
      expect(piSettings.defaultModel).not.toBe('old-unpicked-model')
      expect(piModels.providers.custom.baseUrl).toBe('https://keep.example')
      expect(piModels.providers.xpod).toMatchObject({
        baseUrl: 'https://pod.example/alice/api/ai/v1',
        apiKey: 'sk-client-credentials-secret',
        authHeader: true,
      })

      const codebuddy = JSON.parse(fs.readFileSync(path.join(home, '.codebuddy', 'settings.json'), 'utf8'))
      expect(codebuddy.enabledPlugins).toEqual({ keep: true })
      expect(codebuddy.model).not.toBe('old-unpicked-model')
      expect(codebuddy.env).toMatchObject({
        KEEP_ME: 'yes',
        CODEBUDDY_BASE_URL: 'https://pod.example/alice/api/ai/v1',
        CODEBUDDY_API_KEY: 'sk-client-credentials-secret',
      })
      expect(codebuddy.model).toBe('openai/gpt-5.4')
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
        '# >>> xpod-ai-connection managed',
        '[model_providers.xpod]',
        'base_url = "https://old-xpod.example/v1"',
        '# <<< xpod-ai-connection managed',
        '',
      ].join('\n'))
      fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'old-xpod-secret' }))
      const codex = new CodexConfigAdapter({ homeDir: home })
      await codex.apply(await codex.plan(profile()))
      await codex.restore(WEB_ID)
      expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).not.toContain('old-xpod')
      expect(JSON.stringify(JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')))).not.toContain('old-xpod')

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

  it('restores an unrelated Codex model after a temporary Gateway projection', async () => {
    const home = tempHome()
    try {
      const dir = path.join(home, '.codex')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'config.toml'), [
        'model_provider = "openai"',
        'model = "user-model"',
        '',
      ].join('\n'))
      const adapter = new CodexConfigAdapter({ homeDir: home })
      await adapter.apply(await adapter.plan(profile()))
      await adapter.restore(WEB_ID)

      const restored = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')
      expect(restored).toContain('model_provider = "openai"')
      expect(restored).toContain('model = "user-model"')
      expect(restored).not.toContain('xpod-ai-connection')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('only replaces root-level Codex model keys and preserves models inside profile tables through plan/apply/restore', async () => {
    const home = tempHome()
    try {
      const dir = path.join(home, '.codex')
      fs.mkdirSync(dir, { recursive: true })
      const original = [
        'model_provider = "openai"',
        'model = "root-model"',
        '',
        '[profiles.coder]',
        'model_provider = "profile-provider"',
        'model = "profile-model"',
        '',
        '[mcp_servers.keep_me]',
        'command = "keep"',
        '',
      ].join('\n')
      fs.writeFileSync(path.join(dir, 'config.toml'), original)
      const adapter = new CodexConfigAdapter({ homeDir: home })

      const plan = await adapter.plan(profile({ model: 'gpt-5.4' }))
      const projected = plan.writes.find((write) => write.path.endsWith('.codex/config.toml'))?.content ?? ''
      expect(projected).not.toContain('model_provider = "openai"')
      expect(projected).not.toContain('model = "root-model"')
      expect(projected).toContain('model_provider = "profile-provider"')
      expect(projected).toContain('model = "profile-model"')

      await adapter.apply(plan)
      await adapter.restore(WEB_ID)
      expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).toBe(original)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
