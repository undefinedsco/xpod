import { describe, expect, it, vi } from 'vitest'
import {
  createAiConnectionClient,
  resolveAiConnectionApiBase,
} from '../src/ai-connection-client'

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const POD_BASE = 'https://pod.example/alice/'

describe('AI Connection management client', () => {
  it('derives the management API from the current Pod and uses authenticated fetch', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const client = createAiConnectionClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await client.listProviders()

    expect(resolveAiConnectionApiBase(POD_BASE)).toBe('https://pod.example')
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/connections/providers',
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
    const client = createAiConnectionClient({
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

  it('round-trips the safe owner WebID from a disconnect credential response', async () => {
    const authenticatedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://pod.example/api/ai/gateway/providers/openai/connect')
      expect(init?.method).toBe('DELETE')
      return new Response(JSON.stringify({
        record: {
          id: 'credential-openai',
          credentialIri: 'https://pod.example/alice/settings/credentials.ttl#openai',
          webId: WEB_ID,
          provider: 'openai',
          authMode: 'apiKey',
          status: 'disconnected',
          metadata: { apiKey: 'sk-must-not-escape' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const client = createAiConnectionClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const credential = await client.disconnect('openai')

    expect(credential).toEqual({
      id: 'credential-openai',
      credentialIri: 'https://pod.example/alice/settings/credentials.ttl#openai',
      webId: WEB_ID,
      provider: 'openai',
      authMode: 'apiKey',
      status: 'disconnected',
    })
    expect(JSON.stringify(credential)).not.toContain('sk-must-not-escape')
  })

  it('discovers the AI Connection service-access descriptor with authenticated fetch', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      appletId: 'co.undefineds.ai-connection',
      service: {
        webId: 'https://id.example/xpod/profile/card#me',
        label: 'Xpod AI Connection',
      },
      resources: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await expect(client.getServiceAccess()).resolves.toMatchObject({
      appletId: 'co.undefineds.ai-connection',
    })
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/applets/service-access/ai-connection',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('normalizes service-access discovery failures', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      error: 'AI Connection service identity is unavailable',
    }), { status: 503, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionClient({
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
    const client = createAiConnectionClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await expect(client.listProviders()).rejects.toThrow(
      'AI Connection request failed. Please try again.',
    )
    await expect(client.listProviders()).rejects.not.toThrow(/sk-|xpod_|apiKey|token|Bearer|json-secret/)
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
    const client = createAiConnectionClient({
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

  it('turns a stale model-catalog response into an explicit reconnect message', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'model_catalog_not_ready',
        message: 'provider secret must not escape',
      },
    }), { status: 409, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await expect(client.replaceModelSelection('openai', {
      modelIds: [],
      expectedVersion: 'sha256:stale',
    })).rejects.toThrow('请先重新连接后再保存模型选择。')
    await expect(client.replaceModelSelection('openai', {
      modelIds: [],
      expectedVersion: 'sha256:stale',
    })).rejects.not.toThrow(/provider secret/)
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
    const client = createAiConnectionClient({
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

  it('discovers, reads, and replaces provider model selections through typed catalog routes', async () => {
    const responses = [
      {
        provider: 'openai',
        fetchedAt: '2026-08-05T00:00:00.000Z',
        version: 'sha256:catalog',
        status: 'ready',
        models: [
          {
            id: 'gpt-5',
            displayName: 'GPT-5',
            modelType: 'chat',
            selected: true,
            availability: 'available',
            secret: 'sk-provider-secret',
          },
          {
            id: 'gpt-4.1',
            modelType: 'chat',
            selected: false,
            availability: 'available',
          },
          { id: 'malformed', selected: 'yes', availability: 'available' },
        ],
        error: 'upstream body with provider-secret',
      },
      {
        provider: 'openai',
        version: 'sha256:catalog',
        status: 'notFetched',
        models: [],
      },
      {
        provider: 'openai',
        fetchedAt: '2026-08-05T00:01:00.000Z',
        version: 'sha256:selection',
        status: 'ready',
        models: [{
          id: 'gpt-5',
          displayName: 'GPT-5',
          modelType: 'chat',
          selected: true,
          availability: 'available',
        }],
      },
    ]
    const authenticatedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => new Response(
      JSON.stringify(responses.shift()),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const client = createAiConnectionClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const discovered = await client.discoverModels('openai')
    expect(discovered).toMatchObject({
      provider: 'openai',
      status: 'ready',
      version: 'sha256:catalog',
      models: [
        expect.objectContaining({ id: 'gpt-5', selected: true, availability: 'available' }),
        expect.objectContaining({ id: 'gpt-4.1', selected: false }),
      ],
    })
    expect(JSON.stringify(discovered)).not.toContain('secret')

    await client.getProviderModels('openai')
    await client.replaceModelSelection('openai', {
      modelIds: ['gpt-5'],
      defaultModel: 'gpt-5',
      expectedVersion: 'sha256:catalog',
    })

    expect(authenticatedFetch.mock.calls.map(([input, init]) => [String(input), init?.method, init?.body])).toEqual([
      ['https://pod.example/api/ai/gateway/providers/openai/models/discover', 'POST', undefined],
      ['https://pod.example/api/ai/gateway/providers/openai/models', 'GET', undefined],
      ['https://pod.example/api/ai/gateway/providers/openai/models/selection', 'PUT', JSON.stringify({
        modelIds: ['gpt-5'],
        defaultModel: 'gpt-5',
        expectedVersion: 'sha256:catalog',
      })],
    ])
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
    const client = createAiConnectionClient({
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
    const client = createAiConnectionClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const result = await client.beginConnect('openai', 'browserAssistedApiKey')

    expect(result).not.toHaveProperty('deployment')
  })

  it('rejects unknown providers before constructing a request path', async () => {
    const client = createAiConnectionClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch: vi.fn(),
    })

    await expect(client.beginConnect('evil/provider' as never, 'browserAssistedApiKey'))
      .rejects.toThrow('Unsupported AI provider')
  })
})
