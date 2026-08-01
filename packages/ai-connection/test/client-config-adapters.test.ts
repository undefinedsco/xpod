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
    gatewayKey: 'xpod-gw-secret',
    webId: WEB_ID,
    model: 'gpt-5.4',
    ...overrides,
  }
}

describe('publishable AI client config adapters', () => {
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
      expect(codexAuth).toMatchObject({ legacy: 'keep-me', OPENAI_API_KEY: 'xpod-gw-secret' })

      const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
      expect(claude.model).toBe('opus')
      expect(claude.env).toMatchObject({
        KEEP_ME: 'yes',
        ANTHROPIC_BASE_URL: 'https://pod.example/alice/api/ai',
        ANTHROPIC_AUTH_TOKEN: 'xpod-gw-secret',
      })
      expect(claude.env.ANTHROPIC_API_KEY).toBeUndefined()

      const piSettings = JSON.parse(fs.readFileSync(path.join(home, '.pi', 'agent', 'settings.json'), 'utf8'))
      const piModels = JSON.parse(fs.readFileSync(path.join(home, '.pi', 'agent', 'models.json'), 'utf8'))
      expect(piSettings).toMatchObject({ theme: 'dark', defaultProvider: 'xpod', defaultModel: 'gpt-5.4' })
      expect(piModels.providers.custom.baseUrl).toBe('https://keep.example')
      expect(piModels.providers.xpod).toMatchObject({
        baseUrl: 'https://pod.example/alice/api/ai/v1',
        apiKey: 'xpod-gw-secret',
        authHeader: true,
      })

      const codebuddy = JSON.parse(fs.readFileSync(path.join(home, '.codebuddy', 'settings.json'), 'utf8'))
      expect(codebuddy.enabledPlugins).toEqual({ keep: true })
      expect(codebuddy.env).toMatchObject({
        KEEP_ME: 'yes',
        CODEBUDDY_BASE_URL: 'https://pod.example/alice/api/ai/v1',
        CODEBUDDY_API_KEY: 'xpod-gw-secret',
      })
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
})
