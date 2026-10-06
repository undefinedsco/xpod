// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { BrandInfo } from '../src/brand-info'

afterEach(cleanup)

test('accepts any brand and reveals host-provided details outside its layout container', async () => {
  const { container } = render(<BrandInfo logo={<span>Acme</span>} info={<p>Acme account service</p>} />)
  expect(screen.getByText('Acme')).toBeTruthy()
  expect(screen.queryByText('Acme account service')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  const tooltip = await screen.findByRole('tooltip')
  expect(within(tooltip).getByText('Acme account service')).toBeTruthy()
  expect(container.contains(tooltip)).toBe(false)
})

test('renders only the logo when no information is provided', () => {
  render(<BrandInfo logo={<span>Another brand</span>} />)
  expect(screen.getByText('Another brand')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('tooltip')).toBeNull()
})

test('supports hover and localized accessible information labels', async () => {
  render(<BrandInfo logo="Acme" info="Details supplied by the host" infoLabel="更多信息" />)
  fireEvent.pointerMove(screen.getByRole('button', { name: '更多信息' }), { pointerType: 'mouse' })
  expect(await screen.findByRole('tooltip')).toBeTruthy()
})

test('opens on keyboard focus and closes on Escape or outside pointer', async () => {
  render(<BrandInfo logo="Acme" info="More information" />)
  const trigger = screen.getByRole('button', { name: 'Details' })
  fireEvent.focus(trigger)
  expect(await screen.findByRole('tooltip')).toBeTruthy()
  fireEvent.keyDown(trigger, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  fireEvent.click(trigger)
  await screen.findByRole('tooltip')
  // Radix installs the outside-pointer listener after the content mounts.
  await new Promise(resolve => setTimeout(resolve, 0))
  fireEvent.pointerDown(document.body)
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
})

test('a second pointer gesture closes details and preserves adjacent input focus and selection', async () => {
  render(<><BrandInfo logo="Acme" info="More information" /><input aria-label="Email" defaultValue="user@example.com" /></>)
  const input = screen.getByRole('textbox', { name: 'Email' }) as HTMLInputElement
  input.focus()
  input.setSelectionRange(0, input.value.length)
  const trigger = screen.getByRole('button', { name: 'Details' })
  // A prevented pointerdown avoids the browser's default focus/selection change.
  expect(fireEvent.pointerDown(trigger, { cancelable: true })).toBe(false)
  fireEvent.pointerUp(trigger)
  fireEvent.click(trigger)
  await screen.findByRole('tooltip')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(fireEvent.pointerDown(trigger, { cancelable: true })).toBe(false)
  fireEvent.pointerUp(trigger)
  fireEvent.click(trigger)
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(input)
  expect(screen.getByRole('textbox', { name: 'Email' })).toBe(input)
  expect(input.selectionStart).toBe(0)
  expect(input.selectionEnd).toBe(input.value.length)
})
