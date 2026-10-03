// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiProviderCard } from '../src/AiProviderCard'
import { PROVIDERS } from '../src/controller'
import { catalogProvider } from './fixtures'
import { PROVIDER_LABELS, providerOfferings } from '../src/contract/provider-catalog'
import type { AiProviderSummary } from '../src/contract/ai-connections-client'

afterEach(cleanup)

function renderProvider(product: AiProviderSummary) {
  const onBeginBrowser = vi.fn()
  render(<AiProviderCard definition={PROVIDERS.find((item) => item.id === product.id)!}
    product={product} status="disconnected" apiKey="" busy={false} models={[]}
    onApiKeyChange={vi.fn()} onBeginApiKey={vi.fn()} onBeginOffering={vi.fn()}
    onBeginBrowser={onBeginBrowser} onSaveApiKey={vi.fn()} onDisconnect={vi.fn()} />)
  return { onBeginBrowser }
}

describe('official subscription catalog and provider links', () => {
  it('projects every provider name from the shared catalog authority', () => {
    for (const definition of PROVIDERS) expect(definition.name).toBe(PROVIDER_LABELS[definition.id])
  })

  it('declares Claude Pro/Max independently from API keys without claiming subscription connection support', () => {
    const subscription = providerOfferings('anthropic').find((item) => item.id === 'official-subscription')!
    expect(subscription.label).toBe('Claude Pro / Max')
    expect(subscription.productLabel).toBe('Claude Code')
    expect(subscription.subscriptionUrl).toBe('https://claude.com/pricing')
    expect(subscription.consoleUrl).toBe('https://claude.ai/')
    expect(subscription.lifecycle).toBe('unavailable')
    expect(subscription.authModes).not.toContain('apiKey')
    expect(subscription.authorizationMethods).toEqual([])
    expect(subscription.endpoints).toEqual([])
  })

  it('keeps an unsupported official subscription visible with official links and honest product wording', () => {
    renderProvider(catalogProvider('anthropic'))
    const heading = screen.getByRole('heading', { name: 'Claude Pro / Max' })
    const details = heading.closest('section')!
    expect(within(details).getByText(/暂不支持订阅接入/u)).toBeTruthy()
    expect(details.textContent).toContain('Claude Code')
    expect(details.textContent).toContain('API Key 接入与计费独立')
    expect(within(details).getByRole('link', { name: '订阅与账单' }).getAttribute('href')).toBe('https://claude.com/pricing')
    expect(screen.getByRole('button', { name: '新建 API Key 连接' })).toHaveProperty('disabled', false)
    expect(screen.queryByRole('button', { name: '设备码登录' })).toBeNull()
  })

  it.each(['anthropic', 'bailian', 'kimi'] as const)('%s places its declared workbench beside the official homepage without starting a connection', (provider) => {
    const product = catalogProvider(provider)
    const definition = PROVIDERS.find((item) => item.id === provider)!
    const { onBeginBrowser } = renderProvider(product)
    const links = screen.getByRole('group', { name: `${definition.name}官方链接` })
    const homepage = within(links).getByRole('link', { name: '访问官网' })
    const workbench = within(links).getByRole('link', { name: '打开工作台' })
    expect(homepage.getAttribute('href')).toBe(definition.homeUrl)
    expect(workbench.getAttribute('href')).toBe(product.offerings.find((item) => item.authModes?.includes('apiKey'))!.consoleUrl)
    expect(workbench.getAttribute('target')).toBe('_blank')
    expect(workbench.getAttribute('rel')).toContain('noreferrer')
    workbench.focus()
    expect(document.activeElement).toBe(workbench)
    fireEvent.click(workbench)
    expect(onBeginBrowser).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '浏览器登录' })).toBeNull()
    expect(screen.getByTestId('provider-connect-actions').textContent).toContain('添加 API Key')
  })

  it('does not invent a workbench for a declaration with no console entry', () => {
    renderProvider(catalogProvider('deepseek'))
    expect(screen.getByRole('link', { name: '访问官网' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: '打开工作台' })).toBeNull()
  })
})
