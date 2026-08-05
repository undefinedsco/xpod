// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SolidPermissionCapability,
  SolidServiceAccessRequest,
  WebExtensionHost,
  WebExtensionSolidCapability,
} from '@undefineds.co/extension-sdk/web'
import { AiConnectionsList, AiConnectionsMain, createAiConnectionsController } from '../src'

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const POD_URL = 'https://pod.example/alice/'

const SERVICE_ACCESS_DESCRIPTOR = {
  appletId: 'co.undefineds.ai-connections',
  service: {
    webId: 'https://id.example/xpod/profile/card#me',
    label: 'Xpod AI Connection',
  },
  resources: [{
    id: 'providerCredentials',
    url: 'https://pod.example/alice/settings/credentials.ttl',
    mediaType: 'text/turtle',
    access: { read: true, append: true, write: true },
  }],
} satisfies SolidServiceAccessRequest

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
        database: { id: 'db' },
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
      resources: SERVICE_ACCESS_DESCRIPTOR.resources,
    })),
    ensureAgentAccess: vi.fn(async () => ({
      status: 'granted' as const,
      resources: SERVICE_ACCESS_DESCRIPTOR.resources,
    })),
    revokeAgentAccess: vi.fn(async () => ({
      status: 'missing' as const,
      resources: SERVICE_ACCESS_DESCRIPTOR.resources,
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

    await controller.client?.listGatewayKeys()

    await waitFor(() => {
      expect(solid.session.fetch).toHaveBeenCalledWith(
        'https://pod.example/api/ai/gateway/keys',
        expect.objectContaining({ method: 'GET' }),
      )
    })
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
    const staleProviderLoad = deferred<Response>()
    const providerLoadQueue = [staleProviderLoad]
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/ai/connections/providers')) {
        const load = providerLoadQueue.shift()
        if (!load) throw new Error('Unexpected provider load')
        return await load.promise
      }
      if (url.endsWith('/api/applets/service-access/ai-connections')) {
        return new Response(JSON.stringify(SERVICE_ACCESS_DESCRIPTOR), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/ai/gateway/keys')) {
        return new Response(JSON.stringify({ data: [] }), {
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
      if (url.endsWith('/api/ai/gateway/providers/openai/connect/begin')) {
        return new Response(JSON.stringify({
          provider: 'openai',
          mode: 'browserAssistedApiKey',
          status: 'pending',
          attemptId: 'attempt-1',
          state: 'state-1',
          signature: 'signature-1',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/ai/gateway/providers/openai/connect/complete-api-key')) {
        return new Response(JSON.stringify({
          provider: 'openai',
          mode: 'browserAssistedApiKey',
          status: 'completed',
          credentialId: 'credential-1',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/ai/gateway/providers/openai/connect')) {
        return new Response(JSON.stringify({
          record: {
            id: 'credential-1',
            credentialIri: 'https://pod.example/credentials/openai',
            webId: WEB_ID,
            provider: 'openai',
            authMode: 'browserAssistedApiKey',
            status: 'disconnected',
          },
        }), {
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

    const openAiButton = screen.getByRole('button', { name: 'OpenAI' })
    const describedBy = openAiButton.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toBe('读取中')
    await waitFor(() => {
      expect(
        vi.mocked(fetcher).mock.calls.filter(([input]) => String(input).endsWith('/api/ai/connections/providers')),
      ).toHaveLength(1)
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

    const staleDisconnected = new Response(JSON.stringify({
      data: [{
        provider: 'openai',
        status: 'disconnected',
        connect: {
          modes: ['browserAssistedApiKey'],
          configured: false,
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    staleProviderLoad.resolve(staleDisconnected)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.getElementById(describedBy!)?.textContent).toBe('已配置')

    fireEvent.click(screen.getByRole('button', { name: '移除配置' }))

    await waitFor(() => {
      expect(document.getElementById(describedBy!)?.textContent).toBe('未设置')
    })
  })

  it('single-flights service access bootstrap before loading providers', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/applets/service-access/ai-connections')) {
        return new Response(JSON.stringify(SERVICE_ACCESS_DESCRIPTOR), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
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
    expect(fetcher).toHaveBeenCalledWith(
      'https://pod.example/api/applets/service-access/ai-connections',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(permissions.ensureAgentAccess).toHaveBeenCalledTimes(1)
    expect(permissions.ensureAgentAccess).toHaveBeenCalledWith(
      expect.objectContaining({ appletId: 'co.undefineds.ai-connections' }),
    )
    expect(
      vi.mocked(fetcher).mock.calls.filter(([input]) => String(input).endsWith('/api/ai/connections/providers')),
    ).toHaveLength(1)
  })

  it('revokes service access through the generic host permission capability', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/applets/service-access/ai-connections')) {
        return new Response(JSON.stringify(SERVICE_ACCESS_DESCRIPTOR), {
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

    await controller.revokeServiceAccess()

    expect(controller.serviceAccessState).toBe('missing')
    expect(permissions.revokeAgentAccess).toHaveBeenCalledTimes(1)
    expect(permissions.revokeAgentAccess).toHaveBeenCalledWith(
      expect.objectContaining({ appletId: 'co.undefineds.ai-connections' }),
    )
    expect(permissions.ensureAgentAccess).not.toHaveBeenCalled()
  })

  it('does not load providers when host permission capability is unavailable', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(SERVICE_ACCESS_DESCRIPTOR), {
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

    expect(controller.serviceAccessState).toBe('capabilityUnavailable')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('maps malformed service-access descriptors to invalidDescriptor', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/applets/service-access/ai-connections')) {
        return new Response(JSON.stringify({
          appletId: 'co.undefineds.ai-connections',
          service: {
            webId: 'https://id.example/xpod/profile/card#me',
            label: 'Xpod AI Connection',
          },
          resources: [],
        }), {
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

    await controller.ensureServiceAccess()

    expect(controller.serviceAccessState).toBe('invalidDescriptor')
    expect(permissions.ensureAgentAccess).not.toHaveBeenCalled()
  })

  it('maps malformed service-access resource URLs to invalidDescriptor', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/applets/service-access/ai-connections')) {
        return new Response(JSON.stringify({
          appletId: 'co.undefineds.ai-connections',
          service: {
            webId: 'https://id.example/xpod/profile/card#me',
            label: 'Xpod AI Connection',
          },
          resources: [{
            id: 'providerCredentials',
            url: 'not a url',
            mediaType: 'text/turtle',
            access: { read: true, append: true, write: true },
          }],
        }), {
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

    await controller.ensureServiceAccess()

    expect(controller.serviceAccessState).toBe('invalidDescriptor')
    expect(permissions.ensureAgentAccess).not.toHaveBeenCalled()
  })
})
