// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AppLayout } from '../src/react'

describe('AppLayout', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the 184px text rail and a narrow task bar with a navigation drawer', () => {
    render(
      <AppLayout
        navigation={<nav aria-label="设置分类">Models</nav>}
        className="extension-host"
      >
        <main aria-label="Workspace">Workspace</main>
      </AppLayout>,
    )

    const layout = screen.getByRole('navigation', { name: '设置分类' }).closest('[data-app-layout]')

    expect(layout?.getAttribute('data-app-layout')).toBe('workspace')
    expect(layout?.className).toContain('extension-host')
    expect(layout?.className).toContain('grid-rows-[48px_minmax(0,1fr)]')
    expect(layout?.className).toContain('md:grid-cols-[184px_minmax(0,1fr)]')
    expect(layout?.className).toContain('md:grid-rows-[minmax(0,1fr)]')
    expect(layout?.querySelector('[data-app-layout-navigation]')?.className).toContain('row-start-2')
    expect(layout?.querySelector('[data-app-layout-navigation]')?.className).toContain('hidden')
    expect(layout?.querySelector('[data-app-layout-navigation]')?.className).toContain('md:row-start-1')
    expect(layout?.querySelector('[data-app-layout-navigation]')?.className).toContain('md:block')
    expect(layout?.querySelector('[data-app-layout-content]')?.className).toContain('md:col-start-2')
    expect(screen.getByRole('navigation', { name: '设置分类' })).toBeTruthy()
    // §8.3：窄窗用 48px 任务栏 + 抽屉，不再是底部 Tab
    expect(layout?.querySelector('[data-app-layout-header]')).not.toBeNull()
    expect(screen.getByRole('button', { name: '导航' })).toBeTruthy()
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('main', { name: 'Workspace' })).toBeTruthy()
  })
})
