// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthSurface } from '../src'

afterEach(() => cleanup())

describe('AuthSurface', () => {
  it('uses dialog semantics only for modal mode and restores focus after close', () => {
    const onClose = vi.fn()
    function Harness() {
      const [open, setOpen] = React.useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open</button>
          {open ? (
            <AuthSurface
              mode="modal"
              title="Sign in"
              closeLabel="Close sign in"
              onClose={() => { onClose(); setOpen(false) }}
            >
              <button type="button">First action</button>
              <button type="button">Second action</button>
            </AuthSurface>
          ) : null}
        </>
      )
    }

    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Sign in' })
    const first = screen.getByRole('button', { name: 'First action' })
    const second = screen.getByRole('button', { name: 'Second action' })
    const close = screen.getByRole('button', { name: 'Close sign in' })
    expect(document.activeElement).toBe(close)

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(second)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(opener)
  })

  it('honours the escape policy and exposes page/embedded as non-dialog surfaces', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <AuthSurface mode="modal" title="Sign in" closeOnEscape={false} onClose={onClose}>
        <button type="button">Continue</button>
      </AuthSurface>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    rerender(
      <>
        <AuthSurface mode="page" title="Page sign in"><p>Page content</p></AuthSurface>
        <AuthSurface mode="embedded" title="Embedded sign in"><p>Embedded content</p></AuthSurface>
      </>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('auth-surface-page').getAttribute('aria-modal')).toBeNull()
    expect(screen.getByTestId('auth-surface-embedded').getAttribute('aria-modal')).toBeNull()
  })

  it('bounds long page content inside the surface body', () => {
    render(
      <AuthSurface mode="page" title="Long sign in">
        <p>{'Long content '.repeat(300)}</p>
      </AuthSurface>,
    )
    const body = screen.getByTestId('auth-surface-body')
    expect(body.classList.contains('max-h-[min(80vh,48rem)]')).toBe(true)
    expect(body.classList.contains('overflow-y-auto')).toBe(true)
  })
})
