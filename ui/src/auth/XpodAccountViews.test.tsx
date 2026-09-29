// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AccountCredentialsView,
  AccountLoginMethodListView,
  PasswordRecoveryView,
  PasswordResetView,
  type AccountCredentialsCopy,
} from './XpodAccountViews'

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

describe('Account credentials presentation', () => {
  it('does not show confirmation mismatch before blur or submission', () => {
    render(<AccountCredentialsView mode="register"
      values={{ password: 'new-password', confirmation: '' }}
      onChange={() => undefined} onSubmit={() => undefined} copy={credentialsCopy} />)
    expect(screen.queryByText(credentialsCopy.mismatchError)).toBeNull()
    fireEvent.blur(screen.getByLabelText('Confirm password'))
    expect(screen.getByText(credentialsCopy.mismatchError)).toBeTruthy()
  })

  it('keeps every required credential field inside the same native form', () => {
    render(
      <AccountCredentialsView
        mode="register"
        values={{ email: 'person@example.test', password: 'secret', confirmation: 'secret' }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        copy={credentialsCopy}
      />,
    )

    const form = screen.getByLabelText('Email').closest('form')
    expect(form).toBeTruthy()
    // Registration asks for the Account's own fields only; a Pod name is not one.
    expect(screen.queryByLabelText('Username')).toBeNull()
    expect(form?.contains(screen.getByLabelText('Password'))).toBe(true)
    expect(form?.contains(screen.getByLabelText('Confirm password'))).toBe(true)
    expect(form?.contains(screen.getByRole('button', { name: 'Create account' }))).toBe(true)
  })

  it('uses stacked labels and real placeholders on the standard page surface', () => {
    render(
      <AccountCredentialsView
        presentation="standard"
        mode="login"
        values={{ email: '', password: '' }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        copy={credentialsCopy}
      />,
    )

    const email = screen.getByLabelText('Email')
    const password = screen.getByLabelText('Password')

    expect(email.getAttribute('placeholder')).toBe('you@example.test')
    expect(password.getAttribute('placeholder')).toBe('Enter your password')
    expect(email.parentElement?.getAttribute('data-floating-field')).toBeNull()
    expect(email.classList.contains('peer')).toBe(false)
    expect(email.classList.contains('h-11')).toBe(false)
  })

  it('uses floating labels and keeps compact credentials free of nested scroll containers', () => {
    render(
      <AccountCredentialsView
        presentation="compact"
        mode="login"
        values={{ email: '', password: '' }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        copy={credentialsCopy}
      />,
    )

    const email = screen.getByLabelText('Email')
    const password = screen.getByLabelText('Password')

    expect(email.getAttribute('placeholder')).toBe(' ')
    expect(password.getAttribute('placeholder')).toBe(' ')
    expect(email.classList.contains('peer')).toBe(true)
    expect(email.parentElement?.getAttribute('data-floating-field')).toBe('true')
    expect(email.parentElement?.querySelector('label')?.className).toContain('peer-placeholder-shown')
    expect(email.classList.contains('h-11')).toBe(true)
    expect(email.classList.contains('rounded-xl')).toBe(true)
    expect(screen.queryByTestId('account-credentials-scroll')).toBeNull()
    expect(screen.queryByTestId('auth-surface-body')).toBeNull()
  })

  it('supports registration autocomplete, controlled fields, enter submission and live errors', () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    render(
      <AccountCredentialsView
        mode="register"
        values={{ email: 'person@example.test', password: 'secret', confirmation: 'different' }}
        onChange={onChange}
        onSubmit={onSubmit}
        errors={{ email: 'Email is already registered' }}
        copy={credentialsCopy}
      />,
    )

    expect(screen.getByLabelText('Email').getAttribute('autocomplete')).toBe('email')
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('new-password')
    expect(screen.getByLabelText('Confirm password').getAttribute('autocomplete')).toBe('new-password')
    expect(screen.getByText('Email is already registered').getAttribute('aria-live')).toBe('polite')
    expect(screen.queryByLabelText('Username')).toBeNull()

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'other@example.test' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ email: 'other@example.test' }))

    const form = screen.getByLabelText('Confirm password').closest('form')
    expect(form).toBeTruthy()
    fireEvent.submit(form as HTMLFormElement)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Passwords do not match')).toBeTruthy()
  })

  it('drops the removed Pod-name field and its suggestions from compact registration', () => {
    render(
      <AccountCredentialsView
        mode="register"
        presentation="compact"
        values={{ email: '', password: '', confirmation: '' }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        copy={credentialsCopy}
      />,
    )

    expect(screen.queryByLabelText('Username')).toBeNull()
    expect(screen.queryByText('Suggestions')).toBeNull()
    expect(screen.queryByRole('button', { name: 'northstar-user' })).toBeNull()
    // Email, password and confirmation are what the compact card must fit.
    expect(screen.getByLabelText('Email')).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()
    expect(screen.getByLabelText('Confirm password')).toBeTruthy()
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
