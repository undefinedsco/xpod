// @vitest-environment jsdom
import './setup-jsdom'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockWebExtensionHost } from '@undefineds.co/extension-sdk/testing'
import { mountTwoPaneApplet } from '@undefineds.co/extension-sdk/web'
import type { WebExtensionSolidCapability } from '@undefineds.co/extension-sdk/web'
import { aiConnectionApplet, TABLE_CHANGE_COALESCE_MS } from '../src'
import { fakeNotifications } from './fake-notifications'
import { catalogProvider } from './fixtures'

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const POD_URL = 'https://pod.example/alice/'
const CREDENTIALS_DOCUMENT = `${POD_URL}settings/credentials.ttl`
const providerDocument = (provider: string) => `${POD_URL}settings/providers/${provider}.ttl`

afterEach(cleanup)

function readySolid(): WebExtensionSolidCapability {
  return {
    session: {
      fetch: async () => new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      getSnapshot: () => ({ status: 'authenticated', webId: WEB_ID }),
      subscribe: () => () => undefined,
    },
    pod: {
      status: 'ready',
      current: { webId: WEB_ID, podUrl: POD_URL, database: { id: 'db' }, collections: 'ready' },
    },
    requireLogin: async () => undefined,
  }
}

function renderApplet(options: {
  notifications: ReturnType<typeof fakeNotifications>
  store: Record<string, unknown>
}) {
  const mounted = mountTwoPaneApplet(aiConnectionApplet, createMockWebExtensionHost({
    solid: readySolid(),
    capabilities: {
      solidNotifications: options.notifications.capability,
      aiConnectionsPodStore: {
        credentialsTableDocument: () => CREDENTIALS_DOCUMENT,
        providerTableDocument: (provider: string) => providerDocument(provider),
        ...options.store,
      },
    },
  }))
  const rendered = render(
    <>
      {mounted.listHeader}
      {mounted.list}
      <div data-testid="main-header">{mounted.mainHeader}</div>
      {mounted.main}
    </>,
  )
  return { ...rendered, controller: mounted.controller }
}

/** Past the coalescing window, so a scheduled re-read has happened. */
const afterCoalesce = () => new Promise((resolve) => setTimeout(resolve, TABLE_CHANGE_COALESCE_MS + 120))

describe('AI Connection live Pod updates', () => {
  it('watches the credentials table and the open provider document, never rows', async () => {
    const notifications = fakeNotifications()
    const listProviders = vi.fn(async () => [catalogProvider('openai')])
    const view = renderApplet({ notifications, store: { listProviders, listModels: vi.fn(async () => []) } })

    // The API KEYS page renders the credentials table only.
    await waitFor(() => expect(notifications.topics()).toEqual([CREDENTIALS_DOCUMENT]))

    act(() => view.controller.selectProvider('openai'))
    await waitFor(() => expect(notifications.topics()).toEqual([
      CREDENTIALS_DOCUMENT,
      providerDocument('openai'),
    ]))
    // Two documents, two channels, and no subscription ever names a row.
    expect(notifications.subscriberCount()).toBe(2)
    expect(notifications.watchCalls.every((topic) => topic.endsWith('.ttl'))).toBe(true)
  })

  it('keeps the credentials subscription when the open provider changes', async () => {
    const notifications = fakeNotifications()
    const view = renderApplet({
      notifications,
      store: { listProviders: vi.fn(async () => [catalogProvider('openai')]), listModels: vi.fn(async () => []) },
    })
    act(() => view.controller.selectProvider('openai'))
    await waitFor(() => expect(notifications.topics()).toContain(providerDocument('openai')))

    act(() => view.controller.selectProvider('anthropic'))
    await waitFor(() => expect(notifications.topics()).toEqual([
      CREDENTIALS_DOCUMENT,
      providerDocument('anthropic'),
    ]))

    // Only the provider document churned; the shared credentials channel did not.
    expect(notifications.releaseCalls).toEqual([providerDocument('openai')])
    expect(notifications.subscriberCount()).toBe(2)
  })

  it('re-reads once for a burst of writes and re-renders the page', async () => {
    const notifications = fakeNotifications()
    let name = 'OpenAI'
    const listProviders = vi.fn(async () => [catalogProvider('openai', { name })])
    const view = renderApplet({ notifications, store: { listProviders, listModels: vi.fn(async () => []) } })

    act(() => view.controller.selectProvider('openai'))
    await waitFor(() => expect(
      within(screen.getByTestId('main-header')).getByRole('heading', { name: 'OpenAI' }),
    ).toBeTruthy())
    expect(listProviders).toHaveBeenCalledTimes(1)

    // Ten writes across both watched documents: one burst, one re-read.
    name = 'OpenAI 刷新后'
    notifications.signal(CREDENTIALS_DOCUMENT, 5)
    notifications.signal(providerDocument('openai'), 5)
    await act(afterCoalesce)

    expect(listProviders).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(
      within(screen.getByTestId('main-header')).getByRole('heading', { name: 'OpenAI 刷新后' }),
    ).toBeTruthy())

    // Nothing polls: an idle window costs no further read.
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)))
    expect(listProviders).toHaveBeenCalledTimes(2)
  })

  it('shows whether live updates are on, and keeps the page usable when they are not', async () => {
    const notifications = fakeNotifications('idle')
    const listProviders = vi.fn(async () => [catalogProvider('openai')])
    const view = renderApplet({ notifications, store: { listProviders, listModels: vi.fn(async () => []) } })

    await waitFor(() => expect(listProviders).toHaveBeenCalled())
    const header = screen.getByTestId('main-header')
    // Nothing to say while no channel is open.
    expect(header.querySelector('[data-live-updates]')).toBeNull()

    act(() => notifications.report('live'))
    await waitFor(() => expect(
      header.querySelector('[data-live-updates]')?.getAttribute('data-live-updates'),
    ).toBe('live'))

    // A failed subscribe keeps the page working and says so instead of throwing.
    act(() => notifications.report('unavailable'))
    await waitFor(() => expect(
      header.querySelector('[data-live-updates]')?.getAttribute('data-live-updates'),
    ).toBe('unavailable'))
    expect(within(header).getByRole('heading', { name: 'API KEYS' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建 API Key' })).toBeTruthy()

    // Leaving the page leaves no subscription behind.
    view.unmount()
    await waitFor(() => expect(notifications.subscriberCount()).toBe(0))
    expect(notifications.releaseCalls).toEqual([CREDENTIALS_DOCUMENT])
  })

  it('survives a host that offers no live-update capability at all', async () => {
    const mounted = mountTwoPaneApplet(aiConnectionApplet, createMockWebExtensionHost({
      solid: readySolid(),
      capabilities: {
        aiConnectionsPodStore: {
          listProviders: vi.fn(async () => [catalogProvider('openai')]),
          listModels: vi.fn(async () => []),
        },
      },
    }))
    render(<>{mounted.list}{mounted.main}</>)

    // The page reads and renders normally; it just cannot promise live updates.
    await waitFor(() => expect(mounted.controller.liveUpdates).toBe('unavailable'))
    expect(mounted.controller.liveRevision).toBe(0)
  })
})
