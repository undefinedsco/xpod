import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import type { PodModelDescriptor } from '@undefineds.co/models';
import {
  definePodCollection,
  podCollectionInternals,
  resolveTableDocument,
  type PodCollection,
  type PodDocumentFeed,
  type PodSyncState,
  type RowOf,
} from '@undefineds.co/pod-collections';
import type {
  PodCollectionHostRequest,
  PodCollectionsCapability,
} from '@undefineds.co/extension-sdk/web';

/**
 * Host side of the `podCollections` capability (`docs/pod-collections.md` §6.4).
 *
 * The applet declares a table from its models descriptor; this capability owns
 * everything the applet must not own: which database reads it, which Pod it
 * belongs to, and which transport tells it the document changed. The feed is the
 * session's notification primitive - `createSolidNotificationsCapability(...)` -
 * reused as-is, so a collection and a page subscription for the same document
 * share one channel instead of opening a second websocket path.
 *
 * Collections are cached per `(descriptor.uri, document)`: one table document is
 * one collection, and two pages of one applet that declare the same table share
 * one sync engine rather than racing two. A table whose document the descriptor
 * cannot derive throws `layout_document_required` from `resolveTableDocument`:
 * the layout is never guessed, here least of all.
 */

/** The dirty-signal port, plus the state source a session transport already has. */
export interface PodCollectionFeed extends PodDocumentFeed {
  /** Present on `SolidNotificationsCapability`: lets sync state be observed. */
  subscribeState?(listener: (state: unknown) => void): () => void;
}

export interface CreatePodCollectionsCapabilityOptions {
  database: SolidDatabase;
  podUrl: string;
  /** Left out (rather than passed as `null`) when the session cannot subscribe. */
  feed?: PodCollectionFeed;
}

export function createPodCollectionsCapability(
  options: CreatePodCollectionsCapabilityOptions,
): PodCollectionsCapability {
  const cache = new Map<string, PodCollection<{ id: string }>>();
  const syncStateListeners = new Set<() => void>();
  let unsubscribeFeedState: (() => void) | undefined;

  const publishSyncState = (): void => {
    for (const listener of [...syncStateListeners]) listener();
  };

  const cacheKeyOf = (descriptor: PodModelDescriptor, document: string): string =>
    `${descriptor.uri}\u0000${document}`;

  /** The one declaration path: both `define` and `load` go through it. */
  const define = <D extends PodModelDescriptor>(
    descriptor: D,
    request: PodCollectionHostRequest<D>,
  ): PodCollection<RowOf<D>> => {
    // Resolved before the cache lookup so the key is the document the table
    // actually lives in; an underivable layout throws here, by design.
    const document = resolveTableDocument(descriptor, {
      podUrl: options.podUrl,
      document: request.document,
      scope: request.scope,
    });
    const key = cacheKeyOf(descriptor, document);
    const cached = cache.get(key);
    if (cached) return cached as unknown as PodCollection<RowOf<D>>;
    const collection = definePodCollection(descriptor, {
      ...request,
      database: options.database,
      podUrl: options.podUrl,
      feed: options.feed,
    });
    cache.set(key, collection as unknown as PodCollection<{ id: string }>);
    // The first read is what moves `initializing` to live/unavailable/degraded;
    // `preload()` is also what the sync engine awaits, so this observes the
    // transition instead of polling for it. A failed first read is already
    // reported through `syncState`, hence the swallowed rejection.
    void collection.preload().then(publishSyncState, publishSyncState);
    return collection;
  };

  return {
    define,

    /**
     * The same table, for a page that cannot assume this module is loaded yet
     * (`docs/pod-collections.md` §9-9). This implementation already has the
     * engine, so it answers through the identical synchronous path.
     */
    async load<D extends PodModelDescriptor>(
      descriptor: D,
      request: PodCollectionHostRequest<D>,
    ): Promise<PodCollection<RowOf<D>>> {
      return define(descriptor, request);
    },

    syncState<R extends { id: string }>(collection: PodCollection<R>): PodSyncState {
      return podCollectionInternals(collection).syncState();
    },

    subscribeSyncState(listener: () => void): () => void {
      syncStateListeners.add(listener);
      if (syncStateListeners.size === 1 && typeof options.feed?.subscribeState === 'function') {
        unsubscribeFeedState = options.feed.subscribeState(publishSyncState);
      }
      return () => {
        syncStateListeners.delete(listener);
        if (syncStateListeners.size === 0) {
          unsubscribeFeedState?.();
          unsubscribeFeedState = undefined;
        }
      };
    },

    dispose(): void {
      for (const collection of cache.values()) podCollectionInternals(collection).dispose();
      cache.clear();
      unsubscribeFeedState?.();
      unsubscribeFeedState = undefined;
      publishSyncState();
    },
  };
}
