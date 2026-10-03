// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SectionHeader } from '../src/section-header'

afterEach(cleanup)

it('renders an h2 by default and keeps the caller-supplied level', () => {
  const { rerender } = render(<SectionHeader title="核心服务" />)
  expect(screen.getByRole('heading', { name: '核心服务', level: 2 })).toBeTruthy()
  rerender(<SectionHeader level={3} title="索引" />)
  expect(screen.getByRole('heading', { name: '索引', level: 3 })).toBeTruthy()
  expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
})

it('renders description and actions without owning their behaviour', () => {
  const onAdd = vi.fn()
  render(
    <SectionHeader
      title="当前连接"
      description="5 分钟前更新"
      actions={<button onClick={onAdd}>刷新</button>}
    />,
  )
  expect(screen.getByText('5 分钟前更新')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(onAdd).toHaveBeenCalledOnce()
})
