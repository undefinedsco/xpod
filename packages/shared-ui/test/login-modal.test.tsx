// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LoginModal, type LoginModalProps } from '../src'

afterEach(() => cleanup())

function createProps(overrides: Partial<LoginModalProps> = {}): LoginModalProps {
  return {
    view: 'default',
    state: 'idle',
    error: null,
    storedAccount: null,
    storageConflict: null,
    hasRestorableSession: false,
    providers: [
      {
        id: 'cloud',
        url: 'https://cloud.example.com',
        label: 'Cloud',
        source: 'cloud',
        isDefault: true,
        oidcProvider: {
          kind: 'cloud',
          url: 'https://cloud.example.com',
          label: 'Cloud',
        },
        storageProvider: {
          kind: 'cloud',
          url: 'https://cloud.example.com',
          label: 'Cloud',
        },
      },
      {
        id: 'local',
        url: 'http://localhost:5737',
        label: 'Local',
        source: 'local',
        oidcProvider: {
          kind: 'cloud',
          url: 'https://id.undefineds.co',
          label: 'Cloud',
        },
        storageProvider: {
          kind: 'local',
          url: 'http://localhost:5737',
          label: 'Local',
        },
        runtime: {
          kind: 'local-pod',
          status: 'missing',
          canStart: true,
          canCreate: true,
        },
      },
    ],
    onBackFromLocal: vi.fn(),
    onContinueLocalLogin: vi.fn(),
    onSaveLocalTunnelToken: vi.fn(),
    onTestLocalConnectivity: vi.fn(),
    onSwitchAccount: vi.fn(),
    onContinueStoredAccount: vi.fn(),
    onConnect: vi.fn(),
    onCancelConnecting: vi.fn(),
    onAddProvider: vi.fn(),
    onClearError: vi.fn(),
    onDismissStorageConflict: vi.fn(),
    onOpenCurrentSpacePodSetup: vi.fn(),
    localLoginStatus: { active: false, message: null },
    authWindowStatus: { open: false, reason: 'dismissed', ready: false },
    connectingProvider: null,
    localOnboarding: null,
    localProviderSource: 'local',
    ...overrides,
  }
}

describe('LoginModal source parity', () => {
  it('keeps the exact LinX branch order', () => {
    const authenticated = render(<LoginModal {...createProps({ state: 'authenticated' })} />)
    expect(authenticated.container.innerHTML).toBe('')
    authenticated.unmount()

    render(
      <LoginModal
        {...createProps({
          state: 'authenticated',
          storedAccount: {
            displayName: 'Ganlu',
            issuerUrl: 'https://id.undefineds.co',
          },
          storageConflict: {
            expectedStorageUrl: 'https://node.example/ganlu/',
            actualStorageUrl: 'https://old.example/ganlu/',
            storageProviderUrl: 'https://node.example/',
            managementUrl: 'https://node.example/.account/account/',
          },
        })}
      />,
    )

    expect(screen.getByText('空间不匹配')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /继续使用|重新登录/ })).toBeNull()
  })

  it('preserves the source restoring DOM and classes', () => {
    render(<LoginModal {...createProps({ state: 'restoring' })} />)
    const card = document.querySelector('[data-login-card-size="compact"]')
    expect(card.firstElementChild?.className).toBe('flex-1 flex flex-col items-center justify-center p-6 gap-4')
    expect(screen.getByText('正在恢复登录状态...')).toBeTruthy()
  })

  it('preserves the remembered-account branch and actions', () => {
    const onContinueStoredAccount = vi.fn()
    const onSwitchAccount = vi.fn()
    render(
      <LoginModal
        {...createProps({
          storedAccount: {
            displayName: 'Ganlu',
            issuerUrl: 'https://id.undefineds.co',
            issuerLabel: 'undefineds',
            storageProviderUrl: 'https://cloud.undefineds.co/ganlu/',
            storageProviderLabel: 'Cloud',
          },
          hasRestorableSession: true,
          onContinueStoredAccount,
          onSwitchAccount,
        })}
      />,
    )

    expect(screen.getByText('undefineds · Cloud')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续使用 Ganlu' }))
    fireEvent.click(screen.getByRole('button', { name: '切换账号' }))
    expect(onContinueStoredAccount).toHaveBeenCalledTimes(1)
    expect(onSwitchAccount).toHaveBeenCalledTimes(1)
  })

  it('preserves the source first-login storage choice and provider branch', () => {
    const onConnect = vi.fn()
    const { container } = render(<LoginModal {...createProps({ onConnect })} />)

    // Product-neutral default brand: hosts inject their own brand via props.
    expect(screen.getByText('登录')).toBeTruthy()
    expect(screen.queryByText('LinX')).toBeNull()
    expect(screen.queryByText(/undefineds/)).toBeNull()
    expect(screen.getByText('数据保存位置')).toBeTruthy()
    expect(screen.getByRole('button', { name: '云端' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '本机' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '其他账号供应商' })).toBeTruthy()
    expect(container.querySelector('[data-login-card-size="compact"]')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(onConnect).toHaveBeenCalledWith('cloud')
  })

  it('keeps local onboarding ahead of a remembered account when enabled', () => {
    render(
      <LoginModal
        {...createProps({
          view: 'local',
          storedAccount: { displayName: 'Ganlu', issuerUrl: 'https://id.undefineds.co' },
          localProviderSource: 'standalone',
          localOnboarding: {
            state: 'ready',
            spaceKind: 'standalone',
            localUrl: 'http://127.0.0.1:3000/',
            baseUrl: 'http://127.0.0.1:3000/',
            publicUrl: null,
            tunnel: null,
            connectivity: null,
            capabilities: null,
            cloudIdentityUrl: null,
            provisionCode: null,
            provisionUrl: null,
            nodeId: null,
            message: null,
            errorCode: null,
            canRetry: true,
            canOpenSettings: true,
          },
        })}
      />,
    )

    expect(screen.getByText('独立空间 已准备好')).toBeTruthy()
    expect(screen.getByText('http://127.0.0.1:3000/')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重新登录 Ganlu' })).toBeNull()
  })

  it('preserves the source-migrated LinX error normalization', () => {
    render(
      <LoginModal
        {...createProps({
          error: '读取 WebID Profile 失败：HTTP 401',
        })}
      />,
    )

    expect(screen.getByText('登录状态已失效。请重新登录。')).toBeTruthy()
    expect(screen.queryByText(/WebID Profile|HTTP 401/)).toBeNull()
  })

})
