import { describe, expect, it, vi } from 'vitest'
import {
  createAiConnectionsClient,
  resolveAiConnectionsApiBase,
} from '../src/ai-connections-client'

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const POD_BASE = 'https://pod.example/alice/'

describe('AI Connection management client', () => {
  it('derives the management API from the current Pod and uses authenticated fetch', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await client.listGatewayKeys()

    expect(resolveAiConnectionsApiBase(POD_BASE)).toBe('https://pod.example')
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/gateway/keys',
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        mode: 'cors',
      }),
    )
  })

  it('loads safe current-identity Provider status from the AI Connection product route', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{
        provider: 'kimi',
        status: 'connected',
        authMode: 'deviceCodeOAuth',
        accountLabel: 'user@example.com',
        deployment: 'cloud',
        webId: WEB_ID,
        metadata: { token: 'secret' },
        connect: {
          modes: ['deviceCodeOAuth', 'browserAssistedApiKey'],
          configured: true,
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const providers = await client.listProviders()

    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/connections/providers',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(providers).toEqual([{
      provider: 'kimi',
      status: 'connected',
      authMode: 'deviceCodeOAuth',
      accountLabel: 'user@example.com',
      connect: {
        modes: ['deviceCodeOAuth', 'browserAssistedApiKey'],
        configured: true,
      },
    }])
    expect(JSON.stringify(providers)).not.toMatch(/deployment|webId|metadata|secret/)
  })

  it('discovers the AI Connection service-access descriptor with authenticated fetch', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      appletId: 'co.undefineds.ai-connections',
      service: {
        webId: 'https://id.example/xpod/profile/card#me',
        label: 'Xpod AI Connection',
      },
      resources: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await expect(client.getServiceAccess()).resolves.toMatchObject({
      appletId: 'co.undefineds.ai-connections',
    })
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/applets/service-access/ai-connections',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('normalizes service-access discovery failures', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      error: 'AI Connection service identity is unavailable',
    }), { status: 503, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await expect(client.getServiceAccess()).rejects.toThrow(
      'AI Connection service identity is unavailable',
    )
  })

  it('does not expose secrets from non-OK server errors', async () => {
    const leaked = [
      'sk-live-secret',
      'xpod_once_secret',
      'apiKey=provider-secret',
      'token=provider-token',
      'Authorization: Bearer provider-bearer',
      '{"secret":"json-secret"}',
    ].join(' ')
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      error: leaked,
    }), { status: 500, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await expect(client.listGatewayKeys()).rejects.toThrow(
      'AI Connection request failed. Please try again.',
    )
    await expect(client.listGatewayKeys()).rejects.not.toThrow(/sk-|xpod_|apiKey|token|Bearer|json-secret/)
  })

  it('keeps useful allowlisted server codes without exposing raw details', async () => {
    const responses = [
      { code: 'not_configured', error: 'not_configured: missing token sk-live-secret' },
      { code: 'unsupported', error: 'unsupported: Authorization Bearer provider-secret' },
    ]
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const messages: string[] = []
    for (let index = 0; index < 2; index += 1) {
      try {
        await client.quota('openai')
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error))
      }
    }
    expect(messages).toEqual([
      'OpenAI connection is not configured.',
      'OpenAI does not support this operation.',
    ])
    expect(messages.join(' ')).not.toMatch(/sk-|token|Bearer|provider-secret/)
  })

  it('normalizes only attributable models from the current-identity model catalog', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: 'gpt-5.4',
          provider: 'openai',
          name: 'GPT-5.4',
          context_window: 200_000,
          protocols: ['responses', 'chat-completions'],
          secret: 'must-not-escape',
        },
        { id: 'qwen3-max', owned_by: 'dashscope' },
        { id: 'linx-lite', provider: 'openai' },
        { id: 'unattributed-model' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const models = await client.listModels()

    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/v1/models',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(models).toEqual([
      {
        id: 'gpt-5.4',
        provider: 'openai',
        displayName: 'GPT-5.4',
        contextWindow: 200_000,
        protocols: ['responses', 'chat-completions'],
      },
      { id: 'qwen3-max', provider: 'bailian' },
    ])
    expect(JSON.stringify(models)).not.toContain('must-not-escape')
  })

  it('never exposes deployment or plaintext key fields from subsequent key lists', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{
        id: 'key-1',
        owner: WEB_ID,
        deployment: 'cloud',
        key: 'must-not-escape',
        scopes: ['models:read'],
        createdAt: '2026-07-24T00:00:00.000Z',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const keys = await client.listGatewayKeys()

    expect(keys).toEqual([{
      id: 'key-1',
      owner: WEB_ID,
      scopes: ['models:read'],
      createdAt: '2026-07-24T00:00:00.000Z',
    }])
    expect(JSON.stringify(keys)).not.toMatch(/deployment|must-not-escape/)
  })

  it('returns a newly-created plaintext key only from the create response', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      key: 'xpod_once_secret',
      record: {
        id: 'key-2',
        owner: WEB_ID,
        deployment: 'local',
        scopes: ['models:read', 'inference:write'],
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const created = await client.createGatewayKey({ name: 'Codex' })

    expect(created.plaintext).toBe('xpod_once_secret')
    expect(created.record).not.toHaveProperty('deployment')
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/gateway/keys',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Codex' }),
      }),
    )
  })

  it('binds provider operations to the fixed provider route and current identity fetch', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      mode: 'browserAssistedApiKey',
      status: 'pending',
      provider: 'openai',
      attemptId: 'attempt-1',
      state: 'state-1',
      signature: 'signature-1',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await client.beginConnect('openai', 'browserAssistedApiKey')

    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/gateway/providers/openai/connect/begin',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ mode: 'browserAssistedApiKey' }),
      }),
    )
  })

  it('removes infrastructure deployment fields from Connect responses', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      mode: 'browserAssistedApiKey',
      status: 'pending',
      provider: 'openai',
      deployment: 'cloud',
      attemptId: 'attempt-1',
      state: 'state-1',
      signature: 'signature-1',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const result = await client.beginConnect('openai', 'browserAssistedApiKey')

    expect(result).not.toHaveProperty('deployment')
  })

  it('rejects unknown providers before constructing a request path', async () => {
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch: vi.fn(),
    })

    await expect(client.beginConnect('evil/provider' as never, 'browserAssistedApiKey'))
      .rejects.toThrow('Unsupported AI provider')
  })

  it('discovers provider models through the server-side refresh route', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      provider: 'kimi',
      credential: 'https://pod.example/alice/.data/credentials.ttl#kimi',
      models: [
        { id: 'kimi-k2', displayName: 'Kimi K2' },
        { id: 'moonshot-v1-8k', capabilities: ['function_calling'] },
        { invalid: true },
      ],
      observedAt: '2026-08-06T00:00:00.000Z',
      source: 'kimi:/models',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const discovery = await client.discoverModels('kimi')

    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/gateway/providers/kimi/models/refresh',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(discovery).toEqual({
      provider: 'kimi',
      credential: 'https://pod.example/alice/.data/credentials.ttl#kimi',
      models: [
        { id: 'kimi-k2', displayName: 'Kimi K2' },
        { id: 'moonshot-v1-8k', capabilities: ['function_calling'] },
      ],
      observedAt: '2026-08-06T00:00:00.000Z',
      source: 'kimi:/models',
    })
  })

  it('maps provider fetch failures to the LinX verification messages', async () => {
    const scenarios = [
      { providerStatus: 401, message: '密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。' },
      { providerStatus: 404, message: '模型服务地址不正确。请检查服务地址后重试。' },
      { providerStatus: 429, message: '请求太频繁。请稍等一会儿再试。' },
      { providerStatus: 503, message: '模型服务暂时没有响应。请稍后重试。' },
    ]
    for (const scenario of scenarios) {
      const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
        error: 'provider_models_fetch_failed',
        providerStatus: scenario.providerStatus,
      }), { status: 502, headers: { 'content-type': 'application/json' } }))
      const scoped = createAiConnectionsClient({
        webId: WEB_ID,
        podBaseUrl: POD_BASE,
        authenticatedFetch,
      })
      await expect(scoped.discoverModels('kimi')).rejects.toThrow(scenario.message)
    }
  })
})
