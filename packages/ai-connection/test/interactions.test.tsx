// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiConnectionPanel,
  type AiClientConfigurationBridge,
  type AiConnectionClient,
} from '../src'
import type { AiClientCredentialManager } from '@undefineds.co/extension-sdk/web'

const WEB_ID = 'https://pod.example/alice/profile/card#me'

afterEach(cleanup)

function client(overrides: Partial<AiConnectionClient> = {}): AiConnectionClient {
  return {
    webId: WEB_ID,
    apiBase: 'https://pod.example',
    getServiceAccess: vi.fn(async () => ({ status: 'granted' })),
    listProviders: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    discoverModels: vi.fn(async (provider) => ({
      provider,
      version: 'sha256:empty',
      status: 'notFetched' as const,
      models: [],
    })),
    getProviderModels: vi.fn(async (provider) => ({
      provider,
      version: 'sha256:empty',
      status: 'notFetched' as const,
      models: [],
    })),
    replaceModelSelection: vi.fn(async (provider, selection) => ({
      provider,
      version: selection.expectedVersion ?? 'sha256:empty',
      status: 'ready' as const,
      models: selection.modelIds.map((id) => ({
        id,
        modelType: 'chat' as const,
        selected: true,
        availability: 'available' as const,
      })),
    })),
    beginConnect: vi.fn(async (provider, mode) => ({
      provider,
      mode,
      status: 'pending' as const,
      attemptId: 'attempt-1',
      state: 'state-1',
      signature: 'signature-1',
      authorizationUrl: 'https://provider.example/keys',
    })),
    connectStatus: vi.fn(),
    completeApiKey: vi.fn(async (provider) => ({
      provider,
      mode: 'browserAssistedApiKey' as const,
      status: 'completed' as const,
      credentialId: 'credential-1',
    })),
    pollDevice: vi.fn(),
    disconnect: vi.fn(async () => undefined),
    quota: vi.fn(async (provider) => ({
      credential: `${provider}-credential`,
      status: 'unsupported' as const,
      windows: [],
      observedAt: '2026-07-24T00:00:00.000Z',
      expiresAt: '2026-07-24T01:00:00.000Z',
      source: `${provider}:console-only`,
    })),
    ...overrides,
  }
}

function clientCredentialManager(
  overrides: Partial<AiClientCredentialManager> = {},
): AiClientCredentialManager {
  return {
    available: true,
    accountUrl: '/.account/',
    list: vi.fn(async () => []),
    create: vi.fn(async (input) => ({
      id: 'cred-1',
      resourceUrl: 'https://pod.example/.account/client-credentials/cred-1/',
      webId: input.webId,
      clientId: 'client-id-1',
      clientSecret: 'client-secret-1',
      apiKey: 'sk-Y2xpZW50LWlkLTE6Y2xpZW50LXNlY3JldC0x',
    })),
    revoke: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('AI Connection settings', () => {
  it('shows one selected Provider without repeating the Applet header or WebID hero', async () => {
    render(<AiConnectionPanel client={client()} selectedProvider="openai" serviceAccessGranted />)

    expect(screen.getByRole('heading', { name: 'OpenAI' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'AI Connection' })).toBeNull()
    expect(screen.queryByText(WEB_ID)).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Anthropic' })).toBeNull()
    expect(screen.queryByLabelText(/pod url/i)).toBeNull()
    expect(screen.queryByText(/local|cloud|deployment/i)).toBeNull()
  })

  it('presents browser auth as connected and masks the account label', async () => {
    const current = client({
      listProviders: vi.fn(async () => [{
        provider: 'kimi' as const,
        status: 'connected' as const,
        authMode: 'deviceCodeOAuth',
        accountLabel: 'alice@example.com',
        connect: {
          modes: ['deviceCodeOAuth' as const, 'browserAssistedApiKey' as const],
          configured: true,
        },
      }]),
    })
    render(
      <AiConnectionPanel
        client={current}
        selectedProvider="kimi"
        serviceAccessGranted
        providerSummaries={{
          kimi: {
            provider: 'kimi',
            status: 'connected',
            authMode: 'deviceCodeOAuth',
            accountLabel: 'alice@example.com',
            connect: {
              modes: ['deviceCodeOAuth', 'browserAssistedApiKey'],
              configured: true,
            },
          },
        }}
      />,
    )

    expect(await screen.findByText('a***e@example.com')).toBeTruthy()
    expect(screen.queryByText('alice@example.com')).toBeNull()
    expect(screen.getByText('已连接')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新连接' })).toBeTruthy()
  })

  it('presents an API-key credential as configured', async () => {
    const current = client({
      listProviders: vi.fn(async () => [{
        provider: 'deepseek' as const,
        status: 'connected' as const,
        authMode: 'browserAssistedApiKey',
        connect: {
          modes: ['browserAssistedApiKey' as const],
          configured: true,
        },
      }]),
    })

    render(
      <AiConnectionPanel
        client={current}
        selectedProvider="deepseek"
        serviceAccessGranted
        providerSummaries={{
          deepseek: {
            provider: 'deepseek',
            status: 'connected',
            authMode: 'browserAssistedApiKey',
            connect: {
              modes: ['browserAssistedApiKey'],
              configured: true,
            },
          },
        }}
      />,
    )

    expect(await screen.findByText('已配置')).toBeTruthy()
    expect(screen.getByRole('button', { name: '更新 API Key' })).toBeTruthy()
  })

  it('opens browser-assisted key setup and submits the key without rendering it afterwards', async () => {
    const current = client()
    const openExternal = vi.fn()
    render(<AiConnectionPanel client={current} openExternal={openExternal} serviceAccessGranted />)

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI API Key' }))
    await waitFor(() => expect(current.beginConnect).toHaveBeenCalledWith('openai', 'browserAssistedApiKey'))
    expect(openExternal).toHaveBeenCalledWith('https://provider.example/keys')

    fireEvent.change(screen.getByLabelText('OpenAI API Key 输入'), {
      target: { value: 'sk-provider-secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenAI API Key' }))

    await waitFor(() => expect(current.completeApiKey).toHaveBeenCalled())
    expect(screen.queryByDisplayValue('sk-provider-secret')).toBeNull()
    expect(screen.queryByText('sk-provider-secret')).toBeNull()
    expect(screen.getByText('已配置')).toBeTruthy()
  })

  it('opens the DeepSeek official console for its browser-assisted API-key flow', async () => {
    const current = client()
    const openExternal = vi.fn()
    render(
      <AiConnectionPanel
        client={current}
        selectedProvider="deepseek"
        openExternal={openExternal}
        serviceAccessGranted
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '打开官方控制台' }))

    await waitFor(() => expect(current.beginConnect).toHaveBeenCalledWith('deepseek', 'browserAssistedApiKey'))
    expect(openExternal).toHaveBeenCalledWith('https://provider.example/keys')
  })

  it('recovers visibly when a browser-assisted connection expires before API Key entry', async () => {
    const current = client({
      beginConnect: vi.fn(async (provider, mode) => ({
        provider,
        mode,
        status: 'expired' as const,
        message: '连接已过期，请重新开始',
      })),
    })
    render(<AiConnectionPanel client={current} selectedProvider="openai" serviceAccessGranted />)

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI API Key' }))

    expect(await screen.findByText('连接已过期，请重新开始')).toBeTruthy()
    expect(screen.queryByLabelText('OpenAI API Key 输入')).toBeNull()
  })

  it('does not render raw secret material from provider errors', async () => {
    const current = client({
      beginConnect: vi.fn(async () => {
        throw new Error('upstream failed sk-live-secret xpod_once_secret apiKey=secret token=secret Authorization: Bearer secret {"secret":"json-secret"}')
      }),
    })
    render(<AiConnectionPanel client={current} selectedProvider="openai" serviceAccessGranted />)

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI API Key' }))

    expect(await screen.findByText('AI Connection request failed. Please try again.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/sk-live-secret|xpod_once_secret|apiKey=secret|token=secret|Bearer secret|json-secret/)
  })

  it('states unsupported quota honestly', async () => {
    const current = client()
    render(<AiConnectionPanel client={current} serviceAccessGranted />)

    fireEvent.click(screen.getByRole('button', { name: '刷新 OpenAI 额度' }))

    await waitFor(() => expect(current.quota).toHaveBeenCalledWith('openai', true))
    expect(screen.getByText('官方额度接口不支持')).toBeTruthy()
    expect(screen.getByText('来源：openai:console-only')).toBeTruthy()
  })

  it('renders allowlisted unsupported errors without raw details', async () => {
    const current = client({
      quota: vi.fn(async () => {
        throw new Error('unsupported: Authorization Bearer provider-secret token=provider-secret')
      }),
    })
    render(<AiConnectionPanel client={current} selectedProvider="openai" serviceAccessGranted />)

    fireEvent.click(screen.getByRole('button', { name: '刷新 OpenAI 额度' }))

    expect(await screen.findByText('This AI Connection operation is not supported.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Bearer|token|provider-secret/)
  })

  it('shows only the selected Provider models from the current WebID catalog', async () => {
    const current = client({
      listModels: vi.fn(async () => [
        { id: 'gpt-5.4', provider: 'openai' as const, displayName: 'GPT-5.4' },
        { id: 'claude-sonnet-4-5', provider: 'anthropic' as const, displayName: 'Claude Sonnet 4.5' },
      ]),
    })

    render(<AiConnectionPanel client={current} selectedProvider="openai" serviceAccessGranted />)

    expect(await screen.findByText('GPT-5.4')).toBeTruthy()
    expect(screen.queryByText('Claude Sonnet 4.5')).toBeNull()
    expect(current.listModels).toHaveBeenCalledOnce()
  })

  it('auto-discovers connected models and saves a searchable selection with its version', async () => {
    const catalog = {
      provider: 'openai' as const,
      fetchedAt: '2026-08-05T00:00:00.000Z',
      version: 'sha256:catalog',
      status: 'ready' as const,
      models: [
        { id: 'gpt-5', displayName: 'GPT-5', modelType: 'chat' as const, selected: false, availability: 'available' as const },
        { id: 'gpt-4.1', displayName: 'GPT-4.1', modelType: 'chat' as const, selected: true, availability: 'available' as const },
      ],
    }
    const current = client({
      getProviderModels: vi.fn(async () => catalog),
      discoverModels: vi.fn(async () => catalog),
      replaceModelSelection: vi.fn(async (_provider, selection) => ({
        ...catalog,
        version: 'sha256:saved',
        models: catalog.models.map((model) => ({ ...model, selected: selection.modelIds.includes(model.id) })),
      })),
    })
    render(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{
          openai: {
            provider: 'openai',
            status: 'connected',
            connect: { modes: ['browserAssistedApiKey'], configured: true },
          },
        }}
      />,
    )

    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('openai'))
    const search = await screen.findByRole('searchbox', { name: '搜索模型' })
    fireEvent.change(search, { target: { value: 'gpt-5' } })
    const checkbox = screen.getByRole('checkbox', { name: /GPT-5/ }) as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)
    expect(screen.getByText('已选 2 个')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存模型' }))

    await waitFor(() => expect(current.replaceModelSelection).toHaveBeenCalledWith('openai', {
      modelIds: ['gpt-5', 'gpt-4.1'],
      expectedVersion: 'sha256:catalog',
    }))
    expect(await screen.findByText('已保存')).toBeTruthy()
  })

  it('uses discovery directly when the selected Provider is already connected', async () => {
    const catalog = {
      provider: 'openai' as const,
      version: 'sha256:catalog',
      status: 'ready' as const,
      models: [{
        id: 'gpt-5',
        displayName: 'GPT-5',
        modelType: 'chat' as const,
        selected: true,
        availability: 'available' as const,
      }],
    }
    const getProviderModels = vi.fn(async () => catalog)
    const discoverModels = vi.fn(async () => catalog)
    const current = client({ getProviderModels, discoverModels })

    render(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{
          openai: {
            provider: 'openai',
            status: 'connected',
            authMode: 'deviceCodeOAuth',
            connect: { modes: ['deviceCodeOAuth'], configured: true },
          },
        }}
      />,
    )

    await waitFor(() => expect(discoverModels).toHaveBeenCalledWith('openai'))
    expect(getProviderModels).not.toHaveBeenCalled()
  })

  it('refreshes the connected Provider model catalog from the visible model action', async () => {
    const catalog = {
      provider: 'openai' as const,
      version: 'sha256:catalog',
      status: 'ready' as const,
      models: [{
        id: 'gpt-5',
        displayName: 'GPT-5',
        modelType: 'chat' as const,
        selected: true,
        availability: 'available' as const,
      }],
    }
    const discoverModels = vi.fn(async () => catalog)
    const current = client({ discoverModels })

    render(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{
          openai: {
            provider: 'openai',
            status: 'connected',
            authMode: 'deviceCodeOAuth',
            connect: { modes: ['deviceCodeOAuth'], configured: true },
          },
        }}
      />,
    )

    await waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: '刷新模型' }))
    await waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(2))
  })

  it('discovers models after an API-key connection completes', async () => {
    const catalog = {
      provider: 'openai' as const,
      version: 'sha256:catalog',
      status: 'ready' as const,
      models: [{
        id: 'gpt-5',
        displayName: 'GPT-5',
        modelType: 'chat' as const,
        selected: false,
        availability: 'available' as const,
      }],
    }
    const current = client({
      discoverModels: vi.fn(async () => catalog),
      getProviderModels: vi.fn(async () => ({ ...catalog, status: 'notFetched' as const, models: [] })),
    })
    render(<AiConnectionPanel client={current} selectedProvider="openai" serviceAccessGranted />)

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI API Key' }))
    await waitFor(() => expect(current.beginConnect).toHaveBeenCalledWith('openai', 'browserAssistedApiKey'))
    fireEvent.change(await screen.findByLabelText('OpenAI API Key 输入'), {
      target: { value: 'sk-provider-secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenAI API Key' }))

    await waitFor(() => expect(current.completeApiKey).toHaveBeenCalled())
    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('openai'))
    expect(document.body.textContent).not.toContain('sk-provider-secret')
  })

  it.each([
    ['disconnected', 'disconnected' as const],
    ['reauth required', 'reauthRequired' as const],
    ['failed', 'failed' as const],
    ['unknown', 'unknown' as const],
  ])('does not allow stale ready catalogs to add models when the Provider is %s', async (_label, status) => {
    const catalog = {
      provider: 'openai' as const,
      version: 'sha256:catalog',
      status: 'ready' as const,
      models: [
        {
          id: 'picked-model',
          displayName: 'Picked model',
          modelType: 'chat' as const,
          selected: true,
          availability: 'available' as const,
        },
        {
          id: 'new-model',
          displayName: 'New model',
          modelType: 'chat' as const,
          selected: false,
          availability: 'available' as const,
        },
      ],
    }
    const current = client({
      discoverModels: vi.fn(async () => catalog),
      getProviderModels: vi.fn(async () => catalog),
    })
    const { rerender } = render(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{
          openai: {
            provider: 'openai',
            status: 'connected',
            authMode: 'deviceCodeOAuth',
            connect: { modes: ['deviceCodeOAuth'], configured: true },
          },
        }}
      />,
    )

    await screen.findByRole('checkbox', { name: /New model/ })
    rerender(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{
          openai: {
            provider: 'openai',
            status,
            connect: { modes: ['deviceCodeOAuth'], configured: false },
          },
        }}
      />,
    )

    await waitFor(() => expect((screen.getByRole('checkbox', { name: /New model/ }) as HTMLInputElement).disabled).toBe(true))
    expect((screen.getByRole('checkbox', { name: /Picked model/ }) as HTMLInputElement).disabled).toBe(false)
  })

  it('blocks save additions when connection state changes before durable refresh completes', async () => {
    const catalog = {
      provider: 'openai' as const,
      version: 'sha256:catalog',
      status: 'ready' as const,
      models: [{
        id: 'new-model',
        displayName: 'New model',
        modelType: 'chat' as const,
        selected: false,
        availability: 'available' as const,
      }],
    }
    const getProviderModels = vi.fn(() => new Promise<never>(() => undefined))
    const replaceModelSelection = vi.fn(async () => catalog)
    const current = client({
      discoverModels: vi.fn(async () => catalog),
      getProviderModels,
      replaceModelSelection,
    })
    const connectedSummary = {
      provider: 'openai' as const,
      status: 'connected' as const,
      connect: { modes: ['deviceCodeOAuth'] as const, configured: true },
    }
    const { rerender } = render(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{ openai: connectedSummary }}
      />,
    )

    const checkbox = await screen.findByRole('checkbox', { name: /New model/ })
    fireEvent.click(checkbox)
    expect(screen.getByRole('button', { name: '保存模型' })).toBeTruthy()

    rerender(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{
          openai: {
            provider: 'openai',
            status: 'disconnected',
            connect: { modes: ['deviceCodeOAuth'], configured: false },
          },
        }}
      />,
    )

    await waitFor(() => expect((screen.getByRole('button', { name: '保存模型' }) as HTMLButtonElement).disabled).toBe(true))
    expect(screen.getByText('请先重新连接后再添加模型。')).toBeTruthy()
    expect(replaceModelSelection).not.toHaveBeenCalled()
    expect(getProviderModels).toHaveBeenCalledWith('openai')
  })

  it('keeps a status-unknown selected model removable but blocks new picks', async () => {
    const current = client({
      discoverModels: vi.fn(async () => ({
        provider: 'openai' as const,
        version: 'sha256:unknown',
        status: 'statusUnknown' as const,
        models: [
          {
            id: 'picked-model',
            displayName: 'Picked model',
            modelType: 'chat' as const,
            selected: true,
            availability: 'statusUnknown' as const,
          },
          {
            id: 'new-model',
            displayName: 'New model',
            modelType: 'chat' as const,
            selected: false,
            availability: 'available' as const,
          },
        ],
      })),
    })
    render(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{
          openai: {
            provider: 'openai',
            status: 'connected',
            connect: { modes: ['deviceCodeOAuth'], configured: true },
          },
        }}
      />,
    )

    expect(await screen.findByText('供应商目录暂时无法确认；已选模型保持不变。')).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: /New model/ }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('checkbox', { name: /Picked model/ }) as HTMLInputElement).disabled).toBe(false)
  })

  it('does not pretend a disconnected cancellation was saved when the server needs reconnect', async () => {
    const catalog = {
      provider: 'openai' as const,
      version: 'sha256:durable',
      status: 'notFetched' as const,
      models: [{
        id: 'picked-model',
        displayName: 'Picked model',
        modelType: 'chat' as const,
        selected: true,
        availability: 'statusUnknown' as const,
      }],
    }
    const current = client({
      getProviderModels: vi.fn(async () => catalog),
      replaceModelSelection: vi.fn(async () => {
        throw new Error('model_catalog_not_ready')
      }),
    })
    render(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{
          openai: {
            provider: 'openai',
            status: 'disconnected',
            connect: { modes: ['deviceCodeOAuth'], configured: false },
          },
        }}
      />,
    )

    const checkbox = await screen.findByRole('checkbox', { name: /Picked model/ }) as HTMLInputElement
    expect(checkbox.disabled).toBe(false)
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: '保存模型' }))

    await waitFor(() => expect(current.replaceModelSelection).toHaveBeenCalledWith('openai', {
      modelIds: [],
      expectedVersion: 'sha256:durable',
    }))
    expect(await screen.findByText('请先重新连接后再保存模型选择。')).toBeTruthy()
    expect(screen.queryByText('已保存')).toBeNull()
  })

  it('re-runs discovery after a disconnected Provider reconnects', async () => {
    const catalog = {
      provider: 'openai' as const,
      version: 'sha256:catalog',
      status: 'ready' as const,
      models: [{
        id: 'picked-model',
        displayName: 'Picked model',
        modelType: 'chat' as const,
        selected: true,
        availability: 'available' as const,
      }],
    }
    const discoverModels = vi.fn(async () => catalog)
    const current = client({ discoverModels })
    const connectedSummary = {
      provider: 'openai' as const,
      status: 'connected' as const,
      connect: { modes: ['deviceCodeOAuth'] as const, configured: true },
    }
    const { rerender } = render(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{ openai: connectedSummary }}
      />,
    )

    await waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(1))
    rerender(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{
          openai: {
            provider: 'openai',
            status: 'disconnected',
            connect: { modes: ['deviceCodeOAuth'], configured: false },
          },
        }}
      />,
    )
    rerender(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{ openai: connectedSummary }}
      />,
    )

    await waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(2))
  })

  it('uses the latest disconnected summary before effects refresh a stale ready catalog', async () => {
    const catalog = {
      provider: 'openai' as const,
      version: 'sha256:catalog',
      status: 'ready' as const,
      models: [{
        id: 'new-model',
        displayName: 'New model',
        modelType: 'chat' as const,
        selected: false,
        availability: 'available' as const,
      }],
    }
    const getProviderModels = vi.fn(() => new Promise<never>(() => undefined))
    const current = client({
      discoverModels: vi.fn(async () => catalog),
      getProviderModels,
    })
    const connectedSummary = {
      provider: 'openai' as const,
      status: 'connected' as const,
      authMode: 'deviceCodeOAuth',
      connect: { modes: ['deviceCodeOAuth'] as const, configured: true },
    }
    const { rerender } = render(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{ openai: connectedSummary }}
      />,
    )

    await screen.findByRole('checkbox', { name: /New model/ })
    rerender(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{
          openai: {
            provider: 'openai',
            status: 'disconnected',
            connect: { modes: ['deviceCodeOAuth'], configured: false },
          },
        }}
      />,
    )

    expect(screen.getByText('未设置')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存模型' })).toBeNull()
  })

  it('keeps selected unavailable models visible and gives discovery failures an inline retry', async () => {
    const durableCatalog = {
      provider: 'openai' as const,
      version: 'sha256:durable',
      status: 'notFetched' as const,
      models: [{
        id: 'retired-model',
        displayName: 'Retired model',
        modelType: 'chat' as const,
        selected: true,
        availability: 'unavailable' as const,
      }],
    }
    const current = client({
      getProviderModels: vi.fn(async () => durableCatalog),
      discoverModels: vi.fn()
        .mockRejectedValueOnce(new Error('provider secret should not render'))
        .mockResolvedValueOnce({ ...durableCatalog, status: 'ready' as const }),
    })
    render(
      <AiConnectionPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{
          openai: {
            provider: 'openai',
            status: 'connected',
            connect: { modes: ['browserAssistedApiKey'], configured: true },
          },
        }}
      />,
    )

    expect(await screen.findByText('Retired model')).toBeTruthy()
    expect(screen.getByText('供应商已不可用')).toBeTruthy()
    expect((await screen.findByRole('alert')).textContent).toContain('AI Connection request failed. Please try again.')
    fireEvent.click(screen.getByRole('button', { name: '重试读取模型' }))
    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledTimes(2))
    expect(document.body.textContent).not.toContain('provider secret')
  })

  it('displays a created Client Credential once and removes it when acknowledged', async () => {
    const current = client()
    const credentials = clientCredentialManager()
    render(<AiConnectionPanel client={current} clientCredentialManager={credentials} serviceAccessGranted />)

    fireEvent.change(screen.getByLabelText('Client Credential 名称'), {
      target: { value: 'Codex' },
    })
    fireEvent.click(screen.getByRole('button', { name: '创建 Client Credential' }))

    expect(await screen.findByText('sk-Y2xpZW50LWlkLTE6Y2xpZW50LXNlY3JldC0x')).toBeTruthy()
    expect(screen.getByText('client-id-1')).toBeTruthy()
    expect(screen.getByText('client-secret-1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '我已保存，隐藏密钥' }))
    expect(screen.queryByText('sk-Y2xpZW50LWlkLTE6Y2xpZW50LXNlY3JldC0x')).toBeNull()
    expect(credentials.create).toHaveBeenCalledWith({ name: 'Codex', webId: WEB_ID })
    expect(screen.getByText('cred-1')).toBeTruthy()
  })

  it('creates a managed Client Credential when configuring a client without exposing it', async () => {
    const plan = vi.fn(async () => ({
      planId: 'plan-1',
      client: 'codex' as const,
      changes: [{
        target: '~/.codex/config.toml',
        action: 'update' as const,
        backup: true,
      }],
    }))
    const apply = vi.fn(async () => ({ applied: true as const }))
    const verify = vi.fn(async () => ({ status: 'configured' as const }))
    const bridge: AiClientConfigurationBridge = {
      inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
      plan,
      apply,
      verify,
      restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
    }
    const current = client()
    const credentials = clientCredentialManager()
    render(<AiConnectionPanel client={current} clientConfigurationBridge={bridge} clientCredentialManager={credentials} serviceAccessGranted />)

    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[0])

    await waitFor(() => expect(plan).toHaveBeenCalledWith({
      client: 'codex',
      endpoint: 'https://pod.example',
    }))
    expect(credentials.create).not.toHaveBeenCalled()
    expect(screen.getByText('~/.codex/config.toml')).toBeTruthy()
    expect(screen.queryByText(/sk-Y2xpZW50/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '应用 Codex 配置' }))
    await waitFor(() => expect(credentials.create).toHaveBeenCalledWith({
      name: 'AI Connection · Codex',
      webId: WEB_ID,
    }))
    await waitFor(() => expect(apply).toHaveBeenCalledWith({
      client: 'codex',
      planId: 'plan-1',
      apiKey: 'sk-Y2xpZW50LWlkLTE6Y2xpZW50LXNlY3JldC0x',
    }))
    expect(verify).toHaveBeenCalledWith({ client: 'codex', planId: 'plan-1' })
    expect(credentials.revoke).not.toHaveBeenCalled()
  })

  it('requires explicit replacement confirmation before applying a risky client plan', async () => {
    const plan = vi.fn(async () => ({
      planId: 'plan-pi',
      client: 'pi' as const,
      confirmation: {
        required: true,
        token: 'confirm-plan-pi-target',
        targetHash: 'target-hash-pi',
        message: 'Pi will replace the active default model.',
      },
      changes: [{
        target: '~/.pi/agent/models.json',
        action: 'update' as const,
        backup: true,
      }],
    }))
    const apply = vi.fn(async () => ({ applied: true as const }))
    const bridge: AiClientConfigurationBridge = {
      inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
      plan,
      apply,
      verify: vi.fn(async () => ({ status: 'configured' as const })),
      restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
    }
    const current = client()
    const credentials = clientCredentialManager()
    render(<AiConnectionPanel client={current} clientConfigurationBridge={bridge} clientCredentialManager={credentials} serviceAccessGranted />)

    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[2])
    expect(await screen.findByText('Pi will replace the active default model.')).toBeTruthy()
    expect((screen.getByRole('button', { name: '确认并应用 Pi 配置' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('输入确认码以应用 Pi 配置'), {
      target: { value: 'confirm-plan-pi-target' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认并应用 Pi 配置' }))

    await waitFor(() => expect(apply).toHaveBeenCalledWith({
      client: 'pi',
      planId: 'plan-pi',
      apiKey: 'sk-Y2xpZW50LWlkLTE6Y2xpZW50LXNlY3JldC0x',
      confirmation: {
        token: 'confirm-plan-pi-target',
        targetHash: 'target-hash-pi',
      },
    }))
  })

  it('surfaces verification rollback as a distinct failed-and-restored client state', async () => {
    class RestoredError extends Error {
      public readonly code = 'verification_failed_restored'
      public readonly status = 502
      public readonly details = { restored: true }
    }
    const bridge: AiClientConfigurationBridge = {
      inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
      plan: vi.fn(async () => ({
        planId: 'plan-restored',
        client: 'codex' as const,
        changes: [{
          target: '~/.codex/config.toml',
          action: 'update' as const,
          backup: true,
        }],
      })),
      apply: vi.fn(async () => {
        throw new RestoredError('verification_failed_restored')
      }),
      verify: vi.fn(),
      restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
    }
    const current = client()
    render(<AiConnectionPanel client={current} clientConfigurationBridge={bridge} clientCredentialManager={clientCredentialManager()} serviceAccessGranted />)

    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[0])
    fireEvent.click(await screen.findByRole('button', { name: '应用 Codex 配置' }))

    expect(await screen.findByText('配置验证失败，已自动恢复原配置。')).toBeTruthy()
    expect(screen.getByText('已恢复')).toBeTruthy()
  })

  it('revokes only the newly-created Client Credential when native Apply fails', async () => {
    const bridge: AiClientConfigurationBridge = {
      inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
      plan: vi.fn(async () => ({
        planId: 'plan-failure',
        client: 'codex' as const,
        changes: [],
      })),
      apply: vi.fn(async () => {
        throw new Error('Mock Apply failed')
      }),
      verify: vi.fn(),
      restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
    }
    const current = client()
    const credentials = clientCredentialManager()
    render(<AiConnectionPanel client={current} clientConfigurationBridge={bridge} clientCredentialManager={credentials} serviceAccessGranted />)

    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[0])
    await screen.findByRole('button', { name: '应用 Codex 配置' })
    fireEvent.click(screen.getByRole('button', { name: '应用 Codex 配置' }))

    await waitFor(() => expect(credentials.revoke).toHaveBeenCalledWith('https://pod.example/.account/client-credentials/cred-1/'))
    expect(bridge.verify).not.toHaveBeenCalled()
  })

  it('surfaces a manual recovery path when Apply and automatic Client Credential revocation both fail', async () => {
    const bridge: AiClientConfigurationBridge = {
      inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
      plan: vi.fn(async () => ({
        planId: 'plan-double-failure',
        client: 'codex' as const,
        changes: [],
      })),
      apply: vi.fn(async () => {
        throw new Error('Mock Apply failed')
      }),
      verify: vi.fn(),
      restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
    }
    const current = client()
    const credentials = clientCredentialManager({
      revoke: vi.fn(async () => {
        throw new Error('Mock revoke failed')
      }),
    })
    render(<AiConnectionPanel client={current} clientConfigurationBridge={bridge} clientCredentialManager={credentials} serviceAccessGranted />)

    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[0])
    fireEvent.click(await screen.findByRole('button', { name: '应用 Codex 配置' }))

    expect(await screen.findByText(/自动撤销新建 Client Credential 失败/)).toBeTruthy()
    expect(screen.getByText(/请到 Account Developer Access 手动撤销/)).toBeTruthy()
  })

  it('does not open or poll a terminal Kimi device-code attempt', async () => {
    const current = client({
      beginConnect: vi.fn(async (provider, mode) => ({
        provider,
        mode,
        status: 'cancelled' as const,
        authorizationUrl: 'https://provider.example/stale',
        message: '用户已取消连接',
      })),
    })
    const openExternal = vi.fn()
    render(
      <AiConnectionPanel
        client={current}
        selectedProvider="kimi"
        openExternal={openExternal}
        serviceAccessGranted
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '浏览器鉴权' }))

    expect(await screen.findByText('用户已取消连接')).toBeTruthy()
    expect(openExternal).not.toHaveBeenCalled()
    expect(current.pollDevice).not.toHaveBeenCalled()
  })

  it('fails closed by default and does not call mutation APIs before service access is granted', async () => {
    const plan = vi.fn(async () => ({
      planId: 'plan-1',
      client: 'codex' as const,
      changes: [{
        target: '~/.codex/config.toml',
        action: 'update' as const,
        backup: true,
      }],
    }))
    const bridge: AiClientConfigurationBridge = {
      inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
      plan,
      apply: vi.fn(async () => ({ applied: true as const })),
      verify: vi.fn(async () => ({ status: 'configured' as const })),
      restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
    }
    const current = client({
    })
    const credentials = clientCredentialManager({
      list: vi.fn(async () => [{
        id: 'Codex',
        resourceUrl: 'https://pod.example/.account/client-credentials/codex/',
        webId: WEB_ID,
      }]),
    })

    render(<AiConnectionPanel client={current} clientConfigurationBridge={bridge} clientCredentialManager={credentials} />)

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI API Key' }))
    fireEvent.click(screen.getByRole('button', { name: '创建 Client Credential' }))
    fireEvent.click(await screen.findByRole('button', { name: '撤销 Codex' }))
    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[0])
    await waitFor(() => expect(plan).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '应用 Codex 配置' }))

    expect(current.beginConnect).not.toHaveBeenCalled()
    expect(current.completeApiKey).not.toHaveBeenCalled()
    expect(credentials.create).not.toHaveBeenCalled()
    expect(credentials.revoke).not.toHaveBeenCalled()
    expect(bridge.apply).not.toHaveBeenCalled()
    expect(bridge.verify).not.toHaveBeenCalled()
  })
})
