// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreePaneLayout, TwoPaneLayout, useWorkspaceLayout } from '../src/react'

afterEach(cleanup)

function OpenPane({ pane }: { pane: 'main' | 'context' }) {
  const navigation = useWorkspaceLayout()
  return <button onClick={pane === 'main' ? navigation.openMain : navigation.openContext}>Open {pane}</button>
}

describe('host-owned workspace copy', () => {
  it('uses the two-pane back label without changing navigation or focus', () => {
    render(<TwoPaneLayout mode="stack" listHeader="Items" mainHeader="Detail"
      list={<OpenPane pane="main" />} main="Detail body" copy={{ backToList: 'Back to items' }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open main' }))
    expect(document.activeElement).toBe(screen.getByTestId('workspace-main-pane'))
    fireEvent.click(screen.getByRole('button', { name: 'Back to items' }))
    expect(screen.getByTestId('workspace-main-pane').hidden).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('workspace-list-pane'))
  })

  it('uses both three-pane return labels while retaining pane transitions', () => {
    render(<ThreePaneLayout mode="stack" list={<OpenPane pane="main" />}
      main={<OpenPane pane="context" />} context="Context body"
      copy={{ backToList: 'Back to items', backToMain: 'Back to detail' }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open main' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open context' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to detail' }))
    expect(document.activeElement).toBe(screen.getByTestId('workspace-main-pane'))
    expect(screen.getByTestId('workspace-context-pane').hidden).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Back to items' }))
    expect(document.activeElement).toBe(screen.getByTestId('workspace-list-pane'))
  })

  it('lets the host name context actions while preserving expanded state', () => {
    render(<ThreePaneLayout mode="split" list="Items" main="Detail" context="Tools"
      contextConfig={{ collapsible: true, initiallyCollapsed: true }}
      copy={{ expandContext: 'Show tools', collapseContext: 'Hide tools' }} />)

    const expand = screen.getByRole('button', { name: 'Show tools' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(expand)
    const collapse = screen.getByRole('button', { name: 'Hide tools' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('workspace-context-pane').hidden).toBe(false)
    fireEvent.click(collapse)
    expect(screen.getByTestId('workspace-context-pane').hidden).toBe(true)
  })

  it('preserves defaults for labels omitted from a partial copy', () => {
    render(<ThreePaneLayout mode="split" list="Items" main="Detail" context="Tools"
      contextConfig={{ collapsible: true, initiallyCollapsed: true }}
      copy={{ expandContext: 'Show tools' }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Show tools' }))
    expect(screen.getByRole('button', { name: '折叠上下文面板' }).getAttribute('aria-expanded')).toBe('true')
  })
})
