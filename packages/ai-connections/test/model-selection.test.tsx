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
  it('shows selected and unavailable picked models while keeping upstream models selectable', async () => {
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
    expect(screen.getByText('不可用')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '选择 GPT-5 Mini' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '取消选择 Legacy Model' })).toBeTruthy()

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 GPT-5 Mini' }))
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

  it('labels manual models separately from upstream models', async () => {
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

    expect(await screen.findByText('上游')).toBeTruthy()
    expect(screen.getByText('手工')).toBeTruthy()
  })
})
