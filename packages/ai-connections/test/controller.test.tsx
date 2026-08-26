// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SolidPermissionCapability,
  WebExtensionHost,
  WebExtensionSolidCapability,
} from '@undefineds.co/extension-sdk/web'
import {
  aiConfigProviderRef,
  aiModelResource,
  aiProviderResource,
  credentialResource,
} from '@undefineds.co/models'
import { AiConnectionsList, AiConnectionsMain, createAiConnectionsController } from '../src'

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const POD_URL = 'https://pod.example/alice/'

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
  return {
    init: vi.fn(async () => undefined),
    select: vi.fn(() => ({
      from: (resource: unknown) => ({
        execute: async () => list(resource).map((row) => ({ ...row })),
      }),
    })),
    insert: vi.fn((resource: unknown) => ({
      values: (value: Record<string, unknown>) => ({
        execute: async () => {
          list(resource).push({ ...value })
          return [ { ...value } ]
        },
      }),
    })),
    updateById: vi.fn(async (resource: unknown, id: string, patch: Record<string, unknown>) => {
      const row = list(resource).find((item) => item.id === id || item['@id'] === id)
      if (!row) return null
      Object.assign(row, patch)
      return { ...row }
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

afterEach(cleanup)

function solidCapability(
  overrides: Partial<WebExtensionSolidCapability> = {},
): WebExtensionSolidCapability {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch

  return {
    session: {
      fetch: fetcher,
      getSnapshot: () => ({
        status: 'authenticated' as const,
        webId: WEB_ID,
      }),
      subscribe: () => () => undefined,
    },
    pod: {
      status: 'ready' as const,
      current: {
        webId: WEB_ID,
        podUrl: POD_URL,
        database: createMemoryDatabase(),
        collections: 'ready' as const,
      },
    },
    requireLogin: vi.fn(async () => undefined),
    ...overrides,
  }
}

function permissionCapability(
  overrides: Partial<SolidPermissionCapability> = {},
): SolidPermissionCapability {
  return {
    inspectAgentAccess: vi.fn(async () => ({
      status: 'granted' as const,
      resources: [],
    })),
    ensureAgentAccess: vi.fn(async () => ({
      status: 'granted' as const,
      resources: [],
    })),
    revokeAgentAccess: vi.fn(async () => ({
      status: 'missing' as const,
      resources: [],
    })),
    ...overrides,
  }
}

function hostFromSolid(solid: WebExtensionSolidCapability): WebExtensionHost {
  return {
    solid,
    navigation: {
      openExternal: vi.fn(async () => undefined),
    },
    capabilities: {},
  } as WebExtensionHost
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('AI Connection controller host.solid integration', () => {
  it('creates the API client from host.solid session fetch and ready Pod URL', async () => {
    const solid = solidCapability()

    const controller = createAiConnectionsController(hostFromSolid(solid))

    expect(controller.sessionStatus).toBe('authenticated')
    expect(controller.client?.webId).toBe(WEB_ID)
    expect(controller.client?.apiBase).toBe('https://pod.example')

    await controller.client?.listProviders()

    expect(solid.session.fetch).not.toHaveBeenCalled()
  })

  it('requires login through host.solid for anonymous sessions', async () => {
    const requireLogin = vi.fn(async () => undefined)
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: vi.fn() as unknown as typeof fetch,
        getSnapshot: () => ({ status: 'anonymous' as const }),
        subscribe: () => () => undefined,
      },
      pod: { status: 'unavailable' },
      requireLogin,
    })))

    render(<AiConnectionsMain controller={controller} />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(requireLogin).toHaveBeenCalledTimes(1))
  })

  it('shows loading while the host-owned Pod is opening', () => {
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      pod: { status: 'opening' },
    })))

    render(<AiConnectionsMain controller={controller} />)

    expect(screen.getByRole('status').textContent).toContain('正在打开当前 Pod')
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()
  })

  it('shows a retryable error state when the host-owned Pod fails', () => {
    const requireLogin = vi.fn(async () => undefined)
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      pod: {
        status: 'error',
        error: new Error('Pod 打开失败'),
      },
      requireLogin,
    })))

    render(<AiConnectionsMain controller={controller} />)

    expect(screen.getByText('Pod 打开失败')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试登录' }))
    expect(requireLogin).toHaveBeenCalledTimes(1)
  })

  it('does not let stale provider loads roll back badge state after API key save or disconnect', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: fetcher,
        getSnapshot: () => ({
          status: 'authenticated',
          webId: WEB_ID,
        }),
        subscribe: () => () => undefined,
      },
      permissions: permissionCapability(),
    })))
    void controller.ensureServiceAccess()

    render(<>{<AiConnectionsList controller={controller} />}<AiConnectionsMain controller={controller} /></>)

    const openAiButton = screen.getByRole('option', { name: 'OpenAI' })
    const describedBy = openAiButton.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toBe('读取中')
    await waitFor(() => {
      expect(document.getElementById(describedBy!)?.textContent).toBe('未设置')
    })

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI API Key' }))
    await waitFor(() => {
      expect(screen.getByText('连接中')).toBeTruthy()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByText('连接中')).toBeTruthy()

    fireEvent.change(await screen.findByLabelText('OpenAI API Key 输入'), {
      target: { value: 'sk-provider-secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenAI API Key' }))

    await waitFor(() => {
      expect(document.getElementById(describedBy!)?.textContent).toBe('已配置')
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.getElementById(describedBy!)?.textContent).toBe('已配置')

    fireEvent.click(screen.getByRole('button', { name: '移除配置' }))

    await waitFor(() => {
      expect(document.getElementById(describedBy!)?.textContent).toBe('未设置')
    })
  })

  it('treats API-key provider summaries as configured through the controller and panel', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/ai/connections/providers')) {
        return new Response(JSON.stringify({
          data: [{
            provider: 'openai',
            status: 'connected',
            authMode: 'apiKey',
            baseUrl: 'https://api.openai.com/v1',
            connect: {
              modes: ['browserAssistedApiKey'],
              configured: true,
            },
          }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: fetcher,
        getSnapshot: () => ({
          status: 'authenticated',
          webId: WEB_ID,
        }),
        subscribe: () => () => undefined,
      },
      pod: {
        status: 'ready',
        current: {
          webId: WEB_ID,
          podUrl: POD_URL,
          database: createMemoryDatabase({
            credentials: [ connectedCredential('openai', { baseUrl: 'https://api.openai.com/v1' }) ],
          }),
          collections: 'ready',
        },
      },
      permissions: permissionCapability(),
    })))

    render(<>{<AiConnectionsList controller={controller} />}<AiConnectionsMain controller={controller} /></>)

    await controller.ensureServiceAccess()
    await controller.loadProviders()

    const openAiButton = screen.getByRole('option', { name: 'OpenAI' })
    const describedBy = openAiButton.getAttribute('aria-describedby')
    await waitFor(() => {
      expect(document.getElementById(describedBy!)?.textContent).toBe('已配置')
    })
    expect(screen.getByRole('button', { name: '更新 API Key' })).toBeTruthy()
  })

  it('single-flights Pod config bootstrap before loading providers', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/ai/connections/providers')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch
    const permissions = permissionCapability()
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: fetcher,
        getSnapshot: () => ({
          status: 'authenticated',
          webId: WEB_ID,
        }),
        subscribe: () => () => undefined,
      },
      permissions,
    })))

    await Promise.all([
      controller.ensureServiceAccess(),
      controller.ensureServiceAccess(),
    ])

    expect(controller.serviceAccessState).toBe('granted')
    expect(permissions.ensureAgentAccess).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not call the generic host permission capability for Pod config bootstrap', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    const permissions = permissionCapability()
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: fetcher,
        getSnapshot: () => ({
          status: 'authenticated',
          webId: WEB_ID,
        }),
        subscribe: () => () => undefined,
      },
      permissions,
    })))

    await controller.ensureServiceAccess()

    expect(controller.serviceAccessState).toBe('granted')
    expect(permissions.ensureAgentAccess).not.toHaveBeenCalled()
    expect(permissions.revokeAgentAccess).not.toHaveBeenCalled()
  })

  it('loads providers without a host permission capability', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: fetcher,
        getSnapshot: () => ({
          status: 'authenticated',
          webId: WEB_ID,
        }),
        subscribe: () => () => undefined,
      },
    })))

    await controller.ensureServiceAccess()

    expect(controller.serviceAccessState).toBe('granted')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
