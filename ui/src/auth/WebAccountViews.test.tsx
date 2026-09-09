// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  WebAccountConsentView,
  WebAccountErrorBanner,
  WebAccountFailureView,
  WebAccountRestoringView,
  WebAccountStorageBootstrapView,
} from './WebAccountViews'

afterEach(() => cleanup())

const webConsentCopy = {
  title: 'Authorize Northstar Calendar',
  description: 'Northstar Calendar wants access to your Pod.',
  webIdLabel: 'Identity',
  storageLabel: 'Storage',
  rememberClientLabel: 'Remember this app',
  approveLabel: 'Approve',
  denyLabel: 'Deny',
  editAccountLabel: 'Manage account',
  switchAccountLabel: 'Switch account',
}

const webBootstrapCopy = {
  title: 'Prepare storage',
  description: 'Create storage before authorizing this app.',
  creationMessage: 'Create storage to continue.',
  waitingMessage: 'Waiting for storage binding.',
  readyMessage: 'Storage is ready.',
  conflictMessage: 'Storage belongs to another identity.',
  errorMessage: 'Could not prepare storage.',
  createLabel: 'Create storage',
  continueLabel: 'Continue',
  retryLabel: 'Try again',
  cancelLabel: 'Cancel',
}

describe('Web account native presentation', () => {
  it('owns Account business props without importing shared-ui business views or their types', () => {
    const source = readFileSync(join(process.cwd(), 'ui/src/auth/WebAccountViews.tsx'), 'utf8')

    expect(source).not.toContain('@undefineds.co/shared-ui')
    expect(source).not.toMatch(/\bOidcConsentView\b/)
    expect(source).not.toMatch(/\bStorageBootstrapView\b(?!Props)/)
    expect(source).not.toContain('ComponentProps<typeof')
  })

  it('renders restoring, failure and dismissible error states without shared card shells', () => {
    const onPrimary = vi.fn()
    const onSecondary = vi.fn()
    const onDismiss = vi.fn()
    const { container, rerender } = render(
      <WebAccountRestoringView label="Restoring account…" accountName="Ari" />,
    )

    expect(screen.getByRole('status').textContent).toContain('Restoring account…')
    expect(screen.getByText('Ari')).toBeTruthy()
    expect(container.querySelector('.bg-card')).toBeNull()

    rerender(
      <WebAccountFailureView
        title="Account unavailable"
        description="Could not load the account page."
        primaryLabel="Retry"
        onPrimary={onPrimary}
        secondaryLabel="Back"
        onSecondary={onSecondary}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onPrimary).toHaveBeenCalledTimes(1)
    expect(onSecondary).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toContain('Could not load the account page.')
    expect(container.querySelector('.bg-card')).toBeNull()

    rerender(<WebAccountErrorBanner error="Consent failed" onDismiss={onDismiss} dismissLabel="Dismiss error" />)
    expect(screen.getByRole('alert').textContent).toContain('Consent failed')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('renders consent as concise native controls and reports selected ids', () => {
    const onWebIdChange = vi.fn()
    const onRememberClientChange = vi.fn()
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    const onEditAccount = vi.fn()
    const onSwitchAccount = vi.fn()
    const { container } = render(
      <WebAccountConsentView
        client={{ name: 'Northstar Calendar', description: 'https://calendar.example.test' }}
        webIds={[
          { id: 'ari', label: 'Ari', description: 'Primary identity', webId: 'https://id.example.test/ari#me', storageUrl: 'https://pod.example.test/ari/' },
          { id: 'sam', label: 'Sam', storageUrl: 'https://pod.example.test/sam/' },
        ]}
        storageOptions={[]}
        selectedWebIdId="ari"
        rememberClient={false}
        onWebIdChange={onWebIdChange}
        onRememberClientChange={onRememberClientChange}
        onApprove={onApprove}
        onDeny={onDeny}
        onEditAccount={onEditAccount}
        onSwitchAccount={onSwitchAccount}
        copy={webConsentCopy}
      />,
    )

    expect(container.querySelector('[data-testid="oidc-consent-scroll"]')).toBeNull()
    expect(container.querySelector('.bg-card')).toBeNull()
    fireEvent.change(screen.getByLabelText('Identity'), { target: { value: 'sam' } })
    fireEvent.click(screen.getByLabelText('Remember this app'))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    fireEvent.click(screen.getByRole('button', { name: 'Manage account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }))

    expect(onWebIdChange).toHaveBeenCalledWith('sam')
    expect(onRememberClientChange).toHaveBeenCalledWith(true)
    expect(onApprove).toHaveBeenCalledWith({ webIdId: 'ari', storageId: undefined, rememberClient: false })
    expect(onDeny).toHaveBeenCalledTimes(1)
    expect(onEditAccount).toHaveBeenCalledTimes(1)
    expect(onSwitchAccount).toHaveBeenCalledTimes(1)
  })

  it('shows a single resolved consent identity as readable text with bound storage URL', () => {
    render(
      <WebAccountConsentView
        client={{ name: 'Northstar Calendar' }}
        webIds={[{ id: 'ari', label: 'Ari', storageUrl: 'https://pod.example.test/ari/' }]}
        storageOptions={[]}
        selectedWebIdId="ari"
        showIdentitySelection={false}
        rememberClient
        onApprove={() => undefined}
        onDeny={() => undefined}
        copy={webConsentCopy}
      />,
    )

    expect(screen.queryByLabelText('Identity')).toBeNull()
    expect(screen.getByText('Ari')).toBeTruthy()
    expect(screen.getByText('https://pod.example.test/ari/')).toBeTruthy()
  })

  it('keeps pending consent controls disabled', () => {
    render(
      <WebAccountConsentView
        client={{ name: 'Northstar Calendar' }}
        webIds={[{ id: 'ari', label: 'Ari' }]}
        storageOptions={[{ id: 'main', label: 'Main storage', storageUrl: 'https://pod.example.test/ari/' }]}
        selectedWebIdId="ari"
        selectedStorageId="main"
        rememberClient={false}
        onWebIdChange={() => undefined}
        onStorageChange={() => undefined}
        onRememberClientChange={() => undefined}
        onApprove={() => undefined}
        onDeny={() => undefined}
        onEditAccount={() => undefined}
        onSwitchAccount={() => undefined}
        pending
        copy={webConsentCopy}
      />,
    )

    expect((screen.getByLabelText('Remember this app') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Manage account' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Switch account' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders storage bootstrap states as body content with native actions', () => {
    const onCreate = vi.fn()
    const onContinue = vi.fn()
    const onRetry = vi.fn()
    const onCancel = vi.fn()
    const { container, rerender } = render(
      <WebAccountStorageBootstrapView
        state="creation"
        copy={webBootstrapCopy}
        onCreate={onCreate}
      />,
    )

    expect(container.querySelector('[data-testid="storage-bootstrap-scroll"]')).toBeNull()
    expect(container.querySelector('.bg-card')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Create storage' }))
    expect(onCreate).toHaveBeenCalledTimes(1)

    rerender(<WebAccountStorageBootstrapView state="waiting" copy={webBootstrapCopy} onCancel={onCancel} />)
    expect(screen.getByRole('status').textContent).toContain('Waiting for storage binding.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)

    rerender(<WebAccountStorageBootstrapView state="ready" copy={webBootstrapCopy} onContinue={onContinue} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalledTimes(1)

    rerender(<WebAccountStorageBootstrapView state={{ status: 'error', message: 'Provision failed' }} copy={webBootstrapCopy} onRetry={onRetry} />)
    expect(screen.getByRole('alert').textContent).toContain('Provision failed')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
