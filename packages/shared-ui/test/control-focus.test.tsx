// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Button, Input } from '../src'

afterEach(() => cleanup())

describe('shared control focus presentation', () => {
  it('uses one control boundary and no second button frame', () => {
    render(
      <>
        <Input aria-label="Name" />
        <Button>Continue</Button>
      </>,
    )

    for (const control of [screen.getByLabelText('Name'), screen.getByRole('button', { name: 'Continue' })]) {
      expect(control.className).not.toContain('focus-visible:ring-2')
      expect(control.className).not.toContain('ring-offset')
    }
    expect(screen.getByLabelText('Name').className).toContain('focus-visible:border-ring')
    expect(screen.getByLabelText('Name').className).not.toContain('focus-visible:outline-2')
    expect(screen.getByRole('button', { name: 'Continue' }).className)
      .toContain('focus-visible:outline-none')
    expect(screen.getByRole('button', { name: 'Continue' }).className)
      .toContain('focus-visible:bg-primary/80')
  })

  it('keeps the focus outline out of the transition so no outer frame flashes', () => {
    render(<Input aria-label="Name" />)

    // Tailwind's `outline-none` is a transparent 2px outline at a 2px offset,
    // not `outline: none`. Transitioning its colour animates that outer frame
    // from the inherited foreground into transparency, which reads as a second
    // frame appearing and then fading away around the focused border.
    const transition = screen.getByLabelText('Name').className
      .split(/\s+/)
      .find((name) => name.startsWith('transition-['))

    expect(transition).toBe('transition-[border-color]')
  })
})
