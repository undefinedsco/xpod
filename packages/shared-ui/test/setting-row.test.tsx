// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingRow, SwitchSettingRow } from '../src/setting-row'

afterEach(cleanup)

it('associates the visible label and description with the actual control', () => {
  render(
    <SettingRow
      label="意外退出时自动重启"
      description="你手动停止的不会被重启"
      control={({ id, 'aria-describedby': describedBy }) => (
        <input id={id} aria-describedby={describedBy} type="checkbox" />
      )}
    />,
  )
  const control = screen.getByRole('checkbox', { name: '意外退出时自动重启' })
  const describedBy = control.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  expect(document.getElementById(describedBy!)?.textContent).toBe('你手动停止的不会被重启')
})

it('reuses the shared Switch and reports checked changes', () => {
  const onCheckedChange = vi.fn()
  const { rerender } = render(
    <SwitchSettingRow label="开机时启动 Xpod" checked={false} onCheckedChange={onCheckedChange} />,
  )
  const toggle = screen.getByRole('switch', { name: '开机时启动 Xpod' })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(toggle)
  expect(onCheckedChange).toHaveBeenCalledWith(true)

  rerender(<SwitchSettingRow label="开机时启动 Xpod" checked onCheckedChange={onCheckedChange} />)
  expect(toggle.getAttribute('aria-checked')).toBe('true')
})

it('keeps the disabled state from reaching the control', () => {
  const onCheckedChange = vi.fn()
  render(<SwitchSettingRow label="停止 Xpod" description="本机独占" checked={false} disabled onCheckedChange={onCheckedChange} />)
  const toggle = screen.getByRole('switch', { name: '停止 Xpod' })
  expect((toggle as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(toggle)
  expect(onCheckedChange).not.toHaveBeenCalled()
})
