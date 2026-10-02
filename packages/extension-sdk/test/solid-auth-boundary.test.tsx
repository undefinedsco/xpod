// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  StorageSelectionState,
  WebIdAuthState,
  WebIdLoginRouteDescriptor,
} from '@undefineds.co/solid-sdk'
import { SolidAuthBoundary } from '../src/react'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

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

const app = { name: 'Northstar' }
const webId = 'https://pod.example/alice/profile/card#me'
const children = <section aria-label="private workspace">Private workspace</section>
const remembered = { displayName: 'Alice', routeId: route.id }

function boundary(props: Partial<Parameters<typeof SolidAuthBoundary>[0]> & Pick<Parameters<typeof SolidAuthBoundary>[0], 'state'>) {
  return (
    <SolidAuthBoundary routes={[route]} onLogin={() => undefined} app={app} {...props}>
      {children}
    </SolidAuthBoundary>
  )
}

describe('SolidAuthBoundary presentation', () => {
  it('uses a modal dialog frame when the host selects modal presentation', () => {
    const onSurfaceClose = vi.fn()
    render(boundary({ state: { status: 'anonymous' }, surfaceMode: 'modal', onSurfaceClose }))

    const dialog = screen.getByRole('dialog', { name: 'Sign in' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.querySelector('[data-pod-sign-in-frame="page"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onSurfaceClose).toHaveBeenCalledTimes(1)
  })

  it('closes the modal on Escape', () => {
    const onSurfaceClose = vi.fn()
    render(boundary({ state: { status: 'anonymous' }, surfaceMode: 'modal', onSurfaceClose }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onSurfaceClose).toHaveBeenCalledTimes(1)
  })

  it('embeds without modal semantics or a second frame', () => {
    render(boundary({ state: { status: 'anonymous' }, surfaceMode: 'embedded' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelectorAll('[data-pod-sign-in-frame]').length).toBe(1)
    expect(document.querySelector('[data-pod-sign-in-frame="dialog"]')).not.toBeNull()
  })

  it('defaults to the page frame', () => {
    render(boundary({ state: { status: 'anonymous' } }))
    expect(document.querySelector('[data-pod-sign-in-frame="page"]')).not.toBeNull()
  })

  it('shows the application identity handed in by the host and assumes none otherwise', () => {
    const { rerender } = render(boundary({ state: { status: 'anonymous' }, app: { name: 'Northstar', icon: <svg data-testid="icon" /> } }))
    expect(document.querySelector('[data-pod-sign-in="source"]')?.textContent).toBe('Northstar')
    expect(screen.getByTestId('icon')).toBeTruthy()
    rerender(
      <SolidAuthBoundary state={{ status: 'anonymous' }} routes={[route]} onLogin={() => undefined}>
        {children}
      </SolidAuthBoundary>,
    )
    expect(document.querySelector('[data-pod-sign-in="source"]')?.textContent).toBe('Solid')
  })

  it('renders zh-CN wording and honors partial copy overrides', () => {
    const { rerender } = render(boundary({ state: { status: 'anonymous', remembered }, locale: 'zh-CN' }))
    expect(screen.getByRole('button', { name: '进入 Northstar' })).toBeTruthy()
    rerender(boundary({ state: { status: 'anonymous', remembered }, podSignInCopy: { enterApp: 'Launch {app}' } }))
    expect(screen.getByRole('button', { name: 'Launch Northstar' })).toBeTruthy()
  })
})

describe('SolidAuthBoundary WebID state mapping', () => {
  it('maps restoring to A0: only the source mark at first, then the remembered identity', () => {
    vi.useFakeTimers()
    render(boundary({ state: { status: 'restoring', remembered } }))
    expect(document.querySelector('[data-pod-sign-in-state="restoring"]')).not.toBeNull()
    expect(screen.queryByText('Alice')).toBeNull()
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByRole('heading', { level: 1, name: 'Alice' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'private workspace' })).toBeNull()
  })

  it('maps anonymous with a remembered identity to A1 and logs in on the remembered route', () => {
    const onLogin = vi.fn()
    const onSwitchAccount = vi.fn()
    render(boundary({
      state: { status: 'anonymous', remembered },
      routes: [route, secondaryRoute],
      onLogin,
      onSwitchAccount,
    }))
    expect(document.querySelector('[data-pod-sign-in-state="remembered"]')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Alice' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Northstar' }))
    expect(onLogin).toHaveBeenCalledWith(route.id)
    expect(onLogin).not.toHaveBeenCalledWith(route.identityProvider.url)
    fireEvent.click(screen.getByRole('button', { name: 'Use another account' }))
    expect(onSwitchAccount).toHaveBeenCalledTimes(1)
  })

  it('only offers "use another account" when the host can switch', () => {
    render(boundary({ state: { status: 'anonymous', remembered } }))
    expect(screen.queryByRole('button', { name: 'Use another account' })).toBeNull()
  })

  it('maps anonymous without a remembered identity to A3 whose primary button is the only route', () => {
    const onLogin = vi.fn()
    render(boundary({ state: { status: 'anonymous' }, onLogin }))
    expect(document.querySelector('[data-pod-sign-in-state="choose-service"]')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Local Xpod' }))
    expect(onLogin).toHaveBeenCalledWith(route.id)
    // No email or password form, and no free-form service entry, in the application.
    expect(screen.queryByLabelText(/password/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use another Solid account' })).toBeNull()
  })

  it('keeps every route reachable when several are offered', () => {
    const onLogin = vi.fn()
    render(boundary({ state: { status: 'anonymous' }, routes: [route, secondaryRoute], onLogin }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Cloud Xpod' }))
    expect(onLogin).toHaveBeenCalledWith(secondaryRoute.id)
  })

  it('maps connecting to the previous screen with a busy primary action', () => {
    render(boundary({ state: { status: 'connecting', route } }))
    const button = screen.getByRole('button', { name: 'Sign in with Local Xpod' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(document.querySelectorAll('[data-pod-sign-in-frame]').length).toBe(1)
  })

  it('keeps the remembered screen busy while connecting after it, and uses the first-visit screen otherwise', () => {
    const { rerender } = render(boundary({ state: { status: 'anonymous', remembered } }))
    expect(document.querySelector('[data-pod-sign-in-state="remembered"]')).not.toBeNull()
    rerender(boundary({ state: { status: 'connecting', route } }))
    expect(document.querySelector('[data-pod-sign-in-state="remembered"]')).not.toBeNull()
    expect(document.querySelector('[data-pod-sign-in-state="choose-service"]')).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Alice' })).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Open Northstar' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    cleanup()

    const first = render(boundary({ state: { status: 'anonymous' } }))
    first.rerender(boundary({ state: { status: 'connecting', route } }))
    expect(document.querySelector('[data-pod-sign-in-state="choose-service"]')).not.toBeNull()
  })

  it('renders only the active route while connecting across multiple routes', () => {
    const onCancel = vi.fn()
    render(boundary({
      state: { status: 'connecting', route: secondaryRoute },
      routes: [route, secondaryRoute],
      onCancel,
    }))
    expect(screen.getByRole('button', { name: 'Sign in with Cloud Xpod' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in with Local Xpod' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('only renders cancel while connecting and only when the host provides it', () => {
    const { rerender } = render(boundary({ state: { status: 'connecting', route } }))
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    rerender(boundary({ state: { status: 'anonymous' }, onCancel: () => undefined }))
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('maps expired to A2 and signs in again through the retry callback when present', () => {
    const onRetry = vi.fn()
    const onLogin = vi.fn()
    const { rerender } = render(boundary({ state: { status: 'expired', remembered }, onRetry, onLogin }))
    expect(document.querySelector('[data-pod-sign-in-state="expired"]')).not.toBeNull()
    expect(screen.getByText('Your sign-in expired. Please confirm again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(onRetry).toHaveBeenCalledWith(route.id)

    rerender(boundary({ state: { status: 'expired', remembered }, onLogin }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(onLogin).toHaveBeenCalledWith(route.id)
  })

  it('maps error to A1/A3 with a single C4 line, hiding technical detail unless developer mode', () => {
    const onRetry = vi.fn()
    const state: WebIdAuthState = { status: 'error', message: 'state_mismatch', retryRouteId: route.id }
    const { rerender } = render(boundary({ state, onRetry }))
    expect(document.querySelector('[data-pod-sign-in-state="choose-service"]')).not.toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('Sign-in did not finish. Please try again.')
    expect(screen.queryByText(/state_mismatch/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(onRetry).toHaveBeenCalledWith(route.id)

    rerender(boundary({ state: { ...state }, onRetry, developerMode: true }))
    expect(screen.getByRole('alert').querySelector('details')).not.toBeNull()
    expect(screen.getByText(/state_mismatch/)).toBeTruthy()

    rerender(boundary({ state: { status: 'error', message: 'x', retryRouteId: route.id }, onRetry, developerMode: false, locale: 'en' }))
    // With a remembered identity the error keeps the remembered screen (A1).
    rerender(boundary({ state: { status: 'error', message: 'x', retryRouteId: route.id }, onRetry }))
    expect(document.querySelector('[data-pod-sign-in-state]')).not.toBeNull()
  })

  it('signs in again from an error even without a retry callback', () => {
    const onLogin = vi.fn()
    render(boundary({ state: { status: 'error', message: 'boom', retryRouteId: route.id }, onLogin }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(onLogin).toHaveBeenCalledWith(route.id)
  })

  it('renders children for an authenticated session with ready or unspecified storage', () => {
    const { rerender } = render(boundary({ state: { status: 'authenticated', webId } }))
    expect(screen.getByRole('region', { name: 'private workspace' })).toBeTruthy()
    rerender(boundary({
      state: { status: 'authenticated', webId },
      storageState: { status: 'ready', selected: { storageUrl: 'https://pod.example/alice/', webId } },
    }))
    expect(screen.getByRole('region', { name: 'private workspace' })).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it.each([
    ['loading', { status: 'loading' } as StorageSelectionState],
    ['waiting_for_binding', { status: 'waiting_for_binding' } as StorageSelectionState],
    ['creating', { status: 'creating' } as StorageSelectionState],
  ])('shows A1 busy while storage is %s', (_name, storageState) => {
    render(boundary({ state: { status: 'authenticated', webId }, storageState }))
    expect(screen.queryByRole('region', { name: 'private workspace' })).toBeNull()
    const button = screen.getByRole('button', { name: 'Open Northstar' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('heading', { level: 1, name: 'alice' })).toBeTruthy()
  })
})

describe('SolidAuthBoundary storage states', () => {
  const authenticated: WebIdAuthState = { status: 'authenticated', webId }

  it('C1: a storage error becomes a retry line and button, tied to the storage route', () => {
    const onRetry = vi.fn()
    const storageState: StorageSelectionState = { status: 'error', message: 'Storage could not be prepared' }
    const { rerender } = render(boundary({
      state: authenticated,
      storageState,
      routes: [route, secondaryRoute],
      onRetry,
    }))
    expect(screen.getByRole('alert').textContent).toBe('Cannot reach Xpod right now. Please try again later.')
    expect(screen.queryByText(/could not be prepared/)).toBeNull()
    // Several routes and no storageRouteId: the retry route is not guessed.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).not.toHaveBeenCalled()

    rerender(boundary({
      state: authenticated,
      storageState,
      routes: [route, secondaryRoute],
      storageRouteId: secondaryRoute.id,
      onRetry,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith(secondaryRoute.id)
  })

  it('C4: a storage conflict offers "use another account" and keeps the message in developer mode only', () => {
    const onSwitchAccount = vi.fn()
    const storageState: StorageSelectionState = { status: 'conflict', message: 'Storage belongs to another WebID' }
    const { rerender } = render(boundary({ state: authenticated, storageState, onSwitchAccount }))
    expect(screen.getByRole('alert').textContent).toBe('Sign-in did not finish. Please try again.')
    expect(screen.queryByText(/belongs to another/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Use another account' }))
    expect(onSwitchAccount).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('region', { name: 'private workspace' })).toBeNull()

    rerender(boundary({ state: authenticated, storageState, onSwitchAccount, developerMode: true }))
    expect(screen.getByText(/belongs to another/)).toBeTruthy()
  })

  it('empty storage says there is no WebID and sends the user to create one', () => {
    const onCreateStorage = vi.fn()
    render(boundary({ state: authenticated, storageState: { status: 'empty' }, onCreateStorage }))
    expect(screen.getByRole('status').textContent).toBe('No WebID yet')
    fireEvent.click(screen.getByRole('button', { name: 'Create one' }))
    expect(onCreateStorage).toHaveBeenCalledTimes(1)
  })

  it('keeps the Pod chooser, restyled, and forwards selection and continuation', () => {
    const candidates = [
      { storageUrl: 'https://pod.example/alice/', webId, label: 'Alice storage' },
      { storageUrl: 'https://pod.example/shared/', webId, label: 'Shared storage' },
    ]
    const onSelectStorage = vi.fn()
    const onContinueStorage = vi.fn()
    render(boundary({
      state: authenticated,
      storageState: { status: 'selecting', candidates },
      onSelectStorage,
      onContinueStorage,
    }))

    expect(screen.getAllByRole('heading')).toHaveLength(1)
    expect(screen.getByText('Alice storage')).toBeTruthy()
    expect(screen.getByText('Shared storage')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Select Alice storage' }))
    expect(onSelectStorage).toHaveBeenCalledWith(candidates[0])
    expect(screen.getByRole('button', { name: 'Selected Alice storage' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinueStorage).toHaveBeenCalledWith(candidates[0])
  })

  it('lets hosts override the chooser wording through the legacy storage copy', () => {
    render(boundary({
      state: authenticated,
      storageState: { status: 'selecting', candidates: [{ storageUrl: 'https://pod.example/a/', webId, label: 'A' }] },
      copy: { storage: { title: 'Pick a vault', continueLabel: 'Go' } },
      onContinueStorage: () => undefined,
    }))
    expect(screen.getByRole('heading', { level: 1, name: 'Pick a vault' })).toBeTruthy()
  })

  it('never presents a second login flow: no state renders a request or redirect of its own', () => {
    const onLogin = vi.fn()
    const states: WebIdAuthState[] = [
      { status: 'restoring' },
      { status: 'anonymous' },
      { status: 'connecting', route },
      { status: 'expired', remembered },
      { status: 'error', message: 'Login failed', retryRouteId: route.id },
    ]
    for (const state of states) {
      const { unmount } = render(boundary({ state, onLogin }))
      expect(screen.queryByRole('region', { name: 'private workspace' })).toBeNull()
      unmount()
    }
    expect(onLogin).not.toHaveBeenCalled()
  })
})
