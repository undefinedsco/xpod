// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiConnectionsPanel,
  type AiConnectionsClient,
  type AiGatewayModel,
  type AiProviderSummary,
} from '../src'

const WEB_ID = 'https://pod.example/alice/profile/card#me'

afterEach(cleanup)

function client(models: AiGatewayModel[]): AiConnectionsClient {
  return {
    webId: WEB_ID,
    apiBase: 'https://pod.example',
    getServiceAccess: vi.fn(async () => ({ status: 'granted' })),
    listProviders: vi.fn(async () => []),
    listModels: vi.fn(async () => models),
    listGatewayKeys: vi.fn(async () => []),
    createGatewayKey: vi.fn(),
    revokeGatewayKey: vi.fn(),
    beginConnect: vi.fn(),
    connectStatus: vi.fn(),
    completeApiKey: vi.fn(),
    pollDevice: vi.fn(),
    disconnect: vi.fn(),
    discoverModels: vi.fn(),
    saveModelSelection: vi.fn(async () => undefined),
    saveProviderModel: vi.fn(),
    deleteProviderModel: vi.fn(),
    createApiKeyCredential: vi.fn(),
    updateProviderCredential: vi.fn(),
    deleteProviderCredential: vi.fn(),
    testProviderCredential: vi.fn(),
    quota: vi.fn(),
  } as unknown as AiConnectionsClient
}

function openAiProduct(selectedModels: AiGatewayModel[]): AiProviderSummary {
  return {
    id: 'openai',
    name: 'OpenAI',
    offerings: [],
    credentials: [],
    selectedModels,
    status: 'available',
  }
}

describe('AI Connection model selection', () => {
  it('shows joined and expired models with a filtered tri-state select-all control', async () => {
    const onModelSelectionChange = vi.fn()
    const current = client([
      { id: 'gpt-5', provider: 'openai', displayName: 'GPT-5' },
      { id: 'gpt-5-mini', provider: 'openai', displayName: 'GPT-5 Mini' },
    ])
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerProducts={{
          openai: openAiProduct([
            { id: 'gpt-5', provider: 'openai', displayName: 'GPT-5', availability: 'available' },
            { id: 'legacy-model', provider: 'openai', displayName: 'Legacy Model', availability: 'unavailable' },
          ]),
        }}
        onModelSelectionChange={onModelSelectionChange}
      />,
    )

    expect(await screen.findByRole('checkbox', { name: '取消选择 GPT-5' })).toBeTruthy()
    expect(screen.getByText('已失效')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '选择 GPT-5 Mini' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '取消选择 Legacy Model' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '取消选择 Legacy Model' })).not.toHaveProperty('disabled', true)
    expect(screen.queryByText('已选择')).toBeNull()
    expect(screen.queryByText('未选择')).toBeNull()
    expect(screen.queryByText('上游')).toBeNull()
    const selectAll = screen.getByRole('checkbox', { name: '全选当前结果' })
    expect(selectAll.getAttribute('aria-checked')).toBe('mixed')

    fireEvent.change(screen.getByPlaceholderText('搜索模型...'), { target: { value: 'mini' } })
    expect(selectAll.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(selectAll)
    await waitFor(() => expect(current.saveModelSelection).toHaveBeenCalledWith(
      'openai',
      ['gpt-5', 'legacy-model', 'gpt-5-mini'],
    ))

    fireEvent.change(screen.getByPlaceholderText('搜索模型...'), { target: { value: '' } })
    await waitFor(() => expect(onModelSelectionChange).toHaveBeenLastCalledWith(
      'openai',
      ['gpt-5', 'legacy-model', 'gpt-5-mini'],
    ))
    await waitFor(() => expect(current.saveModelSelection).toHaveBeenCalledWith(
      'openai',
      ['gpt-5', 'legacy-model', 'gpt-5-mini'],
    ))

    fireEvent.click(screen.getByRole('checkbox', { name: '取消选择 GPT-5' }))
    await waitFor(() => expect(onModelSelectionChange).toHaveBeenLastCalledWith(
      'openai',
      ['legacy-model', 'gpt-5-mini'],
    ))
  })

  it('disables unavailable catalog models that were never joined and shows counts plus refresh state', async () => {
    render(<AiConnectionsPanel
      client={client([
        { id: 'gpt-5', provider: 'openai', availability: 'available' },
        { id: 'retired', provider: 'openai', availability: 'unavailable' },
      ])}
      selectedProvider="openai"
      serviceAccessGranted
      providerSummaries={{
        openai: {
          provider: 'openai',
          status: 'connected',
          authMode: 'apiKey',
          connect: { modes: ['apiKey'], configured: true },
        },
      }}
      providerProducts={{ openai: openAiProduct([{ id: 'gpt-5', provider: 'openai', availability: 'available' }]) }}
    />)

    expect(await screen.findByText('共 2 · 已加入 1 · 已失效 1')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '选择 retired' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '刷新模型' })).toBeTruthy()
  })

  it('stacks the model header controls at narrow widths instead of squeezing the title', async () => {
    render(<AiConnectionsPanel
      client={client([{ id: 'gpt-5', provider: 'openai', availability: 'available' }])}
      selectedProvider="openai"
      serviceAccessGranted
      providerProducts={{ openai: openAiProduct([]) }}
    />)

    const header = await screen.findByTestId('provider-models-header')
    const actions = screen.getByTestId('provider-models-actions')
    const search = screen.getByPlaceholderText('搜索模型...')
    const panel = screen.getByTestId('ai-connections-panel')

    expect(header.className).toContain('flex-col')
    expect(header.className).toContain('sm:flex-row')
    expect(actions.className).toContain('w-full')
    expect(actions.className).toContain('sm:w-auto')
    expect(search.className).toContain('w-full')
    expect(search.className).toContain('sm:w-[232px]')
    expect(panel.className).toContain('px-4')
    expect(panel.className).toContain('sm:px-8')
  })

  it('keeps a selected model visible as unavailable when refresh no longer returns it', async () => {
    const current = client([
      { id: 'fixture-gpt', provider: 'openai', displayName: 'Fixture GPT', availability: 'available' },
    ])
    current.discoverModels = vi.fn(async () => ({
      provider: 'openai',
      credential: 'openai-fixture',
      models: [],
      observedAt: '2026-08-10T00:00:00.000Z',
      source: 'openai:/v1/models',
    }))

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
            connect: { modes: ['apiKey'], configured: true },
          },
        }}
        providerProducts={{
          openai: openAiProduct([
            { id: 'fixture-gpt', provider: 'openai', displayName: 'Fixture GPT', availability: 'available' },
          ]),
        }}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '刷新模型' }))

    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('openai'))
    expect(await screen.findByText('Fixture GPT')).toBeTruthy()
    expect(screen.getByText('已失效')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '取消选择 Fixture GPT' })).toBeTruthy()
  })

  it('limits credential refresh staleness to its offering and preserves custom models', async () => {
    const current = client([
      {
        id: 'offering-a-model',
        provider: 'openai',
        offeringId: 'offering-a',
        displayName: 'Offering A Model',
        availability: 'available',
      },
      {
        id: 'offering-b-model',
        provider: 'openai',
        offeringId: 'offering-b',
        displayName: 'Offering B Model',
        availability: 'available',
      },
      {
        id: 'custom-model',
        provider: 'openai',
        displayName: 'Custom Model',
        custom: true,
        availability: 'available',
      },
    ])
    current.createApiKeyCredential = vi.fn(async (_provider, input) => ({
      id: 'openai-offering-b-credential',
      provider: 'openai',
      offeringId: input.offeringId,
      authMode: 'apiKey',
      enabled: true,
      priority: 20,
      health: 'healthy',
      version: 1,
    }))
    current.discoverModels = vi.fn(async () => ({
      provider: 'openai',
      credential: 'openai-offering-b-credential',
      models: [],
      observedAt: '2026-08-10T00:00:00.000Z',
      source: 'openai:/v1/models',
    }))

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerProducts={{
          openai: {
            ...openAiProduct([]),
            offerings: [
              { id: 'offering-a', label: 'Offering A', authModes: ['apiKey'] },
              { id: 'offering-b', label: 'Offering B', authModes: ['apiKey'] },
            ],
            credentials: [{
              id: 'openai-offering-a-credential',
              provider: 'openai',
              offeringId: 'offering-a',
              authMode: 'apiKey',
              enabled: true,
              priority: 10,
              health: 'healthy',
              version: 1,
            }],
            status: 'available',
          },
        }}
      />,
    )

    expect(await screen.findByText('Offering A Model')).toBeTruthy()
    expect(screen.getByText('Offering B Model')).toBeTruthy()
    expect(screen.getByText('Custom Model')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: '添加 API Key' })[1])
    fireEvent.change(screen.getByLabelText('OpenAI API Key 标签'), {
      target: { value: 'Offering B key' },
    })
    fireEvent.change(screen.getByLabelText('OpenAI API Key 输入'), {
      target: { value: 'sk-offering-b' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenAI API Key' }))

    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('openai', {
      offeringId: 'offering-b',
      credentialId: 'openai-offering-b-credential',
    }))
    await waitFor(() => expect(screen.getAllByText('已失效')).toHaveLength(1))
    expect(screen.getByText('Offering A Model')).toBeTruthy()
    expect(screen.getByText('Custom Model')).toBeTruthy()
  })

  it('refreshes only the matching offering when providers reuse the same model id', async () => {
    const current = client([
      {
        id: 'shared-model',
        provider: 'openai',
        offeringId: 'offering-a',
        resourceId: 'urn:model:offering-a:shared-model',
        displayName: 'Offering A Model',
        availability: 'available',
      },
      {
        id: 'shared-model',
        provider: 'openai',
        offeringId: 'offering-b',
        resourceId: 'urn:model:offering-b:shared-model',
        displayName: 'Offering B Model',
        availability: 'available',
      },
    ])
    current.createApiKeyCredential = vi.fn(async (_provider, input) => ({
      id: 'openai-offering-b-credential',
      provider: 'openai',
      offeringId: input.offeringId,
      authMode: 'apiKey',
      enabled: true,
      priority: 20,
      health: 'healthy',
      version: 1,
    }))
    current.discoverModels = vi.fn(async () => ({
      provider: 'openai',
      credential: 'openai-offering-b-credential',
      models: [{ id: 'shared-model', displayName: 'Offering B Refreshed' }],
      observedAt: '2026-08-10T00:00:00.000Z',
      source: 'openai:/v1/models',
    }))

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerProducts={{
          openai: {
            ...openAiProduct([]),
            offerings: [
              { id: 'offering-a', label: 'Offering A', authModes: ['apiKey'] },
              { id: 'offering-b', label: 'Offering B', authModes: ['apiKey'] },
            ],
            credentials: [{
              id: 'openai-offering-a-credential',
              provider: 'openai',
              offeringId: 'offering-a',
              authMode: 'apiKey',
              enabled: true,
              priority: 10,
              health: 'healthy',
              version: 1,
            }],
            status: 'available',
          },
        }}
      />,
    )

    expect(await screen.findByText('Offering A Model')).toBeTruthy()
    expect(screen.getByText('Offering B Model')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: '添加 API Key' })[1])
    fireEvent.change(screen.getByLabelText('OpenAI API Key 标签'), {
      target: { value: 'Offering B key' },
    })
    fireEvent.change(screen.getByLabelText('OpenAI API Key 输入'), {
      target: { value: 'sk-offering-b' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenAI API Key' }))

    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('openai', {
      offeringId: 'offering-b',
      credentialId: 'openai-offering-b-credential',
    }))
    expect(await screen.findByText('Offering B Refreshed')).toBeTruthy()
    expect(screen.getByText('Offering A Model')).toBeTruthy()
    expect(screen.queryByText('Offering B Model')).toBeNull()
    expect(screen.queryByText('已失效')).toBeNull()
  })

  it('rolls selection back and reports an error when Pod selection persistence fails', async () => {
    const saveModelSelection = vi.fn(async () => {
      throw new Error('selection_write_failed')
    })
    const current = client([
      { id: 'gpt-5', provider: 'openai', displayName: 'GPT-5' },
      { id: 'gpt-5-mini', provider: 'openai', displayName: 'GPT-5 Mini' },
    ])
    current.saveModelSelection = saveModelSelection
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
        providerProducts={{
          openai: openAiProduct([
            { id: 'gpt-5', provider: 'openai', displayName: 'GPT-5', availability: 'available' },
          ]),
        }}
      />,
    )

    const mini = await screen.findByRole('checkbox', { name: '选择 GPT-5 Mini' })
    fireEvent.click(mini)

    await waitFor(() => expect(saveModelSelection).toHaveBeenCalledWith('openai', ['gpt-5', 'gpt-5-mini']))
    expect(await screen.findByText('AI Connection request failed. Please try again.')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '选择 GPT-5 Mini' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '取消选择 GPT-5' })).toBeTruthy()
  })

  it('labels only manually added models', async () => {
    render(
      <AiConnectionsPanel
        client={client([
          { id: 'gpt-5', provider: 'openai', displayName: 'GPT-5' },
          { id: 'my-endpoint', provider: 'openai', displayName: 'My Endpoint', custom: true },
        ])}
        selectedProvider="openai"
        serviceAccessGranted
        providerProducts={{ openai: openAiProduct([]) }}
      />,
    )

    expect(await screen.findByText('GPT-5')).toBeTruthy()
    expect(screen.queryByText('上游')).toBeNull()
    expect(screen.getByText('手工')).toBeTruthy()
  })
})
