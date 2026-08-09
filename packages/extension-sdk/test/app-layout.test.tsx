// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AppLayout } from '../src/react'

describe('AppLayout', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders a Linx-sized host rail without a global header', () => {
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
    expect(layout?.className).toContain('grid-rows-[minmax(0,1fr)_64px]')
    expect(layout?.className).toContain('sm:grid-cols-[60px_minmax(0,1fr)]')
    expect(layout?.className).toContain('sm:grid-rows-[minmax(0,1fr)]')
    expect(layout?.querySelector('[data-app-layout-navigation]')?.className).toContain('row-start-2')
    expect(layout?.querySelector('[data-app-layout-navigation]')?.className).toContain('sm:row-start-1')
    expect(layout?.querySelector('[data-app-layout-content]')?.className).toContain('sm:col-start-2')
    expect(screen.getByRole('navigation', { name: '设置分类' })).toBeTruthy()
    expect(layout?.querySelector('[data-app-layout-header]')).toBeNull()
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('main', { name: 'Workspace' })).toBeTruthy()
  })
})
