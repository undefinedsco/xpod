import { credentialDescriptor, credentialResource } from '@undefineds.co/models'
import type { SolidDatabase } from '@undefineds.co/drizzle-solid'
import type { PodCollection } from '@undefineds.co/pod-collections'
import { describe, expect, it } from 'vitest'
import { createLazyPodCollectionsCapability } from './pod-collections-lazy-host'
import type { PodCollectionFeed } from './pod-collections-host'

/**
 * The deferred `podCollections` capability (`docs/pod-collections.md` §9-9).
 *
 * The host tests next door drive the eager implementation; these are about the
 * front that keeps it - and the collection engine under it - out of the page's
 * initial chunk: nothing is created until a page asks, the reservation is
 * reported meanwhile, and every other part of the contract still answers.
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
  const feed: PodCollectionFeed = {
    watch(_topicUrl, listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscribeState: () => () => undefined,
  }
  return { feed, activeWatchers: () => listeners.size }
}

function capability(feed?: PodCollectionFeed) {
  return createLazyPodCollectionsCapability({
    database: emptyDatabase(),
    podUrl: POD_URL,
    feed,
  })
}

describe('deferred pod collections host capability', () => {
  it('reports the reservation instead of inventing a collection before the engine is loaded', () => {
    const collections = capability()
    expect(() => collections.define(credentialDescriptor, { table: credentialResource }))
      .toThrowError(/pod_collections_not_loaded/)
    expect(() => collections.syncState({ id: 'c' } as unknown as PodCollection<{ id: string }>))
      .toThrowError(/pod_collections_not_loaded/)
  })

  it('loads the engine on first use and keeps one collection per table document', async () => {
    const collections = capability()
    const first = await collections.load(credentialDescriptor, { table: credentialResource })
    expect(first.tableDocument).toBe(`${POD_URL}settings/credentials.ttl`)

    // After the load the synchronous path works again, and both accessors hand
    // out the one collection for this table document.
    expect(collections.define(credentialDescriptor, { table: credentialResource })).toBe(first)
    expect(await collections.load(credentialDescriptor, { table: credentialResource })).toBe(first)
  })

  it('forwards sync state, including transitions that start before the engine lands', async () => {
    const collections = capability()
    const seen: Array<string | undefined> = []
    let collection: PodCollection<{ id: string }> | undefined
    // Subscribed before the engine exists: the first transition must not be lost.
    collections.subscribeSyncState(() => {
      seen.push(collection ? collections.syncState(collection) : undefined)
    })

    collection = await collections.load(credentialDescriptor, { table: credentialResource })
    expect(collections.syncState(collection)).toBe('initializing')
    await collection.preload()
    expect(collections.syncState(collection)).toBe('unavailable')
    expect(seen).toContain('unavailable')
  })

  it('releases a collection it created when it is disposed', async () => {
    const fake = fakeFeed()
    const collections = capability(fake.feed)
    await collections.load(credentialDescriptor, { table: credentialResource })
    expect(fake.activeWatchers()).toBe(1)

    collections.dispose()
    expect(fake.activeWatchers()).toBe(0)
  })
})
