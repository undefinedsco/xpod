// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StatusDot, StatusLine } from '../src/status'

afterEach(cleanup)

describe('StatusDot', () => {
  it('names a standalone dot for assistive tech', () => {
    render(<StatusDot tone="success" label="运行中" />)
    expect(screen.getByRole('img', { name: '运行中' })).toBeTruthy()
  })

  it('stays decorative when visible text already carries the meaning', () => {
    const { container } = render(<StatusLine tone="warning">等待确认</StatusLine>)
    expect(screen.getByText('等待确认')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })

  it('marks an unlabelled dot as decorative instead of announcing a bare colour', () => {
    const { container } = render(<StatusDot tone="destructive" />)
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByRole('img')).toBeNull()
  })
})
