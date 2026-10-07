// @vitest-environment jsdom
import { createRef, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SearchInput } from '../src'

afterEach(cleanup)

describe('SearchInput', () => {
  it('preserves controlled filtering, keyboard focus and the forwarded input ref', () => {
    const ref = createRef<HTMLInputElement>()
    function Filter() {
      const [query, setQuery] = useState('')
      return <SearchInput ref={ref} aria-label="搜索模型" value={query} onChange={event => setQuery(event.target.value)} />
    }
    render(<Filter />)
    const input = screen.getByRole('searchbox', { name: '搜索模型' })
    fireEvent.change(input, { target: { value: '模型' } })
    expect(ref.current?.value).toBe('模型')
    ref.current?.focus()
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('placeholder')).toBe('搜索')
  })

  it('keeps native form identity and disabled semantics without an extra focus target', () => {
    const { container } = render(<SearchInput id="logs" name="query" aria-label="搜索日志" placeholder="搜索日志" disabled defaultValue="gateway" />)
    const input = screen.getByRole('searchbox', { name: '搜索日志' }) as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect(input.name).toBe('query')
    expect(input.id).toBe('logs')
    expect(input.value).toBe('gateway')
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelectorAll('input, button, [tabindex]')).toHaveLength(1)
  })
})
