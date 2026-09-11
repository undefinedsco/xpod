// @vitest-environment jsdom
import './setup-jsdom'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiConnectionsPanel,
  type AiConnectionsClient,
  type AiGatewayModel,
  type AiProviderSummary,
} from '../src'

const WEB_ID = 'https://pod.example/alice/profile/card#me'

afterEach(cleanup)

function deferredSave() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function client(models: AiGatewayModel[]): AiConnectionsClient {
  return {
    webId: WEB_ID,
    apiBase: 'https://pod.example',
    getServiceAccess: vi.fn(async () => ({ status: 'granted' })),
    listProviders: vi.fn(async () => []),
    listModels: vi.fn(async () => models),
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
  it('reloads the Gateway projection after a model selection is persisted', async () => {
    const current = client([{ id: 'gpt-5', provider: 'openai', displayName: 'GPT-5' }])
    current.listGatewayModels = vi.fn(async () => [])
    render(<AiConnectionsPanel client={current} selectedProvider="openai" providerProducts={{ openai: openAiProduct([]) }} />)
    const select = await screen.findByRole('checkbox', { name: '选择 GPT-5' })
    expect(current.listGatewayModels).toHaveBeenCalledTimes(1)
    fireEvent.click(select)
    await waitFor(() => expect(current.saveModelSelection).toHaveBeenCalledWith('openai', [{ id: 'gpt-5' }]))
    await waitFor(() => expect(current.listGatewayModels).toHaveBeenCalledTimes(2))
  })

  it('keeps the model search control in the header before the first catalog sync', async () => {
    render(<AiConnectionsPanel
      client={client([])}
      selectedProvider="openai"
      providerProducts={{ openai: openAiProduct([]) }}
    />)

    expect(await screen.findByPlaceholderText('搜索模型...')).toBeTruthy()
    expect(screen.getByText('暂无可用模型')).toBeTruthy()
  })

  it('shows a model sync failure in the empty catalog instead of a silent placeholder', async () => {
    const current = client([])
    current.discoverModels = vi.fn(async () => {
      throw new Error('密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。')
    })
    render(<AiConnectionsPanel
      client={current}
      selectedProvider="custom"
      providerProducts={{
        custom: {
          id: 'custom',
          name: 'Custom',
          offerings: [{ id: 'openai-compatible', label: 'OpenAI compatible', authModes: ['apiKey'] }],
          credentials: [{
            id: 'custom-one',
            offeringId: 'openai-compatible',
            authMode: 'apiKey',
            label: 'timicc',
            enabled: true,
            priority: 10,
            health: 'healthy',
            version: 1,
          }],
          selectedModels: [],
          status: 'available',
        },
      }}
    />)

    fireEvent.click(await screen.findByRole('button', { name: '同步模型' }))
    expect(await screen.findAllByText('密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。')).toHaveLength(1)
    expect(screen.queryByText('暂无可用模型')).toBeNull()
  })

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
      [{ id: 'gpt-5' }, { id: 'legacy-model' }, { id: 'gpt-5-mini' }],
    ))

    fireEvent.change(screen.getByPlaceholderText('搜索模型...'), { target: { value: '' } })
    await waitFor(() => expect(onModelSelectionChange).toHaveBeenLastCalledWith(
      'openai',
      ['gpt-5', 'legacy-model', 'gpt-5-mini'],
    ))
    await waitFor(() => expect(current.saveModelSelection).toHaveBeenCalledWith(
      'openai',
      [{ id: 'gpt-5' }, { id: 'legacy-model' }, { id: 'gpt-5-mini' }],
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

    fireEvent.click(screen.getByRole('button', { name: '新建 API Key 连接' }))
    const form = within(screen.getByRole('dialog').querySelector('[data-create-offering="offering-b"]') as HTMLElement)
    fireEvent.change(form.getByLabelText('OpenAI API Key 输入'), {
      target: { value: 'sk-offering-b' },
    })
    fireEvent.click(form.getByRole('button', { name: '保存 OpenAI API Key' }))

    await waitFor(() => expect(current.createApiKeyCredential).toHaveBeenCalledWith('openai', {
      offeringId: 'offering-b',
      apiKey: 'sk-offering-b',
      label: undefined,
      baseUrl: undefined,
      priority: 10,
    }))
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
        displayName: 'Offering A Model',
        availability: 'available',
      },
      {
        id: 'shared-model',
        provider: 'openai',
        offeringId: 'offering-b',
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
    expect(screen.queryByText('Offering B Model')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '新建 API Key 连接' }))
    const form = within(screen.getByRole('dialog').querySelector('[data-create-offering="offering-b"]') as HTMLElement)
    fireEvent.change(form.getByLabelText('OpenAI API Key 输入'), {
      target: { value: 'sk-offering-b' },
    })
    fireEvent.click(form.getByRole('button', { name: '保存 OpenAI API Key' }))

    await waitFor(() => expect(current.createApiKeyCredential).toHaveBeenCalledWith('openai', {
      offeringId: 'offering-b',
      apiKey: 'sk-offering-b',
      label: undefined,
      baseUrl: undefined,
      priority: 10,
    }))
    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('openai', {
      offeringId: 'offering-b',
      credentialId: 'openai-offering-b-credential',
    }))
    fireEvent.change(screen.getByPlaceholderText('搜索模型...'), { target: { value: 'refreshed' } })
    expect(await screen.findByText('Offering A Model')).toBeTruthy()
    expect(screen.queryByText('Offering B Refreshed')).toBeNull()
    expect(screen.queryByText('Offering B Model')).toBeNull()
    expect(screen.queryByText('已失效')).toBeNull()
  })

  it('selects and clears all offering resource references from one same-id model row', async () => {
    const current = client([
      {
        id: 'shared-model',
        provider: 'openai',
        offeringId: 'offering-a',
        resourceId: 'models.ttl#a',
        displayName: 'Offering A Model',
        availability: 'available',
      },
      {
        id: 'shared-model',
        provider: 'openai',
        offeringId: 'offering-b',
        resourceId: 'models.ttl#b',
        displayName: 'Offering B Model',
        availability: 'available',
      },
    ])

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        providerProducts={{
          openai: {
            ...openAiProduct([]),
            offerings: [
              { id: 'offering-a', label: 'Offering A', authModes: ['apiKey'] },
              { id: 'offering-b', label: 'Offering B', authModes: ['apiKey'] },
            ],
          },
        }}
      />,
    )

    expect(await screen.findAllByRole('checkbox', { name: '选择 Offering A Model' })).toHaveLength(1)
    expect(screen.queryByText('Offering B Model')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Offering A Model' }))
    await waitFor(() => expect(current.saveModelSelection).toHaveBeenLastCalledWith('openai', [
      { id: 'shared-model', offeringId: 'offering-a', resourceId: 'models.ttl#a' },
      { id: 'shared-model', offeringId: 'offering-b', resourceId: 'models.ttl#b' },
    ]))
    expect(await screen.findByText('共 1 · 已加入 1 · 已失效 0')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '取消选择 Offering A Model' }))
    await waitFor(() => expect(current.saveModelSelection).toHaveBeenLastCalledWith('openai', []))
  })

  it('shows one same-id model without offering badges and keeps the public model id for copying', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const current = client([
      {
        id: 'shared-model',
        provider: 'openai',
        offeringId: 'api-platform',
        displayName: 'Shared Model',
        availability: 'available',
      },
      {
        id: 'shared-model',
        provider: 'openai',
        offeringId: 'token-plan',
        displayName: 'Shared Model',
        availability: 'available',
      },
    ])

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        providerProducts={{
          openai: {
            ...openAiProduct([]),
            offerings: [
              { id: 'api-platform', kind: 'api-platform', authModes: ['apiKey'] },
              { id: 'token-plan', kind: 'token-plan', authModes: ['apiKey'] },
            ],
          },
        }}
      />,
    )

    expect(await screen.findAllByRole('checkbox', { name: '选择 Shared Model' })).toHaveLength(1)
    expect(screen.queryByLabelText('模型来源：API 平台')).toBeNull()
    expect(screen.queryByLabelText('模型来源：Token 套餐')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('搜索模型...'), { target: { value: 'shared' } })
    expect(screen.getAllByRole('checkbox', { name: '选择 Shared Model' })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '复制 Shared Model ID' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('shared-model'))
  })

  it('keeps a partially selected shared model joined and selects only available routes', async () => {
    const routes: AiGatewayModel[] = [
      { id: 'shared', provider: 'openai', offeringId: 'api', resourceId: 'models.ttl#api', displayName: 'Shared', availability: 'unavailable' },
      { id: 'shared', provider: 'openai', offeringId: 'subscription', resourceId: 'models.ttl#subscription', displayName: 'Shared', availability: 'available' },
    ]
    const current = client(routes)
    render(<AiConnectionsPanel client={current} selectedProvider="openai"
      providerProducts={{ openai: openAiProduct([routes[0]!]) }} />)
    expect(await screen.findByRole('checkbox', { name: '取消选择 Shared' })).toBeTruthy()
    expect(screen.getByText('共 1 · 已加入 1 · 已失效 0')).toBeTruthy()
    expect(current.saveModelSelection).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: '取消选择 Shared' }))
    await waitFor(() => expect(current.saveModelSelection).toHaveBeenLastCalledWith('openai', []))
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前结果' }))
    await waitFor(() => expect(current.saveModelSelection).toHaveBeenLastCalledWith('openai', [
      { id: 'shared', offeringId: 'subscription', resourceId: 'models.ttl#subscription' },
    ]))
  })

  it('explains automatic saving and confirms persistence only after the request succeeds', async () => {
    const save = deferredSave()
    const current = client([{ id: 'gpt-5', provider: 'openai', displayName: 'GPT-5' }])
    current.saveModelSelection = vi.fn(() => save.promise)
    render(<AiConnectionsPanel client={current} selectedProvider="openai"
      providerProducts={{ openai: openAiProduct([]) }} />)

    const model = await screen.findByRole('checkbox', { name: '选择 GPT-5' })
    expect(screen.getByText('选择后自动保存').getAttribute('role')).toBe('status')
    expect(current.saveModelSelection).not.toHaveBeenCalled()

    fireEvent.click(model)
    expect(screen.getByText('保存中…').getAttribute('role')).toBe('status')
    expect(screen.queryByText('已保存')).toBeNull()
    expect(screen.getByRole('checkbox', { name: '取消选择 GPT-5' })).toBeTruthy()
    await waitFor(() => expect(current.saveModelSelection).toHaveBeenCalledWith('openai', [{ id: 'gpt-5' }]))

    await act(async () => save.resolve())
    expect(screen.getByText('已保存').getAttribute('role')).toBe('status')
    expect(screen.queryByText('保存中…')).toBeNull()
  })

  it('keeps the newest selection saving when an earlier request completes', async () => {
    const first = deferredSave()
    const second = deferredSave()
    const current = client([
      { id: 'gpt-5', provider: 'openai', displayName: 'GPT-5' },
      { id: 'gpt-5-mini', provider: 'openai', displayName: 'GPT-5 Mini' },
    ])
    current.saveModelSelection = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    render(<AiConnectionsPanel client={current} selectedProvider="openai"
      providerProducts={{ openai: openAiProduct([]) }} />)

    fireEvent.click(await screen.findByRole('checkbox', { name: '选择 GPT-5' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 GPT-5 Mini' }))
    expect(screen.getByText('保存中…')).toBeTruthy()

    await act(async () => first.resolve())
    await waitFor(() => expect(current.saveModelSelection).toHaveBeenCalledTimes(2))
    expect(screen.getByText('保存中…')).toBeTruthy()
    expect(screen.queryByText('已保存')).toBeNull()
    expect(current.saveModelSelection).toHaveBeenLastCalledWith('openai', [
      { id: 'gpt-5' }, { id: 'gpt-5-mini' },
    ])

    await act(async () => second.resolve())
    expect(screen.getByText('已保存')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '取消选择 GPT-5' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '取消选择 GPT-5 Mini' })).toBeTruthy()
  })

  it('rolls selection back and reports an error when Pod selection persistence fails', async () => {
    const save = deferredSave()
    const saveModelSelection = vi.fn(() => save.promise)
    const current = client([
      { id: 'gpt-5', provider: 'openai', displayName: 'GPT-5' },
      { id: 'gpt-5-mini', provider: 'openai', displayName: 'GPT-5 Mini' },
    ])
    current.saveModelSelection = saveModelSelection
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        providerProducts={{
          openai: openAiProduct([
            { id: 'gpt-5', provider: 'openai', displayName: 'GPT-5', availability: 'available' },
          ]),
        }}
      />,
    )

    const mini = await screen.findByRole('checkbox', { name: '选择 GPT-5 Mini' })
    fireEvent.click(mini)
    expect(screen.getByText('保存中…')).toBeTruthy()

    await waitFor(() => expect(saveModelSelection).toHaveBeenCalledWith('openai', [
      { id: 'gpt-5' },
      { id: 'gpt-5-mini' },
    ]))
    await act(async () => save.reject(new Error('selection_write_failed')))
    expect(screen.getByText('保存失败，请重试').getAttribute('role')).toBe('status')
    expect(screen.queryByText('已保存')).toBeNull()
    expect(await screen.findByText('请求未完成。请确认 Xpod 正在运行且登录仍有效，然后重试。')).toBeTruthy()
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
        providerProducts={{ openai: openAiProduct([]) }}
      />,
    )

    expect(await screen.findByText('GPT-5')).toBeTruthy()
    expect(screen.queryByText('上游')).toBeNull()
    expect(screen.getByText('手工')).toBeTruthy()
  })
})
