// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiConnectionsPanel,
  type AiConnectionsClient,
} from '../src'

const WEB_ID = 'https://pod.example/alice/profile/card#me'

afterEach(cleanup)

function client(overrides: Partial<AiConnectionsClient> = {}): AiConnectionsClient {
  return {
    webId: WEB_ID,
    apiBase: 'https://pod.example',
    listProviders: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
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
    discoverModels: vi.fn(async (provider) => ({
      provider,
      credential: `${provider}-credential`,
      models: [{ id: `${provider}-model-1`, displayName: `${provider} Model 1` }],
      observedAt: '2026-08-06T00:00:00.000Z',
      source: `${provider}:/models`,
    })),
    saveProviderModel: vi.fn(async (_provider, model) => [model]),
    deleteProviderModel: vi.fn(async () => []),
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

describe('AI Connection settings', () => {
  it('shows one selected Provider without repeating the Applet header or WebID hero', async () => {
    render(<AiConnectionsPanel client={client()} selectedProvider="openai" serviceAccessGranted />)

    expect(screen.getByRole('heading', { name: 'OpenAI' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'AI Connection' })).toBeNull()
    expect(screen.queryByText(WEB_ID)).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Anthropic' })).toBeNull()
    expect(screen.queryByLabelText(/pod url/i)).toBeNull()
    expect(screen.queryByText(/local|cloud|deployment/i)).toBeNull()
  })

  it('presents API-key auth as connected and masks the account label', async () => {
    const current = client({
      listProviders: vi.fn(async () => [{
        provider: 'kimi' as const,
        status: 'connected' as const,
        authMode: 'apiKey',
        accountLabel: 'alice@example.com',
        connect: {
          modes: ['browserAssistedApiKey' as const],
          configured: true,
        },
      }]),
    })
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="kimi"
        serviceAccessGranted
        providerSummaries={{
          kimi: {
            provider: 'kimi',
            status: 'connected',
            authMode: 'apiKey',
            accountLabel: 'alice@example.com',
            connect: {
              modes: ['browserAssistedApiKey'],
              configured: true,
            },
          },
        }}
      />,
    )

    expect(await screen.findByText('a***e@example.com')).toBeTruthy()
    expect(screen.queryByText('alice@example.com')).toBeNull()
    expect(screen.getByText('已配置')).toBeTruthy()
    expect(screen.getByRole('button', { name: '更新 API Key' })).toBeTruthy()
  })

  it('presents an API-key credential as configured', async () => {
    const current = client({
      listProviders: vi.fn(async () => [{
        provider: 'deepseek' as const,
        status: 'connected' as const,
        authMode: 'apiKey',
        connect: {
          modes: ['browserAssistedApiKey' as const],
          configured: true,
        },
      }]),
    })

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="deepseek"
        serviceAccessGranted
        providerSummaries={{
          deepseek: {
            provider: 'deepseek',
            status: 'connected',
            authMode: 'apiKey',
            baseUrl: 'https://proxy.example/v1',
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

    fireEvent.click(screen.getByRole('button', { name: '更新 API Key' }))
    await waitFor(() => expect(screen.getByLabelText('DeepSeek Base URL 输入')).toHaveProperty(
      'value',
      'https://proxy.example/v1',
    ))
  })

  it('verifies a configured provider and merges discovered models into the catalog', async () => {
    const current = client({
      listModels: vi.fn(async () => [
        { id: 'deepseek-chat', provider: 'deepseek' as const, displayName: 'DeepSeek Chat' },
      ]),
      discoverModels: vi.fn(async (provider) => ({
        provider,
        credential: 'deepseek-credential',
        models: [
          { id: 'deepseek-chat', displayName: 'DeepSeek Chat' },
          { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' },
        ],
        observedAt: '2026-08-06T00:00:00.000Z',
        source: 'deepseek:/models',
      })),
    })

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="deepseek"
        serviceAccessGranted
        providerSummaries={{
          deepseek: {
            provider: 'deepseek',
            status: 'connected',
            authMode: 'apiKey',
            connect: {
              modes: ['browserAssistedApiKey'],
              configured: true,
            },
          },
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /验证/ }))

    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('deepseek'))
    expect(await screen.findByText('连接成功，已同步 2 个模型')).toBeTruthy()
    expect(screen.getByText('DeepSeek Reasoner')).toBeTruthy()
    expect(screen.getAllByText('DeepSeek Chat')).toHaveLength(1)
  })

  it('surfaces a failed verification through the provider error slot', async () => {
    const current = client({
      discoverModels: vi.fn(async () => {
        throw new Error('密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。')
      }),
    })

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="deepseek"
        serviceAccessGranted
        providerSummaries={{
          deepseek: {
            provider: 'deepseek',
            status: 'connected',
            authMode: 'apiKey',
            connect: {
              modes: ['browserAssistedApiKey'],
              configured: true,
            },
          },
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /验证/ }))

    expect(await screen.findByText('密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。')).toBeTruthy()
  })

  it('hides verification for providers without a credential', async () => {
    render(<AiConnectionsPanel client={client()} selectedProvider="openai" serviceAccessGranted />)

    expect(screen.queryByRole('button', { name: /验证/ })).toBeNull()
  })

  it('adds a custom model through the editor dialog and refreshes the catalog', async () => {
    const current = client({
      listModels: vi.fn(async () => [
        { id: 'ft-assistant', provider: 'openai' as const, displayName: 'Assistant', custom: true, inputModalities: ['image'], capabilities: ['tool_call'] },
      ]),
    })

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{
          openai: {
            provider: 'openai',
            status: 'connected',
            authMode: 'apiKey',
            connect: { modes: ['browserAssistedApiKey'], configured: true },
          },
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '添加模型' }))
    fireEvent.change(await screen.findByLabelText('模型 ID'), { target: { value: 'ft-assistant' } })
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Assistant' } })
    fireEvent.click(screen.getByRole('button', { name: '视觉识别' }))
    fireEvent.click(screen.getByRole('button', { name: '函数调用' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(current.saveProviderModel).toHaveBeenCalledWith('openai', {
      id: 'ft-assistant',
      displayName: 'Assistant',
      inputModalities: ['image'],
      capabilities: ['tool_call'],
    }))
    expect(await screen.findByText('Assistant')).toBeTruthy()
  })

  it('edits and deletes custom models from the catalog rows', async () => {
    const current = client({
      listModels: vi.fn(async () => [
        { id: 'ft-assistant', provider: 'openai' as const, displayName: 'Assistant', custom: true, inputModalities: ['image'] },
        { id: 'gpt-5', provider: 'openai' as const },
      ]),
    })

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerSummaries={{
          openai: {
            provider: 'openai',
            status: 'connected',
            authMode: 'apiKey',
            connect: { modes: ['browserAssistedApiKey'], configured: true },
          },
        }}
      />,
    )

    expect(await screen.findByText('Assistant')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删除 gpt-5' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '编辑 Assistant' }))
    expect(await screen.findByLabelText('模型 ID')).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Assistant v2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(current.saveProviderModel).toHaveBeenCalledWith('openai', {
      id: 'ft-assistant',
      displayName: 'Assistant v2',
      inputModalities: ['image'],
      capabilities: undefined,
    }))

    fireEvent.click(screen.getByRole('button', { name: '删除 Assistant' }))
    await waitFor(() => expect(current.deleteProviderModel).toHaveBeenCalledWith('openai', 'ft-assistant'))
  })

  it('opens browser-assisted key setup and submits the key without rendering it afterwards', async () => {
    const current = client()
    const openExternal = vi.fn()
    render(<AiConnectionsPanel client={current} openExternal={openExternal} serviceAccessGranted />)

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI API Key' }))
    await waitFor(() => expect(current.beginConnect).toHaveBeenCalledWith('openai', 'browserAssistedApiKey'))
    expect(openExternal).toHaveBeenCalledWith('https://provider.example/keys')

    fireEvent.change(screen.getByLabelText('OpenAI API Key 输入'), {
      target: { value: 'sk-provider-secret' },
    })
    fireEvent.change(screen.getByLabelText('OpenAI Base URL 输入'), {
      target: { value: 'https://proxy.example/v1' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenAI API Key' }))

    await waitFor(() => expect(current.completeApiKey).toHaveBeenCalledWith(
      'openai',
      expect.anything(),
      'sk-provider-secret',
      undefined,
      'https://proxy.example/v1',
    ))
    expect(screen.queryByDisplayValue('sk-provider-secret')).toBeNull()
    expect(screen.queryByText('sk-provider-secret')).toBeNull()
    expect(screen.getByText('已配置')).toBeTruthy()
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
    render(<AiConnectionsPanel client={current} selectedProvider="openai" serviceAccessGranted />)

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
    render(<AiConnectionsPanel client={current} selectedProvider="openai" serviceAccessGranted />)

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI API Key' }))

    expect(await screen.findByText('AI Connection request failed. Please try again.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/sk-|xpod_|apiKey|token|Bearer|json-secret/)
  })

  it('states unsupported quota honestly', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current} serviceAccessGranted />)

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
    render(<AiConnectionsPanel client={current} selectedProvider="openai" serviceAccessGranted />)

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

    render(<AiConnectionsPanel client={current} selectedProvider="openai" serviceAccessGranted />)

    expect(await screen.findByText('GPT-5.4')).toBeTruthy()
    expect(screen.queryByText('Claude Sonnet 4.5')).toBeNull()
    expect(current.listModels).toHaveBeenCalledOnce()
  })

  it('uses API-key setup for Kimi instead of a terminal device-code attempt', async () => {
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
      <AiConnectionsPanel
        client={current}
        selectedProvider="kimi"
        openExternal={openExternal}
        serviceAccessGranted
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Kimi API Key' }))

    expect(await screen.findByText('用户已取消连接')).toBeTruthy()
    expect(current.beginConnect).toHaveBeenCalledWith('kimi', 'browserAssistedApiKey')
    expect(openExternal).not.toHaveBeenCalled()
    expect(current.pollDevice).not.toHaveBeenCalled()
  })

  it('fails closed by default and does not call mutation APIs before service access is granted', () => {
    const current = client()

    render(<AiConnectionsPanel client={current} />)

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI API Key' }))

    expect(current.beginConnect).not.toHaveBeenCalled()
    expect(current.completeApiKey).not.toHaveBeenCalled()
  })
})
