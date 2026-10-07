// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InlineNotice } from '../src/notice'

afterEach(cleanup)

describe('InlineNotice', () => {
  it('announces politely by default and lets the caller opt into alert', () => {
    const { rerender } = render(<InlineNotice>决定已保存</InlineNotice>)
    expect(screen.getByRole('status').textContent).toContain('决定已保存')

    rerender(
      <InlineNotice tone="destructive" role="alert">
        保存失败
      </InlineNotice>,
    )
    expect(screen.getByRole('alert').textContent).toContain('保存失败')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders injected title, custom icon and action without owning behavior', () => {
    const retry = vi.fn()
    render(
      <InlineNotice
        tone="warning"
        title="连接失败"
        icon={<span data-testid="custom-icon" />}
        action={<button onClick={retry}>重试</button>}
      >
        请检查网络后重试。
      </InlineNotice>,
    )
    expect(screen.getByText('连接失败')).toBeTruthy()
    expect(screen.getByText('请检查网络后重试。')).toBeTruthy()
    expect(screen.getByTestId('custom-icon')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(retry).toHaveBeenCalledOnce()
  })
})
