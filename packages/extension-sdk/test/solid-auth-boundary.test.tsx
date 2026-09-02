// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  StorageSelectionState,
  WebIdAuthState,
  WebIdLoginRouteDescriptor,
} from '@undefineds.co/solid-sdk'
import { SolidAuthBoundary } from '../src/react'

afterEach(() => cleanup())

const route: WebIdLoginRouteDescriptor = {
  id: 'local',
  label: 'Local Xpod',
  description: 'Use the current host identity',
  identityProvider: { url: 'https://xpod.example/.account', label: 'Current host' },
  availability: 'ready',
}

const secondaryRoute: WebIdLoginRouteDescriptor = {
  id: 'cloud',
  label: 'Cloud Xpod',
  identityProvider: { url: 'https://cloud.example/.account', label: 'Cloud host' },
  availability: 'ready',
}

const children = <section aria-label="private workspace">Private workspace</section>

describe('SolidAuthBoundary', () => {
  it('uses the public modal AuthSurface when the host selects modal presentation', () => {
    const onSurfaceClose = vi.fn()
    render(
      <SolidAuthBoundary
        state={{ status: 'anonymous' }}
        routes={[route]}
        onLogin={() => undefined}
        surfaceMode="modal"
        onSurfaceClose={onSurfaceClose}
      >
        {children}
      </SolidAuthBoundary>,
    )

    expect(screen.getByRole('dialog', { name: 'Connect to Solid' })).toBeTruthy()
    expect(screen.getByTestId('auth-surface-modal')).toBeTruthy()
    expect(screen.queryByTestId('auth-surface-page')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onSurfaceClose).toHaveBeenCalledTimes(1)
  })

  it('uses an embedded AuthSurface without modal semantics or a nested surface', () => {
    render(
      <SolidAuthBoundary
        state={{ status: 'anonymous' }}
        routes={[route]}
        onLogin={() => undefined}
        surfaceMode="embedded"
      >
        {children}
      </SolidAuthBoundary>,
    )

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('auth-surface-embedded')).toBeTruthy()
    expect(screen.queryByTestId('auth-surface-modal')).toBeNull()
    expect(screen.queryByTestId('auth-surface-page')).toBeNull()
    expect(document.querySelectorAll('[data-auth-surface-mode]').length).toBe(1)
    expect(document.querySelector('[data-auth-boundary="surface"]')).toBeNull()
  })

  it.each([
    ['restoring', { status: 'restoring' } satisfies WebIdAuthState],
    ['connecting', { status: 'connecting', route } satisfies WebIdAuthState],
    ['error', { status: 'error', message: 'Login failed', retryRouteId: route.id } satisfies WebIdAuthState],
  ] as const)('keeps %s presentation inside one public AuthSurface', (_name, state) => {
    render(
      <SolidAuthBoundary
        state={state}
        routes={[route]}
        onLogin={() => undefined}
        surfaceMode="embedded"
      >
        {children}
      </SolidAuthBoundary>,
    )

    expect(screen.getByTestId('auth-surface-embedded')).toBeTruthy()
    expect(document.querySelectorAll('[data-auth-surface-mode]').length).toBe(1)
  })

  it.each([
    ['restoring', { status: 'restoring' } satisfies WebIdAuthState],
    ['anonymous', { status: 'anonymous' } satisfies WebIdAuthState],
    ['connecting', { status: 'connecting', route } satisfies WebIdAuthState],
    ['authenticated', { status: 'authenticated', webId: 'https://pod.example/alice#me' } satisfies WebIdAuthState],
    ['expired', { status: 'expired', remembered: { displayName: 'Alice', routeId: route.id } } satisfies WebIdAuthState],
    ['error', { status: 'error', message: 'Login failed', retryRouteId: route.id } satisfies WebIdAuthState],
  ] as const)('maps the %s WebID state without creating a second auth flow', (_name, state) => {
    const onLogin = vi.fn()
    const { rerender } = render(
      <SolidAuthBoundary state={state} routes={[route]} onLogin={onLogin}>
        {children}
      </SolidAuthBoundary>,
    )

    if (state.status === 'authenticated') {
      expect(screen.getByRole('region', { name: 'private workspace' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    } else {
      expect(screen.queryByRole('region', { name: 'private workspace' })).toBeNull()
    }

    rerender(
      <SolidAuthBoundary state={{ status: 'anonymous' }} routes={[route]} onLogin={onLogin}>
        {children}
      </SolidAuthBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onLogin).toHaveBeenCalledWith(route.id)
    expect(onLogin).not.toHaveBeenCalledWith(route.identityProvider.url)
  })

  it('only renders retry, cancel, and account-switch actions when host callbacks exist', () => {
    const onRetry = vi.fn()
    const onCancel = vi.fn()
    const onSwitchAccount = vi.fn()
    const { rerender } = render(
      <SolidAuthBoundary
        state={{ status: 'error', message: 'Try again', retryRouteId: route.id }}
        routes={[route]}
        onLogin={() => undefined}
      >
        {children}
      </SolidAuthBoundary>,
    )
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()

    rerender(
      <SolidAuthBoundary
        state={{ status: 'error', message: 'Try again', retryRouteId: route.id }}
        routes={[route]}
        onLogin={() => undefined}
        onRetry={onRetry}
      >
        {children}
      </SolidAuthBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledWith(route.id)

    rerender(
      <SolidAuthBoundary state={{ status: 'connecting', route }} routes={[route]} onLogin={() => undefined}>
        {children}
      </SolidAuthBoundary>,
    )
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    rerender(
      <SolidAuthBoundary
        state={{ status: 'connecting', route }}
        routes={[route]}
        onLogin={() => undefined}
        onCancel={onCancel}
      >
        {children}
      </SolidAuthBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)

    rerender(
      <SolidAuthBoundary
        state={{ status: 'anonymous', remembered: { displayName: 'Alice', routeId: route.id } }}
        routes={[route]}
        onLogin={() => undefined}
        onSwitchAccount={onSwitchAccount}
      >
        {children}
      </SolidAuthBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }))
    expect(onSwitchAccount).toHaveBeenCalledTimes(1)
  })

  it('renders only the active route while connecting across multiple routes', () => {
    const onCancel = vi.fn()
    render(
      <SolidAuthBoundary
        state={{ status: 'connecting', route: secondaryRoute }}
        routes={[route, secondaryRoute]}
        onLogin={() => undefined}
        onCancel={onCancel}
      >
        {children}
      </SolidAuthBoundary>,
    )

    expect(screen.getByText(secondaryRoute.label)).toBeTruthy()
    expect(screen.queryByText(route.label)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('exposes host storage callbacks for empty, creating, and ready states', () => {
    const onCreateStorage = vi.fn()
    const onContinueStorage = vi.fn()
    const { rerender } = render(
      <SolidAuthBoundary
        state={{ status: 'authenticated', webId: 'https://pod.example/alice#me' }}
        storageState={{ status: 'empty' }}
        routes={[route]}
        onLogin={() => undefined}
        onCreateStorage={onCreateStorage}
        onContinueStorage={onContinueStorage}
      >
        {children}
      </SolidAuthBoundary>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create storage' }))
    expect(onCreateStorage).toHaveBeenCalledTimes(1)

    rerender(
      <SolidAuthBoundary
        state={{ status: 'authenticated', webId: 'https://pod.example/alice#me' }}
        storageState={{ status: 'creating' }}
        routes={[route]}
        onLogin={() => undefined}
        onCreateStorage={onCreateStorage}
        onContinueStorage={onContinueStorage}
      >
        {children}
      </SolidAuthBoundary>,
    )
    expect(screen.queryByRole('button', { name: 'Create storage' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()

    rerender(
      <SolidAuthBoundary
        state={{ status: 'authenticated', webId: 'https://pod.example/alice#me' }}
        storageState={{
          status: 'ready',
          selected: { storageUrl: 'https://pod.example/alice/', webId: 'https://pod.example/alice#me' },
        }}
        routes={[route]}
        onLogin={() => undefined}
        onCreateStorage={onCreateStorage}
        onContinueStorage={onContinueStorage}
      >
        {children}
      </SolidAuthBoundary>,
    )
    expect(screen.getByRole('region', { name: 'private workspace' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(onContinueStorage).not.toHaveBeenCalled()
  })

  it('renders selecting candidates and forwards selection and continuation bindings', () => {
    const candidates = [
      { storageUrl: 'https://pod.example/alice/', webId: 'https://pod.example/alice#me', label: 'Alice storage' },
      { storageUrl: 'https://pod.example/shared/', webId: 'https://pod.example/alice#me', label: 'Shared storage' },
    ]
    const onSelectStorage = vi.fn()
    const onContinueStorage = vi.fn()
    render(
      <SolidAuthBoundary
        state={{ status: 'authenticated', webId: 'https://pod.example/alice#me' }}
        storageState={{ status: 'selecting', candidates }}
        routes={[route]}
        onLogin={() => undefined}
        onSelectStorage={onSelectStorage}
        onContinueStorage={onContinueStorage}
      >
        {children}
      </SolidAuthBoundary>,
    )

    expect(screen.getByText('Alice storage')).toBeTruthy()
    expect(screen.getByText('Shared storage')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Select Alice storage' }))
    expect(onSelectStorage).toHaveBeenCalledWith(candidates[0])
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinueStorage).toHaveBeenCalledWith(candidates[0])
  })

  it('does not guess a storage conflict retry route when multiple routes are available', () => {
    const storageState: StorageSelectionState = { status: 'conflict', message: 'Storage belongs to another WebID' }
    const { rerender } = render(
      <SolidAuthBoundary
        state={{ status: 'authenticated', webId: 'https://pod.example/alice#me' }}
        storageState={storageState}
        routes={[route, secondaryRoute]}
        onLogin={() => undefined}
      >
        {children}
      </SolidAuthBoundary>,
    )
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain(storageState.message)

    const onRetry = vi.fn()
    rerender(
      <SolidAuthBoundary
        state={{ status: 'authenticated', webId: 'https://pod.example/alice#me' }}
        storageState={storageState}
        routes={[route, secondaryRoute]}
        onLogin={() => undefined}
        onRetry={onRetry}
      >
        {children}
      </SolidAuthBoundary>,
    )
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(onRetry).not.toHaveBeenCalled()

    rerender(
      <SolidAuthBoundary
        state={{ status: 'authenticated', webId: 'https://pod.example/alice#me' }}
        storageState={storageState}
        routes={[route, secondaryRoute]}
        storageRouteId={secondaryRoute.id}
        onLogin={() => undefined}
        onRetry={onRetry}
      >
        {children}
      </SolidAuthBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledWith(secondaryRoute.id)

    expect(screen.queryByRole('region', { name: 'private workspace' })).toBeNull()

    rerender(
      <SolidAuthBoundary
        state={{ status: 'authenticated', webId: 'https://pod.example/alice#me' }}
        storageState={{ status: 'error', message: 'Storage could not be prepared' }}
        routes={[route, secondaryRoute]}
        onLogin={() => undefined}
        onRetry={onRetry}
      >
        {children}
      </SolidAuthBoundary>,
    )
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
