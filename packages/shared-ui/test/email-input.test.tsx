// @vitest-environment jsdom
import { createRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmailInput } from '../src'

afterEach(() => cleanup())

describe('EmailInput selection compatibility', () => {
  it('supports selection and replacement without changing the username autofill hint', () => {
    const ref = createRef<HTMLInputElement>()
    const change = vi.fn()
    render(<EmailInput ref={ref} aria-label="Email" autoComplete="username" defaultValue="63005737@qq.com" onChange={change} />)
    const input = screen.getByLabelText('Email') as HTMLInputElement
    expect(ref.current).toBe(input)
    expect(input.type).toBe('text')
    expect(input.inputMode).toBe('email')
    expect(input.autocomplete).toBe('username')
    input.setSelectionRange(0, input.value.length)
    expect(input.value.slice(input.selectionStart!, input.selectionEnd!)).toBe('63005737@qq.com')
    fireEvent.change(input, { target: { value: 'replacement@example.test' } })
    expect(change).toHaveBeenCalledTimes(1)
    expect(input.checkValidity()).toBe(true)
  })

  it('retains validity when controlled values change or React rejects an edit', async () => {
    const { rerender } = render(<EmailInput aria-label="Email" value="missing-at" onChange={() => undefined} />)
    const input = screen.getByLabelText('Email') as HTMLInputElement
    expect(input.checkValidity()).toBe(false)
    rerender(<EmailInput aria-label="Email" value="valid+tag@example.test" onChange={() => undefined} />)
    expect(input.checkValidity()).toBe(true)
    fireEvent.input(input, { target: { value: 'invalid@@example.test' } })
    expect(input.value).toBe('valid+tag@example.test')
    await waitFor(() => expect(input.checkValidity()).toBe(true))
  })

  it('validates uncontrolled autofill input events and form resets', async () => {
    render(<form><EmailInput aria-label="Email" defaultValue="valid@example.test" /></form>)
    const input = screen.getByLabelText('Email') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'invalid@@example.test' } })
    expect(input.checkValidity()).toBe(false)
    input.form!.reset()
    expect(input.value).toBe('valid@example.test')
    await waitFor(() => expect(input.checkValidity()).toBe(true))
    fireEvent.input(input, { target: { value: 'autofill@example.test' } })
    expect(input.checkValidity()).toBe(true)
  })

  it('keeps native required email semantics for whitespace-only values', () => {
    render(<EmailInput aria-label="Email" required defaultValue="   " />)
    const input = screen.getByLabelText('Email') as HTMLInputElement
    expect(input.checkValidity()).toBe(false)
  })

  it('does not detach a stable ref when the value changes', () => {
    const ref = vi.fn()
    const { rerender } = render(<EmailInput ref={ref} value="a@example.test" onChange={() => undefined} />)
    const input = ref.mock.calls[0][0]
    rerender(<EmailInput ref={ref} value="b@example.test" onChange={() => undefined} />)
    expect(ref.mock.calls).toEqual([[input]])
  })

  it('preserves required, caller pattern, and native multiple-address semantics', () => {
    const { rerender } = render(<EmailInput aria-label="Email" required defaultValue="" />)
    const input = screen.getByLabelText('Email') as HTMLInputElement
    expect(input.validity.valueMissing).toBe(true)
    const pattern = String.raw`.+@example\.test`
    rerender(<EmailInput aria-label="Email" required pattern={pattern} value="user@other.test" onChange={() => undefined} />)
    expect(input.validity.patternMismatch).toBe(true)
    rerender(<EmailInput aria-label="Email" required pattern={pattern} value="user@example.test" onChange={() => undefined} />)
    expect(input.checkValidity()).toBe(true)
    rerender(<EmailInput aria-label="Email" multiple value="a@example.test,b@example.test" onChange={() => undefined} />)
    expect(input.checkValidity()).toBe(true)
    rerender(<EmailInput aria-label="Email" value="a@example.test,b@example.test" onChange={() => undefined} />)
    expect(input.checkValidity()).toBe(false)
  })
})
