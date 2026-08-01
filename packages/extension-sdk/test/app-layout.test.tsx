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
    expect(layout?.getAttribute('style')).toContain(
      'grid-template-columns: 60px minmax(0, 1fr)',
    )
    expect(screen.getByRole('navigation', { name: '设置分类' })).toBeTruthy()
    expect(layout?.querySelector('[data-app-layout-header]')).toBeNull()
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('main', { name: 'Workspace' })).toBeTruthy()
  })
})
