// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginView } from '../src'

afterEach(() => cleanup())

const provider = {
  id: 'current-origin',
  label: 'Example',
  url: 'https://example.test',
  source: 'cloud' as const,
  oidcProvider: { kind: 'cloud' as const, url: 'https://example.test', label: 'Example' },
  storageProvider: { kind: 'cloud' as const, url: 'https://example.test', label: 'Example' },
}

function actions() {
  return {
    continue: vi.fn(),
    switchAccount: vi.fn(),
    connect: vi.fn(),
    cancel: vi.fn(),
    dismissError: vi.fn(),
  }
}

describe('controlled LoginView', () => {
  it('renders no application auth surface after the host authenticates', () => {
    const { container } = render(
      <LoginView state="authenticated" identity={null} providers={[provider]} ariaLabel="Sign in" actions={actions()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders a remembered identity and delegates all behavior to host callbacks', () => {
    const callbacks = actions()
    render(
      <LoginView
        state="idle"
        identity={{ displayName: 'Alice', email: 'alice@example.test' }}
        providers={[provider]}
        ariaLabel="Sign in"
        actions={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '重新登录 Alice' }))
    fireEvent.click(screen.getByRole('button', { name: '切换账号' }))
    expect(callbacks.continue).toHaveBeenCalledTimes(1)
    expect(callbacks.switchAccount).toHaveBeenCalledTimes(1)
  })

  it('uses a single full-window surface without exposing provider management by default', () => {
    render(
      <LoginView
        state="idle"
        identity={null}
        providers={[provider]}
        brand={<span>Xpod</span>}
        host="window"
        ariaLabel="Sign in to Xpod"
        actions={actions()}
      />,
    )
    const surface = screen.getByRole('dialog', { name: 'Sign in to Xpod' })
    expect(surface.getAttribute('data-auth-view')).toBe('controlled')
    expect(screen.queryByText('更多选项')).toBeNull()
    expect(screen.queryByText('添加 Provider')).toBeNull()
  })
})
