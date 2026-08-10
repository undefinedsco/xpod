// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebIdLoginRouteView } from '../src'

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
}

describe('WebIdLoginRouteView', () => {
  it('passes an opaque route id to the action and renders remembered/restoring states', () => {
    const onStart = vi.fn()
    const { rerender } = render(
      <WebIdLoginRouteView route={route} state={{ status: 'anonymous' }} copy={copy} onStart={onStart} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onStart).toHaveBeenCalledWith('northstar-local')
    expect(onStart).not.toHaveBeenCalledWith(route.identityProvider.url)

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
        state={{ status: 'storage-conflict', message: 'Identity and storage do not match' }}
        copy={copy}
        onRetry={onRetry}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('Identity and storage do not match')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()

    rerender(
      <WebIdLoginRouteView route={route} state={{ status: 'failure', message: 'Network unavailable' }} copy={copy} />,
    )
    expect(screen.getByRole('alert').textContent).toContain('Network unavailable')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
