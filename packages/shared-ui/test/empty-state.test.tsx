// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EmptyState } from '../src/empty-state'

afterEach(cleanup)

it('renders supplied content and delegates the action without owning state', () => {
  const retry = vi.fn()
  const { rerender } = render(<EmptyState title="Nothing here" description="Try again later" action={<button onClick={retry}>Retry</button>} />)
  expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(retry).toHaveBeenCalledOnce()
  rerender(<EmptyState description="No matches" />)
  expect(screen.queryByRole('heading')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByText('No matches')).toBeTruthy()
})
