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

  it('uses a full-viewport page scene without modal focus semantics', () => {
    render(
      <AuthSurface mode="page" title="Page sign in" presentation="compact">
        <button type="button">Sign in</button>
      </AuthSurface>,
    )

    const page = screen.getByTestId('auth-surface-page')
    const region = screen.getByRole('region', { name: 'Page sign in' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(region.getAttribute('aria-modal')).toBeNull()
    expect(page.classList.contains('min-h-[100dvh]')).toBe(true)
    expect(page.classList.contains('bg-background')).toBe(true)
    expect(page.className).not.toContain('fixed')
    expect(document.activeElement).toBe(document.body)
    expect(screen.getByTestId('auth-surface-body').classList.contains('overflow-y-auto')).toBe(true)
  })

  it('offers an opt-in compact modal card without a visible title bar', () => {
    render(
      <AuthSurface
        mode="modal"
        title="Compact sign in"
        presentation="compact"
        lead={<div data-testid="brand-lead">Linx</div>}
        closeLabel="Close compact sign in"
        onClose={() => undefined}
      >
        <button type="button">Continue</button>
      </AuthSurface>,
    )

    const overlay = screen.getByTestId('auth-surface-modal')
    const dialog = screen.getByRole('dialog', { name: 'Compact sign in' })
    const title = screen.getByRole('heading', { name: 'Compact sign in' })

    expect(overlay.getAttribute('data-auth-surface-presentation')).toBe('compact')
    expect(overlay.classList.contains('bg-black/50')).toBe(true)
    expect(overlay.classList.contains('bg-background')).toBe(false)
    expect(dialog.classList.contains('w-[280px]')).toBe(true)
    expect(dialog.classList.contains('h-[400px]')).toBe(true)
    expect(dialog.classList.contains('rounded-xl')).toBe(true)
    expect(dialog.classList.contains('overflow-hidden')).toBe(true)
    expect(dialog.classList.contains('bg-card')).toBe(true)
    expect(dialog.classList.contains('text-card-foreground')).toBe(true)
    expect(dialog.style.outline).toBe('none')
    expect(dialog.className).not.toContain('bg-stone')
    expect(dialog.className).not.toContain('text-stone')
    expect(dialog.className).not.toContain('dark:bg-zinc')
    expect(title.classList.contains('sr-only')).toBe(true)
    expect(dialog.querySelector('.border-b')).toBeNull()
    expect(screen.getByTestId('brand-lead')).toBeTruthy()
    expect(screen.getByTestId('auth-surface-body').classList.contains('flex-1')).toBe(true)
    expect(screen.getByTestId('auth-surface-body').classList.contains('overflow-y-auto')).toBe(true)
    expect(screen.getByRole('button', { name: 'Close compact sign in' })).toBeTruthy()
    expect(document.activeElement).toBe(dialog)

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close compact sign in' }))
  })

  it('lets a native window host use the compact surface as the window content', () => {
    render(
      <AuthSurface
        mode="modal"
        title="Window sign in"
        presentation="compact"
        host="window"
      >
        <button type="button">Sign in</button>
      </AuthSurface>,
    )

    const windowSurface = screen.getByTestId('auth-surface-modal')
    const dialog = screen.getByRole('dialog', { name: 'Window sign in' })

    expect(windowSurface.getAttribute('data-auth-surface-host')).toBe('window')
    expect(windowSurface.querySelector('[data-auth-surface-frame="window"]')).toBeTruthy()
    expect(windowSurface.querySelector('[data-slot="card"]')).toBeNull()
    expect(windowSurface.classList.contains('bg-card')).toBe(true)
    expect(windowSurface.classList.contains('p-0')).toBe(true)
    expect(windowSurface.classList.contains('bg-black/50')).toBe(false)
    expect(dialog.classList.contains('h-full')).toBe(true)
    expect(dialog.classList.contains('w-full')).toBe(true)
    expect(dialog.className).not.toContain('rounded-')
    expect(dialog.className).not.toContain('border-')
    expect(dialog.className).not.toContain('shadow-')
    expect(dialog.className).not.toContain('w-[280px]')
    expect(dialog.className).not.toContain('h-[400px]')
  })
})
