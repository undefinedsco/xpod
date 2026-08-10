export type PodRuntimeFetch = typeof fetch;

export type PodRuntimeAdapter<Database> = {
  discoverPod(args: {
    webId: string;
    fetch: PodRuntimeFetch;
    signal: AbortSignal;
    isCurrent(): boolean;
  }): Promise<string> | string;
  openDatabase(args: {
    webId: string;
    podUrl: string;
    fetch: PodRuntimeFetch;
    signal: AbortSignal;
    isCurrent(): boolean;
  }): Promise<Database> | Database;
  hydrateCollections(args: {
    webId: string;
    podUrl: string;
    database: Database;
    signal: AbortSignal;
    isCurrent(): boolean;
  }): Promise<void> | void;
};

export type OpenPodRuntime<Database> = {
  readonly webId: string;
  readonly podUrl: string;
  readonly database: Database;
  readonly collections: 'ready';
};

export type CreatePodRuntimeOptions<Database> = {
  adapter: PodRuntimeAdapter<Database>;
};

export type PodRuntimeClearIdentity =
  | string
  | {
    webId: string;
    podUrl?: string;
  };

export type PodRuntime<Database> = {
  open(args: {
    webId: string;
    podUrl?: string;
    fetch: PodRuntimeFetch;
  }): Promise<OpenPodRuntime<Database>>;
  clear(identity?: PodRuntimeClearIdentity): void;
  dispose(): void;
};

type PendingOpen<Database> = {
  generation: number;
  promise: Promise<OpenPodRuntime<Database>>;
  controller: AbortController;
};

const KEY_SEPARATOR = '\u0000';

function normalizeIdentityPart(value: string): string {
  const trimmed = value.trim();
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
}

function normalizePodUrl(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('podUrl must be a non-empty absolute URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new TypeError('podUrl must be a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('podUrl must use http or https');
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new TypeError('podUrl must not contain credentials or a fragment');
  }
  return parsed.href;
}

function compositeKey(webId: string, podUrl: string): string {
  return `${normalizeIdentityPart(webId)}${KEY_SEPARATOR}${normalizeIdentityPart(podUrl)}`;
}

function nextGeneration(generations: Map<string, number>, key: string): number {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  return generation;
}

function createAbortedOpenError(): Error {
  const error = new Error('Pod open aborted because the runtime identity changed');
  error.name = 'AbortError';
  return error;
}

export function createPodRuntime<Database>(
  options: CreatePodRuntimeOptions<Database>,
): PodRuntime<Database> {
  const { adapter } = options;
  // Discovery callers retain the historical WebID cache. Explicit callers
  // always consult the composite cache and never inherit a different Pod.
  const readyByWebId = new Map<string, OpenPodRuntime<Database>>();
  const readyByComposite = new Map<string, OpenPodRuntime<Database>>();
  const pendingByWebId = new Map<string, PendingOpen<Database>>();
  const pendingByComposite = new Map<string, PendingOpen<Database>>();
  const webIdGenerations = new Map<string, number>();
  const compositeGenerations = new Map<string, number>();

  const clearWebId = (webId: string, podUrl?: string) => {
    const webIdKey = normalizeIdentityPart(webId);

    if (podUrl !== undefined) {
      const normalizedPodUrl = normalizePodUrl(podUrl);
      const key = compositeKey(webId, normalizedPodUrl);
      nextGeneration(compositeGenerations, key);
      pendingByComposite.get(key)?.controller.abort();
      pendingByComposite.delete(key);
      readyByComposite.delete(key);

      const discovered = readyByWebId.get(webIdKey);
      if (discovered && compositeKey(discovered.webId, discovered.podUrl) === key) {
        readyByWebId.delete(webIdKey);
      }
      return;
    }

    nextGeneration(webIdGenerations, webIdKey);
    pendingByWebId.get(webIdKey)?.controller.abort();
    pendingByWebId.delete(webIdKey);
    const discovered = readyByWebId.get(webIdKey);
    if (discovered) {
      readyByComposite.delete(compositeKey(discovered.webId, discovered.podUrl));
    }
    readyByWebId.delete(webIdKey);

    // A WebID-wide reset (logout or identity switch) invalidates every
    // explicit selection for that identity, while the podUrl form above
    // remains targeted and cannot abort a sibling Pod.
    const compositePrefix = `${webIdKey}${KEY_SEPARATOR}`;
    for (const key of [...readyByComposite.keys()]) {
      if (key.startsWith(compositePrefix)) {
        readyByComposite.delete(key);
      }
    }
    for (const [key, pendingOpen] of [...pendingByComposite.entries()]) {
      if (key.startsWith(compositePrefix)) {
        nextGeneration(compositeGenerations, key);
        pendingOpen.controller.abort();
        pendingByComposite.delete(key);
      }
    }
  };

  const clear = (identity?: PodRuntimeClearIdentity) => {
    if (!identity) {
      readyByWebId.clear();
      readyByComposite.clear();
      for (const pending of pendingByWebId.values()) {
        pending.controller.abort();
      }
      for (const pending of pendingByComposite.values()) {
        pending.controller.abort();
      }
      pendingByWebId.clear();
      pendingByComposite.clear();
      for (const key of webIdGenerations.keys()) {
        nextGeneration(webIdGenerations, key);
      }
      for (const key of compositeGenerations.keys()) {
        nextGeneration(compositeGenerations, key);
      }
      return;
    }

    if (typeof identity === 'string') {
      clearWebId(identity);
      return;
    }
    clearWebId(identity.webId, identity.podUrl);
  };

  return {
    open(args) {
      const webIdKey = normalizeIdentityPart(args.webId);
      const explicitPodUrl = args.podUrl === undefined ? undefined : normalizePodUrl(args.podUrl);

      if (explicitPodUrl !== undefined) {
        const key = compositeKey(args.webId, explicitPodUrl);
        const cached = readyByComposite.get(key);
        if (cached) {
          return Promise.resolve(cached);
        }

        const pending = pendingByComposite.get(key);
        if (pending) {
          return pending.promise;
        }

        const generation = compositeGenerations.get(key) ?? 0;
        compositeGenerations.set(key, generation);
        const controller = new AbortController();
        const isCurrent = () => (
          !controller.signal.aborted
          && (compositeGenerations.get(key) ?? 0) === generation
        );
        const assertCurrent = () => {
          if (!isCurrent()) {
            throw createAbortedOpenError();
          }
        };
        const promise = openDatabase({
          webId: args.webId,
          podUrl: explicitPodUrl,
          fetch: args.fetch,
          signal: controller.signal,
          isCurrent,
          assertCurrent,
        });
        pendingByComposite.set(key, { generation, promise, controller });
        const removePending = () => {
          const pendingOpen = pendingByComposite.get(key);
          if (pendingOpen?.generation === generation && pendingOpen.promise === promise) {
            pendingByComposite.delete(key);
          }
        };
        promise.then(removePending, removePending);
        return promise;
      }

      const cached = readyByWebId.get(webIdKey);
      if (cached) {
        return Promise.resolve(cached);
      }
      const pending = pendingByWebId.get(webIdKey);
      if (pending) {
        return pending.promise;
      }

      const generation = webIdGenerations.get(webIdKey) ?? 0;
      webIdGenerations.set(webIdKey, generation);
      const controller = new AbortController();
      const isCurrent = () => (
        !controller.signal.aborted
        && (webIdGenerations.get(webIdKey) ?? 0) === generation
      );
      const assertCurrent = () => {
        if (!isCurrent()) {
          throw createAbortedOpenError();
        }
      };
      const promise = (async () => {
        const discoveredPodUrl = await adapter.discoverPod({
          webId: args.webId,
          fetch: args.fetch,
          signal: controller.signal,
          isCurrent,
        });
        assertCurrent();
        return openDatabase({
          webId: args.webId,
          podUrl: normalizePodUrl(discoveredPodUrl),
          fetch: args.fetch,
          signal: controller.signal,
          isCurrent,
          assertCurrent,
          generation,
          webIdKey,
          discovered: true,
        });
      })();

      pendingByWebId.set(webIdKey, { generation, promise, controller });
      const removePending = () => {
        const pendingOpen = pendingByWebId.get(webIdKey);
        if (pendingOpen?.generation === generation && pendingOpen.promise === promise) {
          pendingByWebId.delete(webIdKey);
        }
      };
      promise.then(removePending, removePending);
      return promise;
    },

    clear,

    dispose() {
      clear();
    },
  };

  async function openDatabase(args: {
    webId: string;
    podUrl: string;
    fetch: PodRuntimeFetch;
    signal: AbortSignal;
    isCurrent(): boolean;
    assertCurrent(): void;
    generation?: number;
    webIdKey?: string;
    discovered?: boolean;
  }): Promise<OpenPodRuntime<Database>> {
    const key = compositeKey(args.webId, args.podUrl);
    const existing = readyByComposite.get(key);
    if (existing) {
      if (args.discovered && args.webIdKey && args.isCurrent()) {
        readyByWebId.set(args.webIdKey, existing);
      }
      return existing;
    }

    const database = await adapter.openDatabase({
      webId: args.webId,
      podUrl: args.podUrl,
      fetch: args.fetch,
      signal: args.signal,
      isCurrent: args.isCurrent,
    });
    args.assertCurrent();
    await adapter.hydrateCollections({
      webId: args.webId,
      podUrl: args.podUrl,
      database,
      signal: args.signal,
      isCurrent: args.isCurrent,
    });
    args.assertCurrent();

    const opened: OpenPodRuntime<Database> = {
      webId: args.webId,
      podUrl: args.podUrl,
      database,
      collections: 'ready',
    };
    if (args.isCurrent()) {
      readyByComposite.set(key, opened);
      if (args.discovered && args.webIdKey) {
        readyByWebId.set(args.webIdKey, opened);
      }
    }
    return opened;
  }
}
