// @vitest-environment jsdom
import './setup-jsdom'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createMockWebExtensionHost } from '@undefineds.co/extension-sdk/testing'
import type { PodCollectionsCapability, WebExtensionSolidCapability } from '@undefineds.co/extension-sdk/web'
import { mountTwoPaneApplet } from '@undefineds.co/extension-sdk/web'
import { aiConnectionApplet } from '../src'
import {
  CREDENTIALS_DOCUMENT,
  POD_URL,
  WEB_ID,
  createCredentialCollectionFixture,
  credentialDocumentRow,
  credentialSummary,
} from './credential-collection-fixture'
import { fakeNotifications } from './fake-notifications'
import { catalogProvider } from './fixtures'

/**
 * The credentials list as a live collection (docs/pod-collections.md §8.4-3).
 *
 * The page, the controller and the collection are the real ones; only the Pod
 * database, the notification socket and the Pod store are fakes, so a write that
 * the collection would fail to confirm fails here too. Every assertion is about
 * what the page shows, not about what the layer claims.
 */

const providerDocument = (provider: string) => `${POD_URL}settings/providers/${provider}.ttl`
const CREDENTIAL_KEY = 'openai-1'
const CREDENTIAL_ID = `credentials.ttl#${CREDENTIAL_KEY}`

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

function renderPilot(options: {
  notifications: ReturnType<typeof fakeNotifications>
  fixture: ReturnType<typeof createCredentialCollectionFixture>
  withCollections?: boolean
  /** Overrides the fixture's capability (a deferred or failing collection layer). */
  capability?: PodCollectionsCapability
}) {
  const mounted = mountTwoPaneApplet(aiConnectionApplet, createMockWebExtensionHost({
    solid: readySolid(),
    capabilities: {
      solidNotifications: options.notifications.capability,
      aiConnectionsPodStore: options.fixture.store,
      ...(options.withCollections === false
        ? {}
        : { podCollections: options.capability ?? options.fixture.capability }),
    },
  }))
  const rendered = render(
    <>
      {mounted.list}
      <div data-testid="main-header">{mounted.mainHeader}</div>
      {mounted.main}
    </>,
  )
  return { ...rendered, controller: mounted.controller }
}

/** A fixture whose document and store summary disagree on a projected field. */
function pilotFixture() {
  return createCredentialCollectionFixture({
    rows: { [CREDENTIAL_KEY]: credentialDocumentRow({ label: 'Live label', accountLabel: 'Live label' }) },
    products: [catalogProvider('openai', {
      status: 'configured',
      credentials: [credentialSummary({ label: 'Store label' })],
    })],
  })
}

function credentialRowElement(label: string): HTMLElement {
  const element = screen.getByText(label).closest('[data-credential-state]')
  if (!(element instanceof HTMLElement)) throw new Error(`no credential row for ${label}`)
  return element
}

async function openProvider(view: ReturnType<typeof renderPilot>, provider = 'openai') {
  act(() => view.controller.selectProvider(provider))
  await waitFor(() => expect(
    within(screen.getByTestId('main-header')).getByRole('heading', { name: 'OpenAI' }),
  ).toBeTruthy())
  await waitFor(() => expect(screen.queryByLabelText('凭据列表')).toBeTruthy())
}

describe('AI Connection credentials as a live collection', () => {
  it('renders the credentials list from the collection rows and owns the table alone', async () => {
    const notifications = fakeNotifications()
    const fixture = pilotFixture()
    const view = renderPilot({ notifications, fixture })
    await openProvider(view)

    // The row the page renders is the document's, not the store's stale summary.
    await waitFor(() => expect(screen.getByText('Live label')).toBeTruthy())
    expect(screen.queryByText('Store label')).toBeNull()

    // One table, one refresh path: the collection watches the credentials
    // document, and the controller's live-revision watch does not.
    expect(notifications.topics()).toEqual([providerDocument('openai')])
    expect(fixture.calls.select).toBeGreaterThan(0)
    expect(view.controller.credentialsCollection).toBe(fixture.collection())

    // The availability signal is the collection's own sync state.
    expect(view.controller.liveUpdates).toBe('idle')
    act(() => notifications.report('live'))
    await waitFor(() => expect(view.controller.liveUpdates).toBe('live'))
  })

  it('shows a created credential immediately, completes it through the store, and survives the echo', async () => {
    const notifications = fakeNotifications()
    const fixture = pilotFixture()
    const view = renderPilot({ notifications, fixture })
    await openProvider(view)
    await waitFor(() => expect(screen.getByText('Live label')).toBeTruthy())

    fixture.holdWrites()
    let created: Promise<unknown>
    act(() => {
      created = view.controller.client!.createApiKeyCredential('openai', {
        apiKey: 'sk-live',
        label: 'Fresh key',
      })
    })

    // Visible while the write is still in flight: that is the optimistic row.
    await waitFor(() => expect(screen.getByText('Fresh key')).toBeTruthy())
    expect(fixture.documentRow(CREDENTIAL_KEY)).toBeTruthy()

    fixture.releaseWrites()
    await act(async () => {
      await created
    })

    // The store wrote the complete row - secret envelope, offering, metadata -
    // at the id the collection created.
    const [storeCreate] = fixture.calls.storeCreate
    expect(storeCreate?.provider).toBe('openai')
    // Exactly one row: the collection created it, and the store completed that
    // same row instead of inserting a second one.
    expect(fixture.calls.insert).toHaveLength(1)
    const createdResourceId = String(fixture.calls.insert[0]?.values?.id)
    expect(storeCreate?.input.id).toBe(createdResourceId)
    const createdKey = createdResourceId.split('#')[1]!
    expect(storeCreate?.input.apiKey).toBe('sk-live')
    expect(fixture.documentRow(createdKey)?.encryptedSecret).toBeTruthy()
    expect(fixture.documentRow(createdKey)?.offeringId).toBeTruthy()

    // Our own echo: the document re-read produces the same projection, so the
    // page must not replace the row (same element, same collection row) and the
    // sync must write nothing.
    const element = screen.getByText('Fresh key')
    const rowBefore = fixture.collection()!.get(createdKey)
    const writesBefore = fixture.calls.updateById.length + fixture.calls.insert.length
    fixture.signal(3)
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)))

    expect(screen.getByText('Fresh key')).toBe(element)
    expect(fixture.collection()!.get(createdKey)).toBe(rowBefore)
    expect(fixture.calls.updateById.length + fixture.calls.insert.length).toBe(writesBefore)
  })

  it('toggles through the page immediately and rolls back when the server rejects it', async () => {
    const notifications = fakeNotifications()
    const fixture = pilotFixture()
    const view = renderPilot({ notifications, fixture })
    await openProvider(view)
    await waitFor(() => expect(credentialRowElement('Live label').getAttribute('data-credential-state')).toBe('enabled'))

    fixture.holdWrites()
    fireEvent.click(screen.getByRole('button', { name: '停用 Live label' }))
    await waitFor(() => expect(credentialRowElement('Live label').getAttribute('data-credential-state')).toBe('disabled'))

    // The collection wrote the descriptor's own field.
    expect(fixture.calls.updateById.some((call) => call.changes?.status === 'disabled')).toBe(true)
    expect(fixture.documentRow(CREDENTIAL_KEY)?.status).not.toBe('disabled')

    fixture.failNextWrite(new Error('server rejected'))
    fixture.releaseWrites()

    await waitFor(() => expect(credentialRowElement('Live label').getAttribute('data-credential-state')).toBe('enabled'))
    expect(screen.getByRole('button', { name: '停用 Live label' })).toBeTruthy()
  })

  it('deletes immediately and puts the row back when the server rejects it', async () => {
    const notifications = fakeNotifications()
    const fixture = pilotFixture()
    const view = renderPilot({ notifications, fixture })
    await openProvider(view)
    await waitFor(() => expect(screen.getByText('Live label')).toBeTruthy())

    fixture.holdWrites()
    let deletion: Promise<unknown>
    act(() => {
      deletion = view.controller.client!.deleteProviderCredential('openai', CREDENTIAL_ID)
    })
    await waitFor(() => expect(screen.queryByText('Live label')).toBeNull())

    fixture.failNextWrite(new Error('server rejected'))
    fixture.releaseWrites()
    await act(async () => {
      await expect(deletion).rejects.toThrow()
    })

    await waitFor(() => expect(screen.getByText('Live label')).toBeTruthy())
    expect(fixture.documentRow(CREDENTIAL_KEY)).toBeTruthy()
  })

  it('degrades to the store’s own read when the host offers no collection', async () => {
    const notifications = fakeNotifications()
    const fixture = pilotFixture()
    let name = 'Store label'
    let providerReads = 0
    fixture.store.listProviders = async () => {
      providerReads += 1
      return [catalogProvider('openai', {
        status: 'configured',
        credentials: [credentialSummary({ label: name })],
      })]
    }
    const view = renderPilot({ notifications, fixture, withCollections: false })
    await openProvider(view)

    // No collection was declared, so the credentials table stays on the
    // controller's watch and the page renders the store's summary.
    expect(view.controller.credentialsCollection).toBeUndefined()
    expect(notifications.topics()).toEqual([
      CREDENTIALS_DOCUMENT,
      providerDocument('openai'),
    ])
    await waitFor(() => expect(screen.getByText('Store label')).toBeTruthy())

    // And it still refreshes the old way: one coalesced re-read per burst.
    const readsBefore = providerReads
    name = 'Store label after echo'
    notifications.signal(CREDENTIALS_DOCUMENT, 4)
    await waitFor(() => expect(screen.getByText('Store label after echo')).toBeTruthy())
    expect(providerReads).toBe(readsBefore + 1)
  })

  it('renders the store’s own read while the collection layer is still loading, then upgrades', async () => {
    const notifications = fakeNotifications()
    const fixture = pilotFixture()
    let releaseLoad!: () => void
    const loading = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    // The layer is on its way but has not arrived: the applet must behave like a
    // host without the capability until it does (docs/pod-collections.md §9-9).
    const deferred: PodCollectionsCapability = {
      ...fixture.capability,
      async load(descriptor, request) {
        await loading
        return fixture.capability.define(descriptor, request)
      },
    }
    const view = renderPilot({ notifications, fixture, capability: deferred })
    await openProvider(view)

    await waitFor(() => expect(screen.getByText('Store label')).toBeTruthy())
    expect(view.controller.credentialsCollection).toBeUndefined()
    expect(view.controller.credentialRows).toBeUndefined()
    // The credentials table is still on the controller's watch: one table, one
    // refresh path.
    expect(notifications.topics()).toEqual([
      CREDENTIALS_DOCUMENT,
      providerDocument('openai'),
    ])

    releaseLoad()
    await waitFor(() => expect(screen.getByText('Live label')).toBeTruthy())
    expect(view.controller.credentialsCollection).toBe(fixture.collection())
    // The collection owns the table now, so the fallback watch is released.
    await waitFor(() => expect(notifications.topics()).toEqual([providerDocument('openai')]))
  })

  it('keeps the store’s own read when the collection layer cannot be loaded at all', async () => {
    const notifications = fakeNotifications()
    const fixture = pilotFixture()
    const unavailable: PodCollectionsCapability = {
      ...fixture.capability,
      async load() {
        throw new Error('chunk unavailable')
      },
    }
    const view = renderPilot({ notifications, fixture, capability: unavailable })
    await openProvider(view)

    await waitFor(() => expect(screen.getByText('Store label')).toBeTruthy())
    expect(view.controller.credentialsCollection).toBeUndefined()
    expect(notifications.topics()).toEqual([
      CREDENTIALS_DOCUMENT,
      providerDocument('openai'),
    ])
  })
})
