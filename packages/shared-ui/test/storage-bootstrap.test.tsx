// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageBootstrapView } from '../src'

afterEach(() => cleanup())

const copy = {
  title: 'Prepare your workspace',
  creationMessage: 'Create a workspace to continue.',
  waitingMessage: 'Waiting for the identity binding.',
  readyMessage: 'Workspace is ready.',
  conflictMessage: 'This workspace belongs to another identity.',
  errorMessage: 'Workspace could not be prepared.',
  createLabel: 'Create workspace',
  continueLabel: 'Continue',
  retryLabel: 'Try again',
  cancelLabel: 'Cancel',
}

describe('StorageBootstrapView', () => {
  it('reports user intent for creation, waiting, ready, conflict and error states', () => {
    const onCreate = vi.fn()
    const onContinue = vi.fn()
    const onRetry = vi.fn()
    const { rerender } = render(
      <StorageBootstrapView state="creation" copy={copy} onCreate={onCreate} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    expect(onCreate).toHaveBeenCalledTimes(1)

    rerender(<StorageBootstrapView state="waiting" copy={copy} onCancel={() => undefined} />)
    expect(screen.getByRole('status').textContent).toContain('Waiting for the identity binding.')

    rerender(<StorageBootstrapView state="ready" copy={copy} onContinue={onContinue} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalledTimes(1)

    rerender(<StorageBootstrapView state={{ status: 'conflict', message: 'Binding conflict' }} copy={copy} onRetry={onRetry} />)
    expect(screen.getByRole('alert').textContent).toContain('Binding conflict')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    rerender(<StorageBootstrapView state={{ status: 'error', message: 'Transport failed' }} copy={copy} onRetry={onRetry} />)
    expect(screen.getByRole('alert').textContent).toContain('Transport failed')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('bounds long content for scrolling and never provisions storage itself', () => {
    render(
      <StorageBootstrapView
        state="creation"
        copy={{ ...copy, creationMessage: 'A '.repeat(300) }}
        onCreate={() => undefined}
      />,
    )
    expect(screen.getByTestId('storage-bootstrap-scroll').classList.contains('overflow-y-auto')).toBe(true)
    expect(screen.getByRole('button', { name: 'Create workspace' })).toBeTruthy()
  })
})
