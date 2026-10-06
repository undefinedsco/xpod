// @vitest-environment jsdom
import './setup-jsdom'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { offeringTitle } from '../src/offering-label'
import { AiProviderCard } from '../src/AiProviderCard'
import { AiConnectionsPanel } from '../src'
import { PROVIDERS } from '../src/controller'
import { authorizationMethodsForOffering } from '../src/authorization-methods'
import { providerProductsForDeployment } from '../../../src/api/ai-gateway/providers/ProviderRegistry'
import type {
  AiConnectionsClient,
  AiConnectionsProvider,
  AiProviderAuthorizationMethod,
  AiProviderOffering,
  AiProviderSummary,
} from '../src/contract/ai-connections-client'

/** Real server catalog drives these UI regressions: console key creation and
 * OAuth authorization must remain distinct, including their offering targets. */

const WEB_ID = 'https://pod.example/alice/profile/card#me'

afterEach(() => {
  cleanup()
  document.body.innerHTML = '<div id="root"></div>'
})

/** One provider as the server publishes it, with no stored credentials. */
function serverProduct(
  provider: AiConnectionsProvider,
  deployment: 'local' | 'cloud',
): AiProviderSummary {
  const product = providerProductsForDeployment(deployment).find((candidate) => candidate.id === provider)
  if (!product) throw new Error(`the server catalog publishes no ${provider}`)
  return {
    id: provider,
    name: product.label,
    offerings: product.offerings as unknown as AiProviderOffering[],
    credentials: [],
    selectedModels: [],
    status: 'unconfigured',
  }
}

function renderProviderPage(product: AiProviderSummary, onBeginOffering = vi.fn()) {
  const definition = PROVIDERS.find((candidate) => candidate.id === product.id)
  if (!definition) throw new Error(`no provider definition for ${product.id}`)
  return render(
    <AiProviderCard
      definition={definition}
      product={product}
      status="disconnected"
      apiKey=""
      busy={false}
      models={[]}
      onApiKeyChange={vi.fn()}
      onBeginApiKey={vi.fn()}
      onBeginOffering={onBeginOffering}
      onBeginBrowser={vi.fn()}
      onSaveApiKey={vi.fn()}
      onDisconnect={vi.fn()}
      onCreateLocalCredential={vi.fn(async () => undefined)}
    />,
  )
}

/** Every connect action the page renders, by its own visible label. */
function connectActionLabels(): string[] {
  return [...screen.getByTestId('provider-connect-actions').querySelectorAll('button')]
    .map((button) => button.textContent?.trim() ?? '')
    .filter(Boolean)
}

function methodOf(offering: AiProviderOffering, id: string): AiProviderAuthorizationMethod {
  const method = authorizationMethodsForOffering(offering).find((candidate) => candidate.id === id)
  if (!method) throw new Error(`${offering.id} declares no ${id}`)
  return method
}

describe('provider page connect entries come from authorizationMethods', () => {
  it('places 百炼 console navigation beside its homepage and preserves its key entry', () => {
    const product = serverProduct('bailian', 'cloud')
    renderProviderPage(product)

    expect(connectActionLabels()).toEqual(['添加 API Key'])
    // One console link for the provider, even though four offerings declare it.
    expect(screen.getAllByRole('link', { name: '打开工作台' })).toHaveLength(1)
    // The phantom the original bug report was about: a provider-level 「登录」.
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()

    // The label is the offering's own declaration, not a page-level string.
    const declared = authorizationMethodsForOffering(
      product.offerings.find((offering) => offering.id === 'pay-as-you-go')!,
    ).find((method) => method.connectMode === 'browserAssistedApiKey')
    expect(declared?.label).toBe('打开控制台')
    expect(declared?.lifecycle).toBe('active')
    expect(screen.getByRole('link', { name: '打开工作台' }).getAttribute('href')).toBe(
      product.offerings.find((offering) => offering.authorizationMethods?.some((method) => method.id === 'browser-login'))!.consoleUrl,
    )
  })

  it('renders a subscription provider from the same data, unavailable entries included', () => {
    const product = serverProduct('openai', 'cloud')
    renderProviderPage(product)

    const subscription = product.offerings.find((offering) => offering.id === 'official-subscription')!
    const declared = authorizationMethodsForOffering(subscription)
    expect(connectActionLabels()).toEqual([...declared.map((method) => method.label), '添加 API Key'])
    // Only the subscription's true browser OAuth remains a connect action.
    expect(screen.getAllByRole('button', { name: '浏览器登录' })).toHaveLength(1)

    const browser = screen.getByRole('button', { name: '浏览器登录' })
    expect(browser).toHaveProperty('disabled', true)
    const browserUnavailable = methodOf(subscription, 'browser-oauth')
    expect(browser.getAttribute('title')).toBe(browserUnavailable.reason)
    // The reason lives in the tooltip only: a second line under the row would
    // push the neighbouring buttons out of line.
    expect(screen.queryByText(browserUnavailable.reason!)).toBeNull()
    expect(screen.getByTestId('provider-connect-actions').querySelectorAll('ul')).toHaveLength(0)

    // A method this deployment can run stays actionable beside the disabled one.
    expect(screen.getByRole('link', { name: '打开工作台' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '设备码登录' })).toHaveProperty('disabled', false)

    const local = screen.getByRole('button', { name: '已有登录态' })
    expect(local).toHaveProperty('disabled', true)
    const localUnavailable = methodOf(subscription, 'local-session-import')
    expect(local.getAttribute('title')).toBe(localUnavailable.reason)
    expect(screen.queryByText(localUnavailable.reason!)).toBeNull()
  })

  it('starts the declared OpenAI OAuth action instead of opening its API console', () => {
    const product = serverProduct('openai', 'local')
    const onBeginOffering = vi.fn()
    renderProviderPage(product, onBeginOffering)
    fireEvent.click(screen.getByRole('button', { name: '浏览器登录' }))
    expect(onBeginOffering).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'official-subscription' }),
      'authorizationCodeOAuth',
      expect.objectContaining({ id: 'browser-oauth' }),
    )
    expect(screen.queryByText('请在控制台创建 API Key，再返回此处填写；无需等待网页授权。')).toBeNull()
  })

  it('renders no entry at all for an authorization this build has not implemented', () => {
    // Anthropic's subscription offering declares oauth, and no integration binds
    // it. The server omits the entry rather than publishing a disabled button
    // with an internal reason. The official subscription itself stays visible.
    const product = serverProduct('anthropic', 'cloud')
    const subscription = product.offerings.find((offering) => offering.id === 'official-subscription')!
    expect(authorizationMethodsForOffering(subscription)).toEqual([])

    renderProviderPage(product)
    expect(connectActionLabels()).toEqual(['添加 API Key'])
    // Official console navigation is a header link; only API Key is a connection action.
    expect(screen.getByRole('link', { name: '打开工作台' }).getAttribute('href')).toBe(
      product.offerings.find((offering) => offering.authorizationMethods?.some((method) => method.id === 'browser-login'))!.consoleUrl,
    )
    expect(screen.queryByText('此授权方式尚未接入。')).toBeNull()

    cleanup()
    document.body.innerHTML = '<div id="root"></div>'
    renderProviderPage({ ...product, offerings: [subscription] })
    expect(connectActionLabels()).toEqual([])
    expect(screen.getByRole('heading', { name: 'Claude Pro / Max' })).toBeTruthy()
    expect(screen.getByText(/暂不支持订阅接入/u)).toBeTruthy()
    expect(screen.queryByText('此授权方式尚未接入。')).toBeNull()
  })

  it('shows subscription authorization with separate workbench navigation on a local deployment', () => {
    renderProviderPage(serverProduct('openai', 'local'))

    expect(connectActionLabels()).toEqual([
      '浏览器登录',
      '设备码登录',
      '已有登录态',
      '添加 API Key',
    ])
    expect(screen.getByRole('button', { name: '设备码登录' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: '已有登录态' })).toHaveProperty('disabled', false)
  })

  it('keeps console navigation in the header beside a real subscription authorization split', () => {
    // Kimi keeps its real device-code/import actions; its console is navigation.
    renderProviderPage(serverProduct('kimi', 'local'))
    expect(screen.getByRole('link', { name: '打开工作台' })).toBeTruthy()

    expect(connectActionLabels()).toEqual([
      '设备码登录',
      '已有登录态',
      '添加 API Key',
    ])
  })

  it('leaves DeepSeek login-less, Ollama local and custom self-configured', () => {
    renderProviderPage(serverProduct('deepseek', 'cloud'))
    expect(connectActionLabels()).toEqual(['添加 API Key'])
    expect(screen.queryByRole('button', { name: '浏览器登录' })).toBeNull()
    cleanup()
    document.body.innerHTML = '<div id="root"></div>'

    renderProviderPage(serverProduct('ollama', 'local'))
    expect(connectActionLabels()).toEqual(['本地服务'])
    cleanup()
    document.body.innerHTML = '<div id="root"></div>'

    // Custom is configured in Xpod (base URL plus key), not at a provider
    // console, so its declared set is the key entry alone.
    renderProviderPage(serverProduct('custom', 'cloud'))
    expect(connectActionLabels()).toEqual(['添加 API Key'])
    expect(screen.queryByRole('button', { name: '浏览器登录' })).toBeNull()
  })

  it('renders no connect action at all when the offering declares none', () => {
    const product = serverProduct('bailian', 'cloud')
    renderProviderPage({
      ...product,
      offerings: product.offerings.map((offering) => ({
        ...offering,
        authModes: [],
        authorizationMethods: [],
      })),
    })

    expect(connectActionLabels()).toEqual([])
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()
    expect(screen.queryByRole('button', { name: /API Key/u })).toBeNull()
  })

  it('opens the declared workbench as navigation without starting a connection', async () => {
    const provider = 'bailian'
    const product = serverProduct('bailian', 'cloud')
    const beginConnect = vi.fn(async (provider: string, mode: string) => ({
      provider,
      mode,
      status: 'pending' as const,
      attemptId: 'attempt-1',
      state: 'state-1',
      signature: 'signature-1',
      authorizationUrl: 'https://bailian.console.aliyun.com/?xpod_connect_attempt=attempt-1',
    }))
    const openExternal = vi.fn(async () => undefined)
    const client = {
      webId: WEB_ID,
      apiBase: 'https://pod.example',
      getServiceAccess: vi.fn(async () => ({ status: 'granted' })),
      listProviders: vi.fn(async () => []),
      listModels: vi.fn(async () => []),
      beginConnect,
    } as unknown as AiConnectionsClient
    await act(async () => {
      render(
        <AiConnectionsPanel
          client={client}
          selectedProvider={provider}
          providerProducts={{ [provider]: product }}
          openExternal={openExternal}
          renderToaster={false}
        />,
      )
    })

    expect(connectActionLabels()).toEqual(['添加 API Key'])
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()

    const links = screen.getByRole('group', { name: '百炼官方链接' })
    const workbench = within(links).getByRole('link', { name: '打开工作台' })
    expect(workbench.getAttribute('href')).toBe('https://bailian.console.aliyun.com/')
    expect(workbench.getAttribute('target')).toBe('_blank')
    fireEvent.click(workbench)
    expect(beginConnect).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
    expect(screen.queryByText('已连接')).toBeNull()
  })
})
