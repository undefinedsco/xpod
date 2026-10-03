// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SegmentedControl, type SegmentedControlOption } from '../src/segmented-control'

afterEach(cleanup)

function Harness({ options, name, initial, size }: {
  options: ReadonlyArray<SegmentedControlOption<string>>
  name?: string
  initial?: string
  size?: 'sm' | 'md'
}) {
  const [value, setValue] = React.useState(initial ?? options[0].value)
  return <SegmentedControl value={value} onValueChange={setValue} options={options} ariaLabel="视图" name={name} size={size} />
}

const three = [
  { value: 'all', label: '全部' },
  { value: 'mine', label: '我的' },
  { value: 'ai', label: 'AI 的' },
] as const

const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement

describe('SegmentedControl', () => {
  it('is a single-choice radiogroup backed by real native radios', () => {
    render(<Harness options={three} />)

    expect(screen.getByRole('radiogroup', { name: '视图' })).toBeTruthy()
    expect(radio('全部').getAttribute('type')).toBe('radio')
    expect(radio('全部').checked).toBe(true)
    expect(radio('我的').checked).toBe(false)
  })

  it('reports the pressed value once and keeps a single selection', () => {
    const onValueChange = vi.fn()
    render(<SegmentedControl value="all" onValueChange={onValueChange} options={three} ariaLabel="交给谁" />)

    fireEvent.click(radio('AI 的'))

    expect(onValueChange).toHaveBeenCalledTimes(1)
    expect(onValueChange).toHaveBeenCalledWith('ai')
    expect(radio('全部').checked).toBe(true)
    expect(radio('AI 的').checked).toBe(false)
  })

  it('reflects a controlled value change in the native radios', () => {
    render(<Harness options={three} initial="mine" />)

    expect(radio('我的').checked).toBe(true)
    expect(radio('全部').checked).toBe(false)
  })

  it('disables an option for pointer and does not select it', () => {
    render(<Harness options={[
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', disabled: true },
      { value: 'c', label: 'C' },
    ]} />)

    const disabled = radio('B')
    expect(disabled.disabled).toBe(true)

    fireEvent.click(disabled)

    expect(radio('A').checked).toBe(true)
    expect(disabled.checked).toBe(false)
  })

  it('keeps a roving tabindex on the selected option only', () => {
    render(<Harness options={three} initial="mine" />)

    expect(radio('我的').tabIndex).toBe(0)
    expect(radio('全部').tabIndex).toBe(-1)
    expect(radio('AI 的').tabIndex).toBe(-1)
  })

  it('moves selection and focus with Arrow, Home and End', () => {
    render(<Harness options={three} />)

    const all = radio('全部')
    all.focus()

    fireEvent.keyDown(all, { key: 'ArrowRight' })
    expect(radio('我的').checked).toBe(true)
    expect(document.activeElement).toBe(radio('我的'))

    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
    expect(radio('AI 的').checked).toBe(true)

    fireEvent.keyDown(radio('AI 的'), { key: 'ArrowRight' })
    expect(radio('全部').checked).toBe(true)

    fireEvent.keyDown(radio('全部'), { key: 'End' })
    expect(radio('AI 的').checked).toBe(true)

    fireEvent.keyDown(radio('AI 的'), { key: 'Home' })
    expect(radio('全部').checked).toBe(true)

    fireEvent.keyDown(radio('全部'), { key: 'ArrowLeft' })
    expect(radio('AI 的').checked).toBe(true)

    fireEvent.keyDown(radio('AI 的'), { key: 'ArrowUp' })
    expect(radio('我的').checked).toBe(true)
  })

  it('steps over disabled options and wraps around', () => {
    render(<Harness options={[
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', disabled: true },
      { value: 'c', label: 'C' },
    ]} />)

    radio('A').focus()
    fireEvent.keyDown(radio('A'), { key: 'ArrowRight' })
    expect(radio('C').checked).toBe(true)

    fireEvent.keyDown(radio('C'), { key: 'ArrowRight' })
    expect(radio('A').checked).toBe(true)

    fireEvent.keyDown(radio('A'), { key: 'ArrowLeft' })
    expect(radio('C').checked).toBe(true)
  })

  it('exposes one named native radio group for form submission', () => {
    const { container } = render(<form><Harness options={three} name="view" /></form>)

    expect(new FormData(container.querySelector('form')!).get('view')).toBe('all')

    fireEvent.click(radio('我的'))
    expect(new FormData(container.querySelector('form')!).get('view')).toBe('mine')

    const names = (screen.getAllByRole('radio') as HTMLInputElement[]).map(input => input.name)
    expect(new Set(names)).toEqual(new Set(['view']))
  })

  it('gives the group a stable generated name when the caller omits one', () => {
    render(<Harness options={three} />)

    const names = (screen.getAllByRole('radio') as HTMLInputElement[]).map(input => input.name)
    expect(names[0]).toBeTruthy()
    expect(new Set(names).size).toBe(1)
  })

  it('names icon-only segments and hides the glyph from assistive technology', () => {
    render(<Harness options={[
      { value: 'list', icon: <svg data-testid="list-icon" />, 'aria-label': '清单' },
      { value: 'agenda', icon: <svg data-testid="agenda-icon" />, 'aria-label': '日程' },
    ]} />)

    expect(screen.getByRole('radio', { name: '清单' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: '日程' })).toBeTruthy()
    expect(screen.getByTestId('list-icon').closest('[aria-hidden="true"]')).toBeTruthy()
  })
})
