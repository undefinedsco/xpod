// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AccountCredentialsView,
  type AccountAuthState,
} from '@undefineds.co/shared-ui'
import {
  createSolidSessionRuntime,
  type SolidSessionRuntime,
  type WebIdAuthState,
} from '@undefineds.co/solid-sdk'
import { SolidAuthBoundary } from '../src/react'

afterEach(() => cleanup())

const copy = {
  productName: 'Account-only host',
  loginTitle: 'Sign in',
  registerTitle: 'Register',
  usernameLabel: 'Username',
  usernamePlaceholder: 'username',
  emailLabel: 'Email',
  emailPlaceholder: 'you@example.com',
  passwordLabel: 'Password',
  passwordPlaceholder: 'password',
  confirmationLabel: 'Confirm password',
  confirmationPlaceholder: 'password again',
  loginAction: 'Sign in',
  registerAction: 'Register',
  switchToRegister: 'Create an account',
  switchToLogin: 'Use an existing account',
  usernameChecking: 'Checking…',
  usernameAvailable: 'Available',
  usernameUnavailable: 'Unavailable',
  suggestionsLabel: 'Suggestions',
  mismatchError: 'Passwords do not match',
}

function AccountOnlyProfile({ state }: { state: AccountAuthState }) {
  return state.status === 'authenticated' ? <output>account-ready</output> : (
    <AccountCredentialsView
      mode={state.status === 'error' ? state.mode === 'register' ? 'register' : 'login' : state.mode}
      values={{ password: '' }}
      onChange={() => undefined}
      onSubmit={() => undefined}
      copy={copy}
    />
  )
}

function WebIdOnlyProfile({ session }: { session: SolidSessionRuntime }) {
  const state: WebIdAuthState = session.getSnapshot().status === 'authenticated'
    ? { status: 'authenticated', webId: session.getSnapshot().webId }
    : { status: 'anonymous' }
  return (
    <SolidAuthBoundary
      state={state}
      routes={[{
        id: 'identity-only',
        label: 'Identity only',
        identityProvider: { url: 'https://id.example', label: 'Identity provider' },
        availability: 'ready',
      }]}
      onLogin={() => undefined}
    >
      <output>webid-ready</output>
    </SolidAuthBoundary>
  )
}

function AccountAssistedProfile({
  account,
  webId,
}: {
  account: AccountAuthState
  webId: WebIdAuthState
}) {
  return (
    <div data-account-status={account.status} data-webid-status={webId.status}>
      <AccountOnlyProfile state={account} />
      <SolidAuthBoundary
        state={webId}
        routes={[{
          id: 'assisted',
          label: 'Account-assisted identity',
          identityProvider: { url: 'https://id.example', label: 'Identity provider' },
          availability: 'ready',
        }]}
        onLogin={() => undefined}
      >
        <output>assisted-ready</output>
      </SolidAuthBoundary>
    </div>
  )
}

describe('public authentication composition profiles', () => {
  it('supports Account-only consumers without a Solid runtime', () => {
    render(<AccountOnlyProfile state={{ status: 'anonymous', mode: 'login' }} />)
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy()
    expect(screen.queryByText('webid-ready')).toBeNull()
  })

  it('supports WebID-only consumers with a SolidSessionRuntime and no Account controller', () => {
    const session = createSolidSessionRuntime()
    render(<WebIdOnlyProfile session={session} />)
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
  })

  it('composes AccountAuthState and WebIdAuthState independently', () => {
    render(
      <AccountAssistedProfile
        account={{ status: 'authenticated' }}
        webId={{ status: 'anonymous' }}
      />,
    )
    expect(screen.getByText('account-ready')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
    expect(document.querySelector('[data-account-status="authenticated"]')).toBeTruthy()
    expect(document.querySelector('[data-webid-status="anonymous"]')).toBeTruthy()
  })
})
