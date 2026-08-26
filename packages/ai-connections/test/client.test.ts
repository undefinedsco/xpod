import { describe, expect, it, vi } from 'vitest'
import {
  AI_MODEL_CAPABILITY,
  AI_MODEL_CLASS,
  aiConfigModelRef,
  aiConfigProviderRef,
  aiModelResource,
  aiProviderResource,
  credentialResource,
} from '@undefineds.co/models'
import {
  createAiConnectionsClient,
  resolveAiConnectionsApiBase,
} from '../src/ai-connections-client'

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const POD_BASE = 'https://pod.example/alice/'

function createMemoryDatabase(initial: {
  providers?: Array<Record<string, unknown>>
  credentials?: Array<Record<string, unknown>>
  models?: Array<Record<string, unknown>>
} = {}) {
  const rows = new Map<unknown, Array<Record<string, unknown>>>([
    [ aiProviderResource, [ ...initial.providers ?? [] ] ],
    [ credentialResource, [ ...initial.credentials ?? [] ] ],
    [ aiModelResource, [ ...initial.models ?? [] ] ],
  ])
  const list = (resource: unknown) => rows.get(resource) ?? []
  const clone = (row: Record<string, unknown>) => ({ ...row })
  return {
    init: vi.fn(async () => undefined),
    select: vi.fn(() => ({
      from: (resource: unknown) => ({
        execute: async () => list(resource).map(clone),
      }),
    })),
    insert: vi.fn((resource: unknown) => ({
      values: (value: Record<string, unknown>) => ({
        execute: async () => {
          list(resource).push(clone(value))
          return [ clone(value) ]
        },
      }),
    })),
    updateById: vi.fn(async (resource: unknown, id: string, patch: Record<string, unknown>) => {
      const row = list(resource).find((item) => item.id === id || item['@id'] === id)
      if (!row) return null
      Object.assign(row, patch)
      return clone(row)
    }),
    deleteById: vi.fn(async (resource: unknown, id: string) => {
      const current = list(resource)
      const index = current.findIndex((item) => item.id === id || item['@id'] === id)
      if (index < 0) return false
      current.splice(index, 1)
      return true
    }),
    rows,
  } as any
}

function connectedCredential(provider = 'openai', overrides: Record<string, unknown> = {}) {
  return {
    id: `${provider}-credential`,
    provider: aiConfigProviderRef(provider),
    service: 'ai',
    status: 'active',
    authMode: 'apiKey',
    apiKey: `sk-${provider}`,
    label: `${provider} key`,
    isDefault: true,
    ...overrides,
  }
}

describe('AI Connection management client', () => {
  it('routes browser-owned AI config through the authenticated Pod SPARQL endpoint', () => {
    expect(aiProviderResource.getSparqlEndpoint()).toBe('/settings/-/sparql')
    expect(credentialResource.getSparqlEndpoint()).toBe('/settings/-/sparql')
    expect(aiModelResource.getSparqlEndpoint()).toBe('/settings/-/sparql')
  })

  it('derives the management API from the current Pod and reads provider status from the Pod database', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
      database: createMemoryDatabase(),
    })

    await client.listProviders()

    expect(resolveAiConnectionsApiBase(POD_BASE)).toBe('https://pod.example')
    expect(authenticatedFetch).not.toHaveBeenCalled()
  })

  it('loads safe current-identity Provider status from Pod AI config resources', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const database = createMemoryDatabase({
      credentials: [ connectedCredential('kimi', {
        label: 'user@example.com',
        baseUrl: 'https://api.moonshot.ai/v1',
        metadata: { token: 'secret' },
      }) ],
    })
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
      database,
    })

    const providers = await client.listProviders()

    expect(authenticatedFetch).not.toHaveBeenCalled()
    expect(providers.find((provider) => provider.provider === 'kimi')).toEqual({
      provider: 'kimi',
      status: 'connected',
      authMode: 'apiKey',
      accountLabel: 'user@example.com',
      baseUrl: 'https://api.moonshot.ai/v1',
      credentialIri: 'kimi-credential',
      connect: {
        modes: ['browserAssistedApiKey'],
        configured: true,
      },
    })
    expect(JSON.stringify(providers)).not.toMatch(/deployment|webId|metadata|secret/)
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
      database: createMemoryDatabase({
        credentials: [ connectedCredential('openai') ],
      }),
    })

    await expect(client.quota('openai')).rejects.toThrow(
      'AI Connection request failed. Please try again.',
    )
    await expect(client.quota('openai')).rejects.not.toThrow(/sk-|xpod_|apiKey|token|Bearer|json-secret/)
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
      database: createMemoryDatabase({
        credentials: [ connectedCredential('openai') ],
      }),
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

  it('uses the stateless quota refresh probe for quota reads', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      credential: 'openai',
      status: 'available',
      windows: [],
      observedAt: '2026-08-25T00:00:00.000Z',
      expiresAt: '2026-08-25T01:00:00.000Z',
      source: 'openai:quota',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
      database: createMemoryDatabase({
        credentials: [ connectedCredential('openai', { baseUrl: 'https://api.openai.com/v1' }) ],
      }),
    })

    await client.quota('openai')

    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/connections/providers/openai/quota/refresh',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          apiKey: 'sk-openai',
          baseUrl: 'https://api.openai.com/v1',
        }),
      }),
    )
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
        { id: 'linx-lite', owned_by: 'undefineds' },
        { id: 'unattributed-model' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
      database: createMemoryDatabase(),
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
      { id: 'linx-lite', provider: 'undefineds' },
    ])
    expect(JSON.stringify(models)).not.toContain('must-not-escape')
  })

  it('projects Pod model classes and semantic capabilities independently', async () => {
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
      database: createMemoryDatabase({
        models: [ {
          id: aiModelResource.buildId({ id: 'ft-pod', isProvidedBy: aiConfigProviderRef('openai') }),
          rdfType: [ AI_MODEL_CLASS.chat ],
          displayName: 'Pod model',
          isProvidedBy: aiConfigProviderRef('openai'),
          inputModalities: [ 'text', 'image' ],
          outputModalities: [ 'text' ],
          capabilities: [ AI_MODEL_CAPABILITY.chat, AI_MODEL_CAPABILITY.tool_call ],
        } ],
      }),
    })

    await expect(client.listModels()).resolves.toEqual([ {
      id: 'ft-pod',
      provider: 'openai',
      displayName: 'Pod model',
      custom: true,
      inputModalities: [ 'text', 'image' ],
      outputModalities: [ 'text' ],
      capabilities: [ 'chat', 'tool_call' ],
    } ])
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
      database: createMemoryDatabase(),
    })

    await client.beginConnect('openai', 'browserAssistedApiKey')

    expect(authenticatedFetch).not.toHaveBeenCalled()
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
      database: createMemoryDatabase(),
    })

    const result = await client.beginConnect('openai', 'browserAssistedApiKey')

    expect(result).not.toHaveProperty('deployment')
  })

  it('rejects unknown providers before constructing a request path', async () => {
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch: vi.fn(),
      database: createMemoryDatabase(),
    })

    await expect(client.beginConnect('evil/provider' as never, 'browserAssistedApiKey'))
      .rejects.toThrow('Unsupported AI provider')
  })

  it('discovers provider models through the server-side refresh route', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      provider: 'kimi',
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
      database: createMemoryDatabase({
        credentials: [ connectedCredential('kimi', { baseUrl: 'https://api.moonshot.ai/v1' }) ],
      }),
    })

    const discovery = await client.discoverModels('kimi')

    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/connections/providers/kimi/models/refresh',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          apiKey: 'sk-kimi',
          baseUrl: 'https://api.moonshot.ai/v1',
        }),
      }),
    )
    expect(discovery).toEqual({
      provider: 'kimi',
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
        database: createMemoryDatabase({
          credentials: [ connectedCredential('kimi') ],
        }),
      })
      await expect(scoped.discoverModels('kimi')).rejects.toThrow(scenario.message)
    }
  })

  it('maps registry capability objects and custom capability lists onto catalog models', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'gpt-5', owned_by: 'openai', capabilities: { imageInput: true, toolCalls: true, reasoningEffort: true, promptCaching: true } },
        { id: 'gpt-4.1', owned_by: 'openai', capabilities: { promptCaching: true } },
        { id: 'ft-mine', owned_by: 'openai', custom: true, display_name: 'Mine', modalities: { input: ['text', 'image'] }, custom_capabilities: ['web'] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
      database: createMemoryDatabase(),
    })

    const models = await client.listModels()
    expect(models).toEqual([
      { id: 'gpt-5', provider: 'openai', capabilities: ['image', 'tool_call', 'reasoning'] },
      { id: 'gpt-4.1', provider: 'openai' },
      { id: 'ft-mine', provider: 'openai', custom: true, displayName: 'Mine', inputModalities: ['text', 'image'], capabilities: ['web'] },
    ])
  })

  it('writes AI config rows with schema-built Pod resource ids', async () => {
    const database = createMemoryDatabase()
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch: vi.fn(),
      database,
    })
    const attempt = await client.beginConnect('openai', 'browserAssistedApiKey')

    await client.completeApiKey('openai', attempt, 'sk-openai-test')

    expect(database.rows.get(aiProviderResource)).toEqual([
      expect.objectContaining({ id: aiProviderResource.buildId({ id: 'openai' }) }),
    ])
    expect(database.rows.get(credentialResource)).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^credentials\.ttl#openai-default$/u) }),
    ])
  })

  it('saves and deletes custom provider models through the Pod database', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    const authenticatedFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response(JSON.stringify({
        data: [{ id: 'ft-a', displayName: 'A', inputModalities: ['image'], capabilities: ['tool_call'] }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const database = createMemoryDatabase()
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
      database,
    })

    const saved = await client.saveProviderModel('openai', {
      id: 'ft-a',
      displayName: 'A',
      inputModalities: ['image'],
      capabilities: ['tool_call'],
    })
    expect(saved).toEqual([{ id: 'ft-a', displayName: 'A', inputModalities: ['image'], capabilities: ['tool_call'] }])

    const remaining = await client.deleteProviderModel('openai', 'ft-a')
    expect(remaining).toEqual([])

    expect(calls).toEqual([])
    expect(database.insert).toHaveBeenCalled()
    expect(database.deleteById).toHaveBeenCalledWith(
      aiModelResource,
      aiModelResource.buildId({ id: 'ft-a', isProvidedBy: aiConfigProviderRef('openai') }),
    )
  })
})
