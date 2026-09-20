import { credentialDescriptor, credentialResource } from '@undefineds.co/models'
import { PodCollectionError } from '@undefineds.co/pod-collections'
import type { PodModelDescriptor } from '@undefineds.co/models'
import type { SolidDatabase } from '@undefineds.co/drizzle-solid'
import { describe, expect, it } from 'vitest'
import { createPodCollectionsCapability } from './pod-collections-host'
import type { PodCollectionFeed } from './pod-collections-host'

/**
 * The host capability that turns an applet's table declaration into a live
 * collection (docs/pod-collections.md §6.4-1/2).
 *
 * The fake database returns an empty document, which is all these tests need:
 * they are about the wiring the host owns - one collection per table document,
 * a resolved document, a refusal to guess a layout, the sync-state signal, and
 * teardown - not about read or write behaviour, which the package's own suite
 * covers.
 */

const POD_URL = 'https://pod.example/alice/'

function emptyDatabase(): SolidDatabase {
  return {
    async init() {},
    select: () => ({ from: () => ({ execute: async () => [] }) }),
  } as unknown as SolidDatabase
}

function fakeFeed() {
  const listeners = new Set<(signal: { topic: string }) => void>()
  const stateListeners = new Set<(state: unknown) => void>()
  const watched: string[] = []
  const feed: PodCollectionFeed = {
    watch(topicUrl, listener) {
      watched.push(topicUrl)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscribeState(listener) {
      stateListeners.add(listener)
      return () => {
        stateListeners.delete(listener)
      }
    },
  }
  return {
    feed,
    watched,
    activeWatchers: () => listeners.size,
    emitState: () => {
      for (const listener of [...stateListeners]) listener('live')
    },
  }
}

function capability(feed?: PodCollectionFeed) {
  return createPodCollectionsCapability({
    database: emptyDatabase(),
    podUrl: POD_URL,
    feed,
  })
}

describe('pod collections host capability', () => {
  it('keeps one collection per descriptor and document', () => {
    const collections = capability()
    const first = collections.define(credentialDescriptor, { table: credentialResource })
    expect(first.tableDocument).toBe(`${POD_URL}settings/credentials.ttl`)

    // Same table, same document: the page gets the instance it already has,
    // instead of a second sync engine over the same rows.
    expect(collections.define(credentialDescriptor, { table: credentialResource })).toBe(first)

    // An explicit document is a different table document, hence a different one.
    const other = collections.define(credentialDescriptor, {
      table: credentialResource,
      document: `${POD_URL}settings/other.ttl`,
    })
    expect(other).not.toBe(first)
    expect(other.tableDocument).toBe(`${POD_URL}settings/other.ttl`)
  })

  it('refuses to guess the document of a table it cannot derive', () => {
    const collections = capability()
    const acrossDocuments = {
      ...credentialDescriptor,
      storage: { base: '/settings/providers/', resourceIdPattern: '{isProvidedBy.doc}#{key}' },
    } as PodModelDescriptor

    // Never guessed: the caller passes `document` (or `scope`) instead.
    let thrown: unknown
    try {
      collections.define(acrossDocuments, { table: credentialResource })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PodCollectionError)
    expect((thrown as PodCollectionError).code).toBe('layout_document_required')

    const scoped = collections.define(acrossDocuments, {
      table: credentialResource,
      document: `${POD_URL}settings/providers/openai.ttl`,
    })
    expect(scoped.tableDocument).toBe(`${POD_URL}settings/providers/openai.ttl`)
  })

  it('reports sync state as the availability signal and notifies on change', async () => {
    const fake = fakeFeed()
    const collections = capability(fake.feed)
    const states: string[] = []
    collections.subscribeSyncState(() => {
      states.push(collections.syncState(collection))
    })

    const collection = collections.define(credentialDescriptor, { table: credentialResource })
    expect(collections.syncState(collection)).toBe('initializing')
    expect(fake.watched).toEqual([`${POD_URL}settings/credentials.ttl`])

    // The first read is what makes the table live; the subscription sees it
    // without polling for it.
    await collection.preload()
    expect(collections.syncState(collection)).toBe('live')
    expect(states).toContain('live')

    // A transport transition re-checks the collection's own state.
    const before = states.length
    fake.emitState()
    expect(states.length).toBeGreaterThan(before)
  })

  it('releases every collection it created', () => {
    const fake = fakeFeed()
    const collections = capability(fake.feed)
    collections.define(credentialDescriptor, { table: credentialResource })
    expect(fake.activeWatchers()).toBe(1)

    collections.dispose()
    expect(fake.activeWatchers()).toBe(0)
  })
})
