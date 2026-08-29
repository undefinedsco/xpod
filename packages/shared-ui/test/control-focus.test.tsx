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
})
