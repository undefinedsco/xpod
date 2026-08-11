// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AccountCredentialsSurface,
  AccountCredentialsView,
  AccountLoginMethodListView,
  PasswordRecoveryView,
  PasswordResetView,
  type AccountCredentialsCopy,
} from '../src'

afterEach(() => cleanup())

const credentialsCopy: AccountCredentialsCopy = {
  productName: 'Northstar',
  loginTitle: 'Sign in to Northstar',
  registerTitle: 'Create a Northstar account',
  usernameLabel: 'Username',
  usernamePlaceholder: 'Choose a username',
  emailLabel: 'Email',
  emailPlaceholder: 'you@example.test',
  passwordLabel: 'Password',
  passwordPlaceholder: 'Enter your password',
  confirmationLabel: 'Confirm password',
  confirmationPlaceholder: 'Enter it again',
  loginAction: 'Sign in',
  registerAction: 'Create account',
  switchToRegister: 'Create an account',
  switchToLogin: 'Back to sign in',
  usernameChecking: 'Checking availability…',
  usernameAvailable: 'Username is available',
  usernameUnavailable: 'Username is unavailable',
  suggestionsLabel: 'Suggestions',
  mismatchError: 'Passwords do not match',
}

function CredentialsHarness({ mode = 'login' as const }: { mode?: 'login' | 'register' }) {
  const onChange = vi.fn()
  const onSubmit = vi.fn()
  return (
    <AccountCredentialsView
      mode={mode}
      values={{ username: '', email: '', password: 'secret', confirmation: 'different' }}
      onChange={onChange}
      onSubmit={onSubmit}
      usernameAvailability="available"
      usernameSuggestions={['northstar-user']}
      errors={{ form: 'Please review the form' }}
      copy={credentialsCopy}
    />
  )
}

describe('Account credentials presentation', () => {
  it('owns one complete modal frame without nesting a credentials card', () => {
    render(
      <AccountCredentialsSurface
        surface="modal"
        surfaceTitle="Sign in to Northstar"
        closeLabel="Close sign in"
        onClose={() => undefined}
        mode="login"
        values={{ email: 'person@example.test', password: 'secret' }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        copy={credentialsCopy}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: 'Sign in to Northstar' })
    expect(dialog.querySelector('[data-account-credentials-frame="bare"]')).toBeTruthy()
    expect(dialog.querySelector('[data-account-credentials-frame="card"]')).toBeNull()
    expect(screen.getAllByRole('heading')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Close sign in' })).toBeTruthy()
  })

  it('supports registration autocomplete, controlled fields, enter submission and live errors', () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    render(
      <AccountCredentialsView
        mode="register"
        values={{ username: 'north', email: 'person@example.test', password: 'secret', confirmation: 'different' }}
        onChange={onChange}
        onSubmit={onSubmit}
        usernameAvailability="unavailable"
        usernameSuggestions={['northstar-user']}
        errors={{ username: 'Username is unavailable' }}
        copy={credentialsCopy}
      />,
    )

    expect(screen.getByLabelText('Username').getAttribute('autocomplete')).toBe('username')
    expect(screen.getByLabelText('Email').getAttribute('autocomplete')).toBe('email')
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('new-password')
    expect(screen.getByLabelText('Confirm password').getAttribute('autocomplete')).toBe('new-password')
    expect(screen.getByText('Username is unavailable').getAttribute('aria-live')).toBe('polite')
    expect(screen.getByText('Suggestions')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'northstar' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ username: 'northstar' }))
    fireEvent.keyDown(screen.getByLabelText('Confirm password'), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Passwords do not match')).toBeTruthy()
  })

  it('disables every submit action while pending', () => {
    render(
      <AccountCredentialsView
        mode="login"
        values={{ email: 'person@example.test', password: 'secret' }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        pending
        copy={credentialsCopy}
      />,
    )
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Email') as HTMLInputElement).disabled).toBe(true)
  })
})

describe('Account auxiliary presentation', () => {
  it('renders login methods with callback-backed actions', () => {
    const onSelect = vi.fn()
    render(
      <AccountLoginMethodListView
        methods={[{ id: 'password', label: 'Password', description: 'Use an account password' }]}
        onSelect={onSelect}
        copy={{ title: 'Choose sign-in method', methodActionLabel: 'Use method' }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Password/ }))
    expect(onSelect).toHaveBeenCalledWith('password')
  })

  it('bounds long login-method, recovery and reset content', () => {
    const long = 'Long host copy '.repeat(300)
    const { rerender } = render(
      <AccountLoginMethodListView
        methods={[{ id: 'password', label: 'Password', description: long }]}
        onSelect={() => undefined}
        copy={{ title: 'Choose sign-in method', description: long, methodActionLabel: 'Use method' }}
      />,
    )
    expect(screen.getByTestId('account-login-method-scroll').classList.contains('overflow-y-auto')).toBe(true)

    rerender(
      <PasswordRecoveryView
        email="person@example.test"
        onEmailChange={() => undefined}
        onSubmit={() => undefined}
        copy={{
          title: 'Recover access', description: long, emailLabel: 'Email', emailPlaceholder: 'you@example.test',
          actionLabel: 'Send recovery link', successTitle: 'Check your inbox', successMessage: long,
        }}
      />,
    )
    expect(screen.getByTestId('password-recovery-scroll').classList.contains('overflow-y-auto')).toBe(true)

    rerender(
      <PasswordResetView
        password="one"
        confirmation="one"
        onPasswordChange={() => undefined}
        onConfirmationChange={() => undefined}
        onSubmit={() => undefined}
        copy={{
          title: 'Set a new password', description: long, passwordLabel: 'New password', passwordPlaceholder: 'New password',
          confirmationLabel: 'Confirm new password', confirmationPlaceholder: 'Repeat password',
          actionLabel: 'Reset password', successMessage: long, mismatchError: 'Passwords do not match',
        }}
      />,
    )
    expect(screen.getByTestId('password-reset-scroll').classList.contains('overflow-y-auto')).toBe(true)
  })

  it('shows recovery and reset success/error states with controlled inputs', () => {
    const onRecover = vi.fn()
    const onReset = vi.fn()
    const recovery = render(
      <PasswordRecoveryView
        email="person@example.test"
        onEmailChange={() => undefined}
        onSubmit={onRecover}
        status="success"
        copy={{
          title: 'Recover access', emailLabel: 'Email', emailPlaceholder: 'you@example.test',
          actionLabel: 'Send recovery link', successTitle: 'Check your inbox', successMessage: 'Recovery link sent',
        }}
      />,
    )
    expect(screen.getByText('Recovery link sent')).toBeTruthy()
    recovery.unmount()
    render(
      <PasswordResetView
        password="one"
        confirmation="two"
        onPasswordChange={() => undefined}
        onConfirmationChange={() => undefined}
        onSubmit={onReset}
        error="Reset token expired"
        copy={{
          title: 'Set a new password', passwordLabel: 'New password', passwordPlaceholder: 'New password',
          confirmationLabel: 'Confirm new password', confirmationPlaceholder: 'Repeat password',
          actionLabel: 'Reset password', successMessage: 'Password updated', mismatchError: 'Passwords do not match',
        }}
      />,
    )
    expect(screen.getByText('Reset token expired')).toBeTruthy()
    fireEvent.keyDown(screen.getByLabelText('Confirm new password'), { key: 'Enter' })
    expect(onReset).not.toHaveBeenCalled()
    expect(screen.getByText('Passwords do not match')).toBeTruthy()
  })
})
