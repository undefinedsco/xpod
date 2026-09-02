// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OidcConsentView } from '../src'

afterEach(() => cleanup())

const props = {
  client: { name: 'Northstar Calendar', description: 'Requests access to your workspace' },
  webIds: [
    { id: 'webid-ari', label: 'Ari', description: 'Ari identity' },
    { id: 'webid-sam', label: 'Sam', description: 'Sam identity' },
  ],
  storageOptions: [
    { id: 'storage-main', label: 'Main workspace', description: 'Primary storage' },
    { id: 'storage-archive', label: 'Archive', description: 'Archive storage' },
  ],
  selectedWebIdId: 'webid-ari',
  selectedStorageId: 'storage-main',
  rememberClient: false,
  copy: {
    title: 'Authorize Northstar Calendar',
    description: 'Choose exactly which identity and storage to share.',
    webIdLabel: 'Identity to share',
    storageLabel: 'Storage to share',
    rememberClientLabel: 'Remember this client',
    approveLabel: 'Approve access',
    denyLabel: 'Deny',
    editAccountLabel: 'Edit account',
    switchAccountLabel: 'Switch account',
  },
}

describe('OidcConsentView', () => {
  it('returns selected WebID/storage option ids and controlled remember-client state', () => {
    const onApprove = vi.fn()
    const onWebIdChange = vi.fn()
    const onStorageChange = vi.fn()
    const onRememberClientChange = vi.fn()
    render(
      <OidcConsentView
        {...props}
        onApprove={onApprove}
        onDeny={() => undefined}
        onWebIdChange={onWebIdChange}
        onStorageChange={onStorageChange}
        onRememberClientChange={onRememberClientChange}
      />,
    )

    fireEvent.change(screen.getByLabelText('Identity to share'), { target: { value: 'webid-sam' } })
    fireEvent.change(screen.getByLabelText('Storage to share'), { target: { value: 'storage-archive' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Remember this client' }))
    expect(onWebIdChange).toHaveBeenCalledWith('webid-sam')
    expect(onStorageChange).toHaveBeenCalledWith('storage-archive')
    expect(onRememberClientChange).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Approve access' }))
    expect(onApprove).toHaveBeenCalledWith({ webIdId: 'webid-ari', storageId: 'storage-main', rememberClient: false })
  })

  it('keeps consent actions pending and exposes optional account callbacks', () => {
    const onDeny = vi.fn()
    const onEditAccount = vi.fn()
    const onSwitchAccount = vi.fn()
    render(
      <OidcConsentView
        {...props}
        pending
        onApprove={() => undefined}
        onDeny={onDeny}
        onEditAccount={onEditAccount}
        onSwitchAccount={onSwitchAccount}
      />,
    )
    expect((screen.getByRole('button', { name: 'Approve access' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true)
    // Pending actions cannot be activated; account actions become available once pending clears.
    fireEvent.click(screen.getByRole('button', { name: 'Edit account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }))
    expect(onEditAccount).not.toHaveBeenCalled()
    expect(onSwitchAccount).not.toHaveBeenCalled()
    cleanup()
    render(
      <OidcConsentView
        {...props}
        onApprove={() => undefined}
        onDeny={onDeny}
        onEditAccount={onEditAccount}
        onSwitchAccount={onSwitchAccount}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }))
    expect(onEditAccount).toHaveBeenCalledTimes(1)
    expect(onSwitchAccount).toHaveBeenCalledTimes(1)
  })
})
