import type { PodCollection, PodSyncState, RowOf } from '@undefineds.co/pod-collections';
import type { PodModelDescriptor } from '@undefineds.co/models';
import type {
  PodCollectionsCapability,
  PodCollectionHostRequest,
} from '@undefineds.co/extension-sdk/web';
import type { CreatePodCollectionsCapabilityOptions } from './pod-collections-host';

/**
 * The `podCollections` capability as the settings entry wires it: the collection
 * layer - `@undefineds.co/pod-collections` and the TanStack DB engine under it -
 * is **not** in the page's initial chunk. It arrives through the dynamic import
 * below, the first time a page declares a table (`docs/pod-collections.md` §9-9).
 *
 * Why a front instead of loading the implementation eagerly: the settings entry
 * mounts the AI Connections applet, and only its credentials list needs live
 * collections. The engine cost that chunk ~302 kB raw / ~86 kB gzip before this
 * split; a page that never declares a table must not pay it.
 *
 * The contract is unchanged for consumers: `load()` works whether the engine is
 * already there or still loading, `define()` keeps its synchronous signature -
 * it reports `pod_collections_not_loaded` instead of inventing a collection when
 * called before the engine arrived - and the sync-state subscription is kept
 * here, so a page can subscribe, and be told when the first collection lands,
 * without touching the engine.
 *
 * The implementation itself (`./pod-collections-host`) is the eager module the
 * host tests drive directly; nothing is duplicated here but the forwarding.
 */

export function createLazyPodCollectionsCapability(
  options: CreatePodCollectionsCapabilityOptions,
): PodCollectionsCapability {
  let capability: PodCollectionsCapability | undefined;
  let loading: Promise<PodCollectionsCapability> | undefined;
  let unsubscribeSyncState: (() => void) | undefined;
  let disposed = false;
  const listeners = new Set<() => void>();

  /** The loaded implementation, or a clear report that it is not there yet. */
  const loaded = (operation: string): PodCollectionsCapability => {
    if (!capability) {
      throw new Error(
        `pod_collections_not_loaded: ${operation}() needs the collection engine; `
        + 'use load() so the host can fetch it first',
      );
    }
    return capability;
  };

  const loadCapability = (): Promise<PodCollectionsCapability> => {
    loading ??= import('./pod-collections-host').then((module) => {
      const next = module.createPodCollectionsCapability(options);
      if (disposed) {
        next.dispose();
        return next;
      }
      capability = next;
      // A page subscribes before the engine exists; it must not miss the first
      // state transition because of the order it got here in.
      unsubscribeSyncState = next.subscribeSyncState(() => {
        for (const listener of [...listeners]) listener();
      });
      return next;
    });
    return loading;
  };

  return {
    define<D extends PodModelDescriptor>(
      descriptor: D,
      request: PodCollectionHostRequest<D>,
    ): PodCollection<RowOf<D>> {
      return loaded('define').define(descriptor, request);
    },

    async load<D extends PodModelDescriptor>(
      descriptor: D,
      request: PodCollectionHostRequest<D>,
    ): Promise<PodCollection<RowOf<D>>> {
      const engine = await loadCapability();
      return engine.define(descriptor, request);
    },

    syncState<R extends { id: string }>(collection: PodCollection<R>): PodSyncState {
      return loaded('syncState').syncState(collection);
    },

    subscribeSyncState(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose(): void {
      disposed = true;
      unsubscribeSyncState?.();
      unsubscribeSyncState = undefined;
      listeners.clear();
      capability?.dispose();
      capability = undefined;
    },
  };
}
