import { describe, expect, it } from 'vitest'
import { manualConfigurationText } from '../src/AiClientConfigurationSection'

describe('manual client configuration templates', () => {
  const endpoint = 'https://xpod.example/api/ai/'
  const key = 'gakv_example'

  it('copies native Codex TOML and auth JSON fields', () => {
    const value = manualConfigurationText('codex', endpoint, key)
    expect(value).toContain('# ~/.codex/config.toml')
    expect(value).toContain('model_provider = "xpod"')
    expect(value).toContain('base_url = "https://xpod.example/api/ai/v1"')
    expect(value).toContain('# ~/.codex/auth.json')
    expect(value).toContain('"OPENAI_API_KEY": "gakv_example"')
  })

  it('copies Claude Code environment fields in settings JSON', () => {
    const value = manualConfigurationText('claude-code', endpoint, key)
    expect(value).toContain('# ~/.claude/settings.json')
    expect(value).toContain('"ANTHROPIC_BASE_URL": "https://xpod.example/api/ai"')
    expect(value).toContain('"ANTHROPIC_AUTH_TOKEN": "gakv_example"')
    expect(value).not.toContain('ANTHROPIC_API_KEY')
  })

  it('copies both Pi settings and provider model configuration', () => {
    const value = manualConfigurationText('pi', endpoint, key)
    expect(value).toContain('# ~/.pi/agent/settings.json')
    expect(value).toContain('# ~/.pi/agent/models.json')
    expect(value).toContain('"defaultProvider": "xpod"')
    expect(value).toContain('"baseUrl": "https://xpod.example/api/ai/v1"')
    expect(value).toContain('"apiKey": "gakv_example"')
  })

  it('copies CodeBuddy environment fields in settings JSON', () => {
    const value = manualConfigurationText('codebuddy', endpoint, key)
    expect(value).toContain('# ~/.codebuddy/settings.json')
    expect(value).toContain('"CODEBUDDY_BASE_URL": "https://xpod.example/api/ai/v1"')
    expect(value).toContain('"CODEBUDDY_API_KEY": "gakv_example"')
  })
})
