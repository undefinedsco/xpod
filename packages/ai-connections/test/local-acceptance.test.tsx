// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiClientConfigurationSection,
  AiConnectionsPanel,
  type AiClientConfigurationBridge,
  type AiConnectionsClient,
  type AiConnectionsClientId,
  type AiGatewayModel,
  type AiProviderCredentialSummary,
  type AiProviderOffering,
  type AiProviderSummary,
} from '../src'

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const XPOD_CLIENT_CREDENTIAL = 'sk-Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ='
const PROVIDER_SECRET = 'sk-real-provider-secret'

afterEach(cleanup)

describe('AI Connections local acceptance', () => {
  it('auto-syncs two Offering catalogs and keeps disjoint models after reload', async () => {
    const state = createAcceptanceState()
    const current = createAcceptanceClient(state)

    const { unmount } = render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="bailian"
        serviceAccessGranted
        providerProducts={{ bailian: state.provider() }}
      />,
    )

    fireEvent.click((await screen.findAllByRole('button', { name: '添加 API Key' }))[0]!)
    fireEvent.change(screen.getByLabelText('百炼 API Key 标签'), { target: { value: 'PAYG' } })
    fireEvent.change(screen.getByLabelText('百炼 API Key 输入'), { target: { value: PROVIDER_SECRET } })
    fireEvent.click(screen.getByRole('button', { name: '保存 百炼 API Key' }))

    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('bailian', {
      offeringId: 'pay-as-you-go',
      credentialId: 'cred-pay-as-you-go-1',
    }))
    expect(await screen.findByText('Qwen PAYG')).toBeTruthy()
    expect(document.body.textContent).not.toContain(PROVIDER_SECRET)

    fireEvent.click(screen.getAllByRole('button', { name: '添加 API Key' })[1]!)
    fireEvent.change(screen.getByLabelText('百炼 API Key 标签'), { target: { value: 'Token' } })
    fireEvent.change(screen.getByLabelText('百炼 API Key 输入'), { target: { value: PROVIDER_SECRET } })
    fireEvent.click(screen.getByRole('button', { name: '保存 百炼 API Key' }))

    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('bailian', {
      offeringId: 'token-plan',
      credentialId: 'cred-token-plan-1',
    }))
    expect(await screen.findByText('Qwen Token')).toBeTruthy()

    unmount()
    render(
      <AiConnectionsPanel
        client={createAcceptanceClient(state)}
        selectedProvider="bailian"
        serviceAccessGranted
        providerProducts={{ bailian: state.provider() }}
      />,
    )

    expect(await screen.findByText('Qwen PAYG')).toBeTruthy()
    expect(screen.getByText('Qwen Token')).toBeTruthy()
    expect(screen.queryByText('Qwen From Other Offering')).toBeNull()
  })

  it('removes an unavailable joined model and does not allow newly joining unavailable models', async () => {
    const state = createAcceptanceState()
    state.credentials.push(credential('cred-pay-as-you-go-1', 'pay-as-you-go', { label: 'PAYG' }))
    state.models.push(
      model('bailian-pay-as-you-go.ttl#qwen-active', 'qwen-active', 'Qwen Active', 'pay-as-you-go'),
      model('bailian-pay-as-you-go.ttl#qwen-retired-selected', 'qwen-retired-selected', 'Qwen Retired Selected', 'pay-as-you-go', 'unavailable'),
      model('bailian-pay-as-you-go.ttl#qwen-retired-new', 'qwen-retired-new', 'Qwen Retired New', 'pay-as-you-go', 'unavailable'),
    )
    state.selectedModelIds = [
      'bailian-pay-as-you-go.ttl#qwen-active',
      'bailian-pay-as-you-go.ttl#qwen-retired-selected',
    ]
    const current = createAcceptanceClient(state)

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="bailian"
        serviceAccessGranted
        providerProducts={{ bailian: state.provider() }}
      />,
    )

    expect(await screen.findByRole('checkbox', { name: '取消选择 Qwen Retired Selected' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '选择 Qwen Retired New' })).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('checkbox', { name: '取消选择 Qwen Retired Selected' }))

    await waitFor(() => expect(current.saveModelSelection).toHaveBeenLastCalledWith(
      'bailian',
      ['bailian-pay-as-you-go.ttl#qwen-active'],
    ))
  })

  it('persists disabling the last enabled credential and reloads as configured', async () => {
    const state = createAcceptanceState()
    state.credentials.push(credential('cred-pay-as-you-go-1', 'pay-as-you-go', { label: 'PAYG' }))
    const current = createAcceptanceClient(state)

    const { unmount } = render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="bailian"
        serviceAccessGranted
        providerProducts={{ bailian: state.provider() }}
        providerSummaries={{
          bailian: {
            provider: 'bailian',
            status: 'connected',
            authMode: 'apiKey',
            connect: { modes: ['browserAssistedApiKey'], configured: true },
          },
        }}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '停用 PAYG' }))

    await waitFor(() => expect(current.updateProviderCredential).toHaveBeenCalledWith('bailian', 'cred-pay-as-you-go-1', {
      expectedVersion: 1,
      enabled: false,
    }))

    unmount()
    expect(state.provider().status).toBe('configured')
    render(
      <AiConnectionsPanel
        client={createAcceptanceClient(state)}
        selectedProvider="bailian"
        serviceAccessGranted
        providerProducts={{ bailian: state.provider() }}
        providerSummaries={{
          bailian: {
            provider: 'bailian',
            status: 'disconnected',
            authMode: 'apiKey',
            connect: { modes: ['browserAssistedApiKey'], configured: true },
          },
        }}
      />,
    )

    expect(await screen.findByText('已配置')).toBeTruthy()
    expect(screen.getByRole('button', { name: '启用 PAYG' })).toBeTruthy()
  })

  it('refreshes quota with the active credential Offering identity', async () => {
    const state = createAcceptanceState()
    state.credentials.push(
      credential('cred-pay-as-you-go-1', 'pay-as-you-go', { label: 'PAYG', priority: 20 }),
      credential('cred-token-plan-1', 'token-plan', { label: 'Token', priority: 10 }),
    )
    const current = createAcceptanceClient(state)

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="bailian"
        serviceAccessGranted
        providerProducts={{ bailian: state.provider() }}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '刷新 百炼 额度' }))

    await waitFor(() => expect(current.quota).toHaveBeenCalledWith('bailian', true, {
      offeringId: 'token-plan',
      credentialId: 'cred-token-plan-1',
      credentialIri: 'cred-token-plan-1',
    }))
  })

  it('projects only Xpod client credentials into all supported coding clients', async () => {
    const applied: Array<{ client: AiConnectionsClientId; gatewayKey: string }> = []
    const bridge: AiClientConfigurationBridge = {
      inspect: vi.fn(async () => ({ status: 'notConfigured' })),
      plan: vi.fn(async ({ client }) => ({
        planId: `plan-${client}`,
        client,
        changes: [{ target: `${client}.config`, action: 'createOrUpdate', backup: true }],
      })),
      apply: vi.fn(async (input) => {
        applied.push({ client: input.client, gatewayKey: input.gatewayKey })
        return { applied: true }
      }),
      verify: vi.fn(async () => ({ status: 'configured' })),
      restore: vi.fn(async () => ({ status: 'notConfigured' })),
    }

    render(
      <AiClientConfigurationSection
        bridge={bridge}
        endpoint="https://pod.example/alice/api/ai"
        createGatewayKey={async () => ({
          gatewayKey: XPOD_CLIENT_CREDENTIAL,
          revoke: vi.fn(async () => undefined),
        })}
      />,
    )

    for (const [index, label] of ['Codex', 'Claude Code', 'Pi', 'CodeBuddy'].entries()) {
      fireEvent.click((await screen.findAllByRole('button', { name: '配置' }))[index]!)
      fireEvent.click(await screen.findByRole('button', { name: `应用 ${label} 配置` }))
      await waitFor(() => expect(bridge.verify).toHaveBeenCalledWith({
        client: clientIdForLabel(label),
        planId: `plan-${clientIdForLabel(label)}`,
      }))
    }

    await waitFor(() => expect(applied).toHaveLength(4))
    expect(applied.map((item) => item.gatewayKey)).toEqual([
      XPOD_CLIENT_CREDENTIAL,
      XPOD_CLIENT_CREDENTIAL,
      XPOD_CLIENT_CREDENTIAL,
      XPOD_CLIENT_CREDENTIAL,
    ])
    expect(document.body.textContent).not.toContain(PROVIDER_SECRET)
  })
})

function createAcceptanceState() {
  const state = {
    credentials: [] as AiProviderCredentialSummary[],
    models: [] as AiGatewayModel[],
    selectedModelIds: [] as string[],
    provider(): AiProviderSummary {
      return {
        id: 'bailian',
        name: '百炼',
        offerings: OFFERINGS,
        credentials: this.credentials.map((item) => ({ ...item })),
        selectedModels: this.models
          .filter((item) => item.resourceId && this.selectedModelIds.includes(item.resourceId))
          .map((item) => ({ ...item })),
        status: this.credentials.length === 0
          ? 'unconfigured'
          : this.credentials.some((item) => item.enabled)
            ? 'available'
            : 'configured',
      }
    },
  }
  return state
}

function createAcceptanceClient(state: ReturnType<typeof createAcceptanceState>): AiConnectionsClient {
  return {
    webId: WEB_ID,
    apiBase: 'https://pod.example',
    getServiceAccess: vi.fn(async () => ({ status: 'granted' })),
    listProviders: vi.fn(async () => [state.provider()]),
    listModels: vi.fn(async () => state.models.map((item) => ({ ...item }))),
    listGatewayKeys: vi.fn(async () => []),
    createGatewayKey: vi.fn(async (input) => ({
      plaintext: XPOD_CLIENT_CREDENTIAL,
      record: {
        id: `client-${input.name ?? 'default'}`,
        owner: WEB_ID,
        scopes: [],
        createdAt: '2026-08-09T00:00:00.000Z',
        name: input.name,
      },
    })),
    revokeGatewayKey: vi.fn(async () => undefined),
    beginConnect: vi.fn(),
    connectStatus: vi.fn(),
    completeApiKey: vi.fn(),
    pollDevice: vi.fn(),
    disconnect: vi.fn(),
    createApiKeyCredential: vi.fn(async (_provider, input) => {
      const offeringId = state.credentials.length === 0 ? 'pay-as-you-go' : 'token-plan'
      const created = credential(`cred-${offeringId}-1`, offeringId, {
        label: input.label,
        priority: input.priority ?? 10,
      })
      state.credentials.push(created)
      return { ...created }
    }),
    updateProviderCredential: vi.fn(async (_provider, credentialId, input) => {
      const index = state.credentials.findIndex((item) => item.id === credentialId)
      if (index < 0) throw new Error('credential_not_found')
      const current = state.credentials[index]!
      if (current.version !== input.expectedVersion) throw new Error('credential_version_conflict')
      const updated = {
        ...current,
        ...input,
        version: current.version + 1,
      }
      state.credentials[index] = updated
      return { ...updated }
    }),
    deleteProviderCredential: vi.fn(async (_provider, credentialId) => {
      const index = state.credentials.findIndex((item) => item.id === credentialId)
      if (index < 0) return undefined
      const [removed] = state.credentials.splice(index, 1)
      return removed
    }),
    testProviderCredential: vi.fn(async () => ({ status: 'ok' })),
    quota: vi.fn(async () => ({
      credential: 'cred-pay-as-you-go-1',
      status: 'unsupported',
      windows: [],
      observedAt: '2026-08-09T00:00:00.000Z',
      expiresAt: '2026-08-09T00:05:00.000Z',
      source: 'bailian:console',
    })),
    quotaFromSecret: vi.fn(),
    discoverModels: vi.fn(async (_provider, input) => {
      const offeringId = input?.offeringId ?? 'pay-as-you-go'
      const discovered = offeringId === 'token-plan'
        ? [model('bailian-token-plan.ttl#qwen-token', 'qwen-token', 'Qwen Token', 'token-plan')]
        : [model('bailian-pay-as-you-go.ttl#qwen-payg', 'qwen-payg', 'Qwen PAYG', 'pay-as-you-go')]
      const existing = state.models.filter((item) => item.offeringId !== offeringId)
      state.models = [...existing, ...discovered]
      return {
        provider: 'bailian',
        credential: input?.credentialId ?? `cred-${offeringId}-1`,
        models: discovered.map((item) => ({ id: item.id, displayName: item.displayName })),
        observedAt: '2026-08-09T00:00:00.000Z',
        source: `bailian:${offeringId}:/models`,
      }
    }),
    saveModelSelection: vi.fn(async (_provider, modelIds) => {
      state.selectedModelIds = [...modelIds]
    }),
    saveProviderModel: vi.fn(async () => []),
    deleteProviderModel: vi.fn(async () => []),
  } as AiConnectionsClient
}

const OFFERINGS: AiProviderOffering[] = [
  {
    id: 'pay-as-you-go',
    label: 'Pay as You Go',
    kind: 'payAsYouGo',
    authModes: ['apiKey'],
    productLabel: '百炼 API 平台',
    endpoints: [{ protocol: 'chatCompletions', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }],
    quota: { strategy: 'console', url: 'https://bailian.console.aliyun.com/' },
  },
  {
    id: 'token-plan',
    label: 'Token Plan Personal',
    kind: 'tokenPlan',
    authModes: ['apiKey'],
    productLabel: '百炼 Token Plan',
    endpoints: [{ protocol: 'chatCompletions', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }],
    quota: { strategy: 'subscription', url: 'https://bailian.console.aliyun.com/' },
  },
]

function credential(
  id: string,
  offeringId: string,
  overrides: Partial<AiProviderCredentialSummary> = {},
): AiProviderCredentialSummary {
  return {
    id,
    provider: 'bailian',
    offeringId,
    authMode: 'apiKey',
    label: overrides.label ?? offeringId,
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 10,
    health: overrides.health ?? 'healthy',
    maskedHint: 'sk-...cret',
    version: overrides.version ?? 1,
  }
}

function model(
  resourceId: string,
  id: string,
  displayName: string,
  offeringId: string,
  availability: AiGatewayModel['availability'] = 'available',
): AiGatewayModel {
  return {
    id,
    resourceId,
    provider: 'bailian',
    offeringId,
    displayName,
    availability,
  }
}

function clientIdForLabel(label: string): AiConnectionsClientId {
  if (label === 'Claude Code') return 'claude-code'
  if (label === 'Pi') return 'pi'
  if (label === 'CodeBuddy') return 'codebuddy'
  return 'codex'
}
