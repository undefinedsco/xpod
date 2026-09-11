// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiQuotaCard } from '../src/AiQuotaCard'
import type { AiQuotaSnapshot } from '../src/ai-connections-client'

afterEach(cleanup)

const quota: AiQuotaSnapshot = {
  credential: 'primary', status: 'available', balance: 12,
  windows: [{ name: 'weekly', remaining: 75, limit: 100, resetsAt: '2026-09-12T00:00:00Z' }],
  observedAt: '2026-09-09T00:00:00Z', expiresAt: '2026-09-10T00:00:00Z', source: 'official',
}
const props = { providerName: 'OpenAI', offeringName: '账号订阅', credentialLabel: 'Primary', busy: false, onRefresh: vi.fn() }

describe('AiQuotaCard', () => {
  it('retains the standalone card layout by default', () => {
    render(<AiQuotaCard {...props} quota={quota} />)
    expect(screen.getByText('剩余额度')).toBeTruthy()
    expect(screen.getByText('凭证：Primary')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('75')
    expect(screen.getByRole('button', { name: '刷新 OpenAI 账号订阅额度' })).toBeTruthy()
  })

  it('embeds summary and a credential-specific refresh without duplicated headings', async () => {
    const onRefresh = vi.fn()
    const { container } = render(<AiQuotaCard {...props} compact quota={quota} onRefresh={onRefresh} />)
    expect(screen.queryByText('剩余额度')).toBeNull()
    expect(screen.queryByText('凭证：Primary')).toBeNull()
    expect(container.firstElementChild?.className).not.toContain('border-t')
    expect(screen.getByText('余额：12')).toBeTruthy()
    expect(screen.getByText('周限制 · 剩余 75%')).toBeTruthy()
    const refresh = screen.getByRole('button', { name: '刷新 OpenAI 账号订阅 Primary额度' })
    expect(refresh.textContent).toBe('')
    fireEvent.click(refresh)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    const info = screen.getByRole('button', { name: 'Primary额度详情' })
    expect(container.querySelector('details')).toBeNull()
    expect(info.getAttribute('aria-expanded')).toBe('false')
    info.focus()
    fireEvent.click(info)
    const dialog = screen.getByRole('dialog', { name: '额度详情' })
    expect(container.contains(dialog)).toBe(false)
    expect(info.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('75')
    expect(screen.getByText(/重置：/)).toBeTruthy()
    expect(screen.getByText('来源：official')).toBeTruthy()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(info))
  })

  it('reserves an info control before refresh and shows viewport-clamped floating details without changing the card tree', async () => {
    const { container, rerender } = render(<AiQuotaCard {...props} compact />)
    const info = screen.getByRole('button', { name: 'Primary额度详情' }) as HTMLButtonElement
    expect(info.disabled).toBe(true)
    expect(container.querySelectorAll('button')).toHaveLength(2)
    rerender(<AiQuotaCard {...props} compact quota={quota} />)
    expect(info.disabled).toBe(false)
    expect(container.querySelector('details')).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(2)
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    vi.spyOn(info, 'getBoundingClientRect').mockReturnValue({ top: 220, bottom: 244, left: 366, right: 390, width: 24, height: 24, x: 366, y: 220, toJSON() {} })
    fireEvent.click(info)
    const dialog = screen.getByRole('dialog')
    expect(dialog.style.left).toBe('54px')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    expect(dialog.style.transform).toBe('none')
    expect(dialog.style.animation).toBe('none')
    expect(container.querySelectorAll('button')).toHaveLength(2)
    await new Promise((resolve) => setTimeout(resolve, 0))
    fireEvent.pointerDown(document.documentElement)
    fireEvent.click(document.documentElement)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    vi.restoreAllMocks()
  })

  it('closes when its anchor moves but allows scrolling inside the floating details', async () => {
    render(<AiQuotaCard {...props} compact quota={quota} />)
    const info = screen.getByRole('button', { name: 'Primary额度详情' })
    fireEvent.click(info)
    fireEvent.scroll(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.scroll(document)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(info)
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows pending, error, missing, paused and unsupported states without stale summaries', () => {
    const { rerender } = render(<AiQuotaCard {...props} compact quota={quota} busy />)
    expect(screen.getByRole('status').textContent).toBe('正在查询额度…')
    expect(screen.queryByText('余额：12')).toBeNull()
    expect((screen.getByRole('button', { name: /^刷新 / }) as HTMLButtonElement).disabled).toBe(true)
    rerender(<AiQuotaCard {...props} compact quota={quota} error="查询超时" />)
    expect(screen.getByRole('alert').textContent).toBe('查询超时')
    expect(screen.queryByText('余额：12')).toBeNull()
    rerender(<AiQuotaCard {...props} compact />)
    expect(screen.getByText('尚未检查')).toBeTruthy()
    rerender(<AiQuotaCard {...props} compact paused quota={{ ...quota, status: 'unsupported' }} />)
    expect(screen.getByText('已停用 · 不参与全部刷新')).toBeTruthy()
    expect(screen.getByText('官方额度接口不支持')).toBeTruthy()
    expect((screen.getByRole('button', { name: /^刷新 / }) as HTMLButtonElement).disabled).toBe(false)
    rerender(<AiQuotaCard {...props} compact quota={{ ...quota, status: 'error' }} />)
    expect(screen.getByRole('alert').textContent).toBe('额度查询失败')
  })
})
