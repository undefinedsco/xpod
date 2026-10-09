// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ListRow, ListSurface } from '../src/list'

afterEach(cleanup)

it('keeps a native list and its direct items without adding a surface wrapper', () => {
  const ref = createRef<HTMLUListElement>()
  const { container } = render(
    <ListSurface asChild>
      <ul ref={ref} aria-label="Xpod 密钥列表"><li>个人客户端</li><li>工作客户端</li></ul>
    </ListSurface>,
  )
  const list = screen.getByRole('list', { name: 'Xpod 密钥列表' })
  expect(container.firstElementChild).toBe(list)
  expect(ref.current).toBe(list)
  expect(Array.from(list.children).map((item) => item.tagName)).toEqual(['LI', 'LI'])
})

it('forwards surface refs and events to the existing sortable container', () => {
  const ref = createRef<HTMLDivElement>()
  const onPointerDown = vi.fn()
  const { container } = render(
    <ListSurface asChild ref={ref} onPointerDown={onPointerDown}>
      <div data-testid="sortable-container"><span role="status">顺序已更新</span><div data-sortable-credential="one">连接</div></div>
    </ListSurface>,
  )
  const sortable = screen.getByTestId('sortable-container')
  expect(container.firstElementChild).toBe(sortable)
  expect(ref.current).toBe(sortable)
  expect(sortable.querySelector('[data-sortable-credential]')?.parentElement).toBe(sortable)
  fireEvent.pointerDown(sortable)
  expect(onPointerDown).toHaveBeenCalledOnce()
})

it('renders row slots and forwards the ref to the row element', () => {
  const ref = createRef<HTMLDivElement>()
  render(
    <ListSurface>
      <ListRow ref={ref} leading={<span>led</span>} title="查询引擎（QLever）" description="检索和数据查询" trailing={<span>已停止</span>} />
    </ListSurface>,
  )
  expect(screen.getByText('查询引擎（QLever）')).toBeTruthy()
  expect(screen.getByText('检索和数据查询')).toBeTruthy()
  expect(screen.getByText('已停止')).toBeTruthy()
  expect(ref.current?.textContent).toContain('查询引擎（QLever）')
})

it('does not synthesise an interactive role for a non-interactive row', () => {
  render(<ListRow title="Solid 服务" trailing="未报告" />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('link')).toBeNull()
})

it('keeps nested controls legal without turning the whole row interactive', () => {
  render(
    <ListRow title="cloudflared" trailing="未安装">
      <details>
        <summary>安装方法</summary>
      </details>
    </ListRow>,
  )
  expect(screen.getByText('cloudflared')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByText('安装方法')).toBeTruthy()
})

it('renders an actual interactive element through asChild while applying row layout', () => {
  const onClick = vi.fn()
  const ref = createRef<HTMLButtonElement>()
  render(
    <ListRow asChild className="p-3 text-xs">
      <button ref={ref} type="button" onClick={onClick}>
        打开日志
      </button>
    </ListRow>,
  )
  const button = screen.getByRole('button', { name: '打开日志' })
  expect(button.className).toContain('p-3')
  expect(button.className).toContain('text-xs')
  expect(ref.current).toBe(button)
  fireEvent.click(button)
  expect(onClick).toHaveBeenCalledOnce()
})
