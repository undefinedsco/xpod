// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebIdLoginEntryView, WebIdLoginRouteView } from '../src'

afterEach(() => cleanup())

const route = {
  id: 'northstar-local',
  label: 'Northstar workspace',
  description: 'Use the workspace identity',
  badge: { label: 'Ready', tone: 'success' as const },
  availability: 'ready' as const,
  identityProvider: { label: 'Identity', url: 'https://identity.example.test' },
}

const copy = {
  title: 'Choose a workspace identity',
  startLabel: 'Continue',
  restoringLabel: 'Restoring your session…',
  connectingLabel: 'Connecting…',
  rememberedLabel: 'Remembered identity',
  expiredTitle: 'Session expired',
  retryLabel: 'Try again',
  cancelLabel: 'Cancel',
  storageConflictTitle: 'Storage conflict',
  failureTitle: 'Could not sign in',
  switchAccountLabel: 'Switch account',
}

describe('WebIdLoginRouteView', () => {
  it('passes an opaque route id to the action and renders remembered/restoring states', () => {
    const onStart = vi.fn()
    const onSwitchAccount = vi.fn()
    const { rerender } = render(
      <WebIdLoginRouteView route={route} state={{ status: 'anonymous' }} copy={copy} onStart={onStart} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onStart).toHaveBeenCalledWith('northstar-local')
    expect(onStart).not.toHaveBeenCalledWith(route.identityProvider.url)

    rerender(
      <WebIdLoginRouteView
        route={route}
        state={{ status: 'remembered', remembered: { displayName: 'Ari', routeId: route.id } }}
        copy={copy}
        onStart={onStart}
        onSwitchAccount={onSwitchAccount}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }))
    expect(onStart).toHaveBeenCalledWith(route.id)
    expect(onSwitchAccount).toHaveBeenCalledTimes(1)

    rerender(
      <WebIdLoginRouteView
        route={route}
        state={{ status: 'restoring', remembered: { displayName: 'Ari', routeId: route.id } }}
        copy={copy}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('Restoring your session…')
    expect(screen.getByText('Ari')).toBeTruthy()
  })

  it('wires connecting, expired, retry, cancel, storage conflict and failure actions', () => {
    const onRetry = vi.fn()
    const onCancel = vi.fn()
    const { rerender } = render(
      <WebIdLoginRouteView
        route={route}
        state={{ status: 'connecting' }}
        copy={copy}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('Connecting…')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)

    rerender(
      <WebIdLoginRouteView route={route} state={{ status: 'expired' }} copy={copy} onRetry={onRetry} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledWith(route.id)

    rerender(
      <WebIdLoginRouteView
        route={route}
        state={{ status: 'cancel', message: 'Authorization was cancelled' }}
        copy={copy}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('Authorization was cancelled')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(2)

    rerender(
      <WebIdLoginRouteView
        route={route}
        state={{ status: 'storage-conflict', message: 'Identity and storage do not match' }}
        copy={copy}
        onRetry={onRetry}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('Identity and storage do not match')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()

    rerender(
      <WebIdLoginRouteView route={route} state={{ status: 'failure', message: 'Network unavailable' }} copy={copy} onRetry={onRetry} />,
    )
    expect(screen.getByRole('alert').textContent).toContain('Network unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledWith(route.id)
  })

  it('bounds long route content', () => {
    render(
      <WebIdLoginRouteView
        route={{ ...route, description: 'Long route copy '.repeat(300) }}
        state={{ status: 'anonymous' }}
        copy={{ ...copy, description: 'Long surface copy '.repeat(300) }}
        onStart={() => undefined}
      />,
    )
    expect(screen.getByTestId('webid-login-route-scroll').classList.contains('overflow-y-auto')).toBe(true)
  })
})

describe('WebIdLoginEntryView', () => {
  it('does not add a second heading when the supplied brand owns the title', () => {
    render(
      <WebIdLoginEntryView
        logo={<h1>Northstar</h1>}
        copy={{ title: '', startLabel: 'Sign in', pendingLabel: 'Connecting…' }}
        onStart={() => undefined}
      />,
    )
    expect(screen.getAllByRole('heading')).toHaveLength(1)
    expect(screen.getByRole('heading').textContent).toBe('Northstar')
  })

  it('renders one frame-free WebID action with no provider or credential controls', () => {
    const onStart = vi.fn()
    const { container } = render(
      <WebIdLoginEntryView
        logo={<span aria-hidden="true">mark</span>}
        copy={{
          title: 'Northstar',
          description: 'Use your WebID',
          startLabel: 'Sign in with WebID',
          pendingLabel: 'Connecting…',
        }}
        onStart={onStart}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with WebID' }))
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="webid-login-entry"]')).toBeTruthy()
    expect(container.querySelector('[data-slot="card"], input, select')).toBeNull()
    expect(screen.queryByText(/provider|issuer/i)).toBeNull()
  })

  it('disables duplicate submission while connecting', () => {
    render(
      <WebIdLoginEntryView
        copy={{
          title: 'Northstar',
          startLabel: 'Sign in with WebID',
          pendingLabel: 'Connecting…',
        }}
        pending
        onStart={() => undefined}
      />,
    )

    expect(screen.getByRole('button', { name: 'Connecting…' }).hasAttribute('disabled')).toBe(true)
  })
})
