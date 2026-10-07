// @vitest-environment jsdom
import { createRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Checkbox, Input, NativeSelect, Textarea } from '../src'

afterEach(cleanup)

describe('native form controls', () => {
  it('preserves successful form values, multiple selections and disabled omission', () => {
    const { container } = render(<form>
      <Input name="title" defaultValue="Original" />
      <NativeSelect name="priority" defaultValue="high" aria-label="Priority"><option value="normal">Normal</option><option value="high">High</option></NativeSelect>
      <NativeSelect name="tags" multiple defaultValue={['a', 'b']} aria-label="Tags"><option value="a">A</option><option value="b">B</option></NativeSelect>
      <Textarea name="notes" defaultValue={'line one\nline two'} aria-label="Notes" />
      <Checkbox name="enabled" value="yes" defaultChecked aria-label="Enabled" />
      <Checkbox name="omitted" value="no" defaultChecked disabled aria-label="Disabled" />
      <NativeSelect name="locked" disabled defaultValue="x"><option value="x">X</option></NativeSelect>
      <Textarea name="hidden" disabled defaultValue="private" />
    </form>)
    const data = new FormData(container.querySelector('form')!)
    expect([...data.entries()]).toEqual([
      ['title', 'Original'], ['priority', 'high'], ['tags', 'a'], ['tags', 'b'],
      ['notes', 'line one\nline two'], ['enabled', 'yes'],
    ])
  })

  it('forwards native refs and change events while retaining required/readOnly attributes', () => {
    const select = createRef<HTMLSelectElement>()
    const textarea = createRef<HTMLTextAreaElement>()
    const checkbox = createRef<HTMLInputElement>()
    const changed = vi.fn()
    render(<>
      <NativeSelect ref={select} aria-label="Choice" required onChange={changed} defaultValue="a"><option value="a">A</option><option value="b">B</option></NativeSelect>
      <Textarea ref={textarea} aria-label="Details" required readOnly rows={5} defaultValue="Text" />
      <Checkbox ref={checkbox} aria-label="Flag" onChange={changed} />
    </>)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(changed).toHaveBeenCalledTimes(2)
    expect(select.current?.value).toBe('b')
    expect(select.current?.required).toBe(true)
    expect(textarea.current?.readOnly).toBe(true)
    expect(textarea.current?.rows).toBe(5)
    expect(checkbox.current?.checked).toBe(true)
    textarea.current?.focus()
    expect(document.activeElement).toBe(textarea.current)
  })

  it('renders and clears a controlled mixed checkbox without submitting an invented value', () => {
    const ref = createRef<HTMLInputElement>()
    const changed = vi.fn()
    const { rerender } = render(<Checkbox ref={ref} aria-label="All" indeterminate checked={false} onChange={changed} />)
    expect(ref.current?.indeterminate).toBe(true)
    expect(ref.current?.checked).toBe(false)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(changed).toHaveBeenCalledOnce()
    rerender(<Checkbox ref={ref} aria-label="All" indeterminate checked={false} onChange={changed} />)
    expect(ref.current?.indeterminate).toBe(true)
    rerender(<Checkbox ref={ref} aria-label="All" indeterminate={false} checked onChange={changed} />)
    expect(ref.current?.indeterminate).toBe(false)
    expect(ref.current?.checked).toBe(true)
    expect(ref.current?.type).toBe('checkbox')
  })
})
