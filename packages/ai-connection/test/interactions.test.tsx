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
