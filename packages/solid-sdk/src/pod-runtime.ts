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

function compositeKey(webId: string, podUrl: string): string {
  return `${normalizeIdentityPart(webId)}${KEY_SEPARATOR}${normalizeIdentityPart(podUrl)}`;
}

function nextGeneration(generations: Map<string, number>, webIdKey: string): number {
  const generation = (generations.get(webIdKey) ?? 0) + 1;
  generations.set(webIdKey, generation);
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
  const readyByWebId = new Map<string, OpenPodRuntime<Database>>();
  const readyByComposite = new Map<string, OpenPodRuntime<Database>>();
  const pendingByWebId = new Map<string, PendingOpen<Database>>();
  const generations = new Map<string, number>();

  const clear = (identity?: PodRuntimeClearIdentity) => {
    if (!identity) {
      readyByWebId.clear();
      readyByComposite.clear();
      for (const pending of pendingByWebId.values()) {
        pending.controller.abort();
      }
      pendingByWebId.clear();
      for (const webIdKey of generations.keys()) {
        nextGeneration(generations, webIdKey);
      }
      return;
    }

    if (typeof identity === 'string') {
      clearWebId(identity);
      return;
    }

    clearWebId(identity.webId, identity.podUrl);
  };

  const clearWebId = (webId: string, podUrl?: string) => {
    const webIdKey = normalizeIdentityPart(webId);
    nextGeneration(generations, webIdKey);
    pendingByWebId.get(webIdKey)?.controller.abort();
    pendingByWebId.delete(webIdKey);

    if (podUrl) {
      const key = compositeKey(webId, podUrl);
      readyByComposite.delete(key);
      if (normalizeIdentityPart(readyByWebId.get(webIdKey)?.podUrl ?? '') === normalizeIdentityPart(podUrl)) {
        readyByWebId.delete(webIdKey);
      }
      return;
    }

    const existing = readyByWebId.get(webIdKey);
    if (existing) {
      readyByComposite.delete(compositeKey(existing.webId, existing.podUrl));
    }
    readyByWebId.delete(webIdKey);
  };

  return {
    open(args) {
      const webIdKey = normalizeIdentityPart(args.webId);
      const cached = readyByWebId.get(webIdKey);
      if (cached) {
        return Promise.resolve(cached);
      }

      const pending = pendingByWebId.get(webIdKey);
      if (pending) {
        return pending.promise;
      }

      const generation = generations.get(webIdKey) ?? 0;
      generations.set(webIdKey, generation);
      const controller = new AbortController();
      const isCurrent = () => !controller.signal.aborted && (generations.get(webIdKey) ?? 0) === generation;
      const assertCurrent = () => {
        if (!isCurrent()) {
          throw createAbortedOpenError();
        }
      };
      const promise = (async () => {
        const podUrl = await adapter.discoverPod({
          webId: args.webId,
          fetch: args.fetch,
          signal: controller.signal,
          isCurrent,
        });
        assertCurrent();
        const key = compositeKey(args.webId, podUrl);
        const existing = readyByComposite.get(key);
        if (existing) {
          if (isCurrent()) {
            readyByWebId.set(webIdKey, existing);
          }
          return existing;
        }

        const database = await adapter.openDatabase({
          webId: args.webId,
          podUrl,
          fetch: args.fetch,
          signal: controller.signal,
          isCurrent,
        });
        assertCurrent();
        await adapter.hydrateCollections({
          webId: args.webId,
          podUrl,
          database,
          signal: controller.signal,
          isCurrent,
        });
        assertCurrent();

        const opened: OpenPodRuntime<Database> = {
          webId: args.webId,
          podUrl,
          database,
          collections: 'ready',
        };

        if (isCurrent()) {
          readyByWebId.set(webIdKey, opened);
          readyByComposite.set(key, opened);
        }

        return opened;
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
}
