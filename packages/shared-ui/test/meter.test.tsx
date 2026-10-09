// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Meter } from '../src'

afterEach(cleanup)

describe('Meter', () => {
  it('exposes an accessible progressbar with min/max/now', () => {
    render(<Meter value={73} max={100} label="周限制剩余 73%" />)
    const bar = screen.getByRole('progressbar', { name: '周限制剩余 73%' })
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
    expect(bar.getAttribute('aria-valuenow')).toBe('73')
    expect(bar.querySelector('div')?.style.width).toBe('73%')
  })

  it('clamps values outside the track and derives width from max', () => {
    render(<Meter value={150} max={200} label="用量" />)
    const bar = screen.getByRole('progressbar', { name: '用量' })
    expect(bar.getAttribute('aria-valuenow')).toBe('150')
    expect(bar.querySelector('div')?.style.width).toBe('75%')
  })

  it('stays decorative when the value is unknown so adjacent copy carries the meaning', () => {
    const { container } = render(<Meter label="流量" />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
  })
})
