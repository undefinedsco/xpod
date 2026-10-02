// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FormField } from '../src/form-field'
import { Field, CheckboxRow } from '../src/pod-sign-in/parts'

afterEach(cleanup)

describe('login field compatibility', () => {
  it('associates label, error and hint and clears stale error references', () => {
    const view = (error?: string) => <Field label="Identifier" error={error} hint="Use your identifier" labelAside={<a href="#help">Help</a>}>
      {props => <input {...props} />}
    </Field>
    const { container, rerender } = render(view('Required'))
    const input = screen.getByRole('textbox', { name: 'Identifier' })
    const id = input.id
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')?.split(' ').map(value => document.getElementById(value)?.textContent)).toEqual(['Required', 'Use your identifier'])
    expect(screen.getByRole('alert').textContent).toBe('Required')
    expect(container.querySelector('[data-pod-sign-in="field"]')).not.toBeNull()
    rerender(view())
    expect(input.id).toBe(id)
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('Use your identifier')
  })

  it('retains the boolean checkbox callback and native disabled behavior', () => {
    const onChange = vi.fn()
    const { rerender } = render(<CheckboxRow checked={false} onChange={onChange} label="Remember" />)
    const checkbox = screen.getByRole('checkbox', { name: 'Remember' }) as HTMLInputElement
    fireEvent.click(checkbox)
    expect(onChange).toHaveBeenCalledWith(true)
    rerender(<CheckboxRow checked onChange={onChange} label="Remember" disabled />)
    expect(checkbox.checked).toBe(true)
    expect(checkbox.disabled).toBe(true)
  })
})


it('keeps independently rendered public fields unique and free of login markers', () => {
  const { container } = render(<><FormField label="First">{props => <input {...props} />}</FormField><FormField label="Second">{props => <input {...props} />}</FormField></>)
  const first = screen.getByRole('textbox', { name: 'First' })
  const second = screen.getByRole('textbox', { name: 'Second' })
  expect(first.id).not.toBe(second.id)
  expect(first.hasAttribute('aria-describedby')).toBe(false)
  expect(container.querySelector('[data-pod-sign-in]')).toBeNull()
})
