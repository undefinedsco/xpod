// @vitest-environment jsdom
import './setup-jsdom'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
} from '@undefineds.co/ai-connections-core/client'

/**
 * Guard for the connect entries of a provider page.
 *
 * The page used to carry a provider-level connect label (`browserMode` /
 * `browserLabel` on the definition), which named a provider instead of an
 * action. The capability behind it was real, though: openai, anthropic, kimi,
 * 百炼 and 智谱 open their own console so the user signs in there and mints a key.
 * That entry is now declared where every other action lives - on the offerings
 * that accept a key, in the shared catalog - and reaches the page through
 * `authorizationMethods`. DeepSeek declares none (it has no account console),
 * Ollama is a local service, and custom is configured inside Xpod.
 *
 * The server only publishes entries it can actually run: an oauth/deviceCode
 * mode with no integration binding is omitted outright, while an entry that is
 * merely unavailable in this deployment (cloud without a local callback) stays
 * visible, greyed, with its reason as a tooltip. Nothing is explained in a
 * second row under the buttons.
 *
 * The data is the real server derivation (`providerProductsForDeployment`), not
 * a hand-written fixture: the labels asserted below are the labels the API sends.
 */

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

function renderProviderPage(product: AiProviderSummary) {
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
      onBeginOffering={vi.fn()}
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
  it('offers 百炼 the console login its offerings declare beside the key entry', () => {
    const product = serverProduct('bailian', 'cloud')
    renderProviderPage(product)

    expect(connectActionLabels()).toEqual(['浏览器登录', '添加 API Key'])
    // One console entry for the provider, even though four offerings declare it.
    expect(screen.getAllByRole('button', { name: '浏览器登录' })).toHaveLength(1)
    // The phantom the original bug report was about: a provider-level 「登录」.
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()

    // The label is the offering's own declaration, not a page-level string.
    const declared = authorizationMethodsForOffering(
      product.offerings.find((offering) => offering.id === 'pay-as-you-go')!,
    ).find((method) => method.connectMode === 'browserAssistedApiKey')
    expect(declared?.label).toBe('浏览器登录')
    expect(declared?.lifecycle).toBe('active')
    expect(screen.getByRole('button', { name: '浏览器登录' })).toHaveProperty('disabled', false)
  })

  it('renders a subscription provider from the same data, unavailable entries included', () => {
    const product = serverProduct('openai', 'cloud')
    renderProviderPage(product)

    const subscription = product.offerings.find((offering) => offering.id === 'official-subscription')!
    const declared = authorizationMethodsForOffering(subscription)
    expect(connectActionLabels()).toEqual([...declared.map((method) => method.label), '添加 API Key'])
    // The console entry yields to the subscription's own browser login: one
    // label, one click, whichever entry declares it.
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
    expect(screen.getByRole('button', { name: '设备码登录' })).toHaveProperty('disabled', false)

    const local = screen.getByRole('button', { name: '已有登录态' })
    expect(local).toHaveProperty('disabled', true)
    const localUnavailable = methodOf(subscription, 'local-session-import')
    expect(local.getAttribute('title')).toBe(localUnavailable.reason)
    expect(screen.queryByText(localUnavailable.reason!)).toBeNull()
  })

  it('renders no entry at all for an authorization this build has not implemented', () => {
    // Anthropic's subscription offering declares oauth, and no integration binds
    // it. The server omits the entry rather than publishing a disabled button
    // with an internal reason, so the page shows nothing for it.
    const product = serverProduct('anthropic', 'cloud')
    const subscription = product.offerings.find((offering) => offering.id === 'official-subscription')!
    expect(authorizationMethodsForOffering(subscription)).toEqual([])

    renderProviderPage(product)
    expect(connectActionLabels()).toEqual(['浏览器登录', '添加 API Key'])
    // The console login is the usable way in, so it is actionable - not a
    // disabled entry carrying an implementation-status reason.
    expect(screen.getByRole('button', { name: '浏览器登录' })).toHaveProperty('disabled', false)
    expect(screen.queryByText('此授权方式尚未接入。')).toBeNull()

    cleanup()
    document.body.innerHTML = '<div id="root"></div>'
    renderProviderPage({ ...product, offerings: [subscription] })
    expect(connectActionLabels()).toEqual([])
    expect(screen.queryByText('此授权方式尚未接入。')).toBeNull()
  })

  it('shows the desktop subscription split beside the console login on a local deployment', () => {
    // Local dev is where the subscription binding runs, so the split and the
    // console entry both have to fit without either inventing a label.
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

  it('keeps the console login beside a subscription split that does not claim its label', () => {
    // Kimi's binding has no browser integration, so its split names 设备码登录 /
    // 已有登录态 and the console entry keeps its own name. The page order stays
    // fixed per provider regardless of which offering contributed an entry, so
    // the console entry still leads (see `connectEntryRank`).
    renderProviderPage(serverProduct('kimi', 'local'))

    expect(connectActionLabels()).toEqual([
      '浏览器登录',
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

  it('starts the console flow, not an OAuth start, when the page begins the console login', async () => {
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
          selectedProvider="bailian"
          providerProducts={{ bailian: product }}
          openExternal={openExternal}
          renderToaster={false}
        />,
      )
    })

    expect(connectActionLabels()).toEqual(['浏览器登录', '添加 API Key'])
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '浏览器登录' }))
    await waitFor(() => expect(beginConnect).toHaveBeenCalledWith('bailian', 'browserAssistedApiKey'))
    // The flow hands the user the provider console; it never starts an OAuth
    // authorization on this entry's behalf.
    expect(beginConnect).not.toHaveBeenCalledWith('bailian', 'deviceCodeOAuth', expect.anything())
    expect(beginConnect).not.toHaveBeenCalledWith('bailian', 'authorizationCodeOAuth', expect.anything())
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(
      'https://bailian.console.aliyun.com/?xpod_connect_attempt=attempt-1',
    ))
  })
})
