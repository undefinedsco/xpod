import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockWebExtensionHost } from '@undefineds.co/extension-sdk/testing'
import { mountTwoPaneApplet } from '@undefineds.co/extension-sdk/web'
import type { SolidNotificationSocket } from './solid-notifications'
import { createSolidNotificationsCapability } from './solid-notifications'
import { aiConnectionApplet, TABLE_CHANGE_COALESCE_MS } from '@undefineds.co/ai-connections'
import { catalogProvider } from '../../../packages/ai-connections/test/fixtures'

/**
 * The real transport primitive under the real page.
 *
 * The manager is driven by a fake socket and a fake fetch - no browser and no
 * server - and the page is the applet's own controller, so this covers the seam
 * the unit suites cannot: a notification, delivered over the socket, causing
 * exactly one re-read through the page's existing loader.
 */

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const POD_URL = 'https://pod.example/alice/'
const CREDENTIALS_DOCUMENT = `${POD_URL}settings/credentials.ttl`
const POD_ORIGIN = 'https://pod.example'
const CHANNEL_URL = `${POD_ORIGIN}/.notifications/WebSocketChannel2023/channel-1`

class FakeSocket implements SolidNotificationSocket {
  readyState = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: { code?: number }) => void) | null = null
  closed: { code?: number; reason?: string } | undefined

  constructor(readonly url: string) {}

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  deliver(): void {
    this.onmessage?.({ data: '{"type":"Update","object":"ignored"}' })
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
    this.readyState = 3
  }
}

afterEach(cleanup)

function createTransport() {
  const sockets: FakeSocket[] = []
  const notificationRequests: Array<{ url: string; method: string }> = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/.notifications/')) {
      const method = init?.method ?? 'GET'
      notificationRequests.push({ url, method })
      if (method === 'POST') {
        return Response.json({
          '@context': ['https://www.w3.org/ns/solid/notification/v1'],
          id: CHANNEL_URL,
          type: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
          topic: JSON.parse(String(init?.body)).topic,
          receiveFrom: CHANNEL_URL.replace('https://', 'wss://'),
        })
      }
      return new Response(null, { status: 205 })
    }
    // Everything else is an ordinary applet read.
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  const capability = createSolidNotificationsCapability({
    fetch: fetchImpl,
    document: null,
    page: null,
    createSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
  })
  return { capability, sockets, notificationRequests }
}

describe('AI Connection live updates over the real channel transport', () => {
  it('re-reads the credentials table once for a burst of socket notifications', async () => {
    const transport = createTransport()
    let name = 'OpenAI'
    const listProviders = vi.fn(async () => [catalogProvider('openai', { name })])
    const mounted = mountTwoPaneApplet(aiConnectionApplet, createMockWebExtensionHost({
      solid: {
        session: {
          fetch: (async () => new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
          getSnapshot: () => ({ status: 'authenticated', webId: WEB_ID }),
          subscribe: () => () => undefined,
        },
        pod: {
          status: 'ready',
          current: { webId: WEB_ID, podUrl: POD_URL, database: { id: 'db' }, collections: 'ready' },
        },
        requireLogin: async () => undefined,
      },
      capabilities: {
        solidNotifications: transport.capability,
        aiConnectionsPodStore: {
          credentialsTableDocument: () => CREDENTIALS_DOCUMENT,
          providerTableDocument: (provider: string) => `${POD_URL}settings/providers/${provider}.ttl`,
          listProviders,
          listModels: vi.fn(async () => []),
        },
      },
    }))
    render(
      <>
        {mounted.list}
        <div data-testid="main-header">{mounted.mainHeader}</div>
        {mounted.main}
      </>,
    )

    // The page opened exactly one channel: for the credentials table it renders.
    await waitFor(() => expect(transport.notificationRequests).toHaveLength(1))
    expect(transport.notificationRequests[0]).toEqual({
      url: `${POD_ORIGIN}/.notifications/WebSocketChannel2023/`,
      method: 'POST',
    })
    expect(transport.sockets).toHaveLength(1)

    // Opening a provider adds that provider's document as a second channel.
    act(() => mounted.controller.selectProvider('openai'))
    await waitFor(() => expect(transport.sockets).toHaveLength(2))
    act(() => transport.sockets.forEach((socket) => socket.open()))
    expect(mounted.controller.liveUpdates).toBe('live')
    await waitFor(() => expect(
      within(screen.getByTestId('main-header')).getByRole('heading', { name: 'OpenAI' }),
    ).toBeTruthy())
    expect(listProviders).toHaveBeenCalledTimes(1)

    // Five writes arrive over the credentials socket: one re-read, not five.
    name = 'OpenAI 刷新后'
    act(() => {
      for (let index = 0; index < 5; index += 1) transport.sockets[0]!.deliver()
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, TABLE_CHANGE_COALESCE_MS + 150)))

    expect(listProviders).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(
      within(screen.getByTestId('main-header')).getByRole('heading', { name: 'OpenAI 刷新后' }),
    ).toBeTruthy())

    // Unmount releases both channels: the server-side subscriptions are deleted.
    cleanup()
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(transport.sockets.every((socket) => socket.closed !== undefined)).toBe(true)
    const methods = transport.notificationRequests.map((request) => request.method)
    expect(methods).toEqual(['POST', 'POST', 'DELETE', 'DELETE'])
  })
})
