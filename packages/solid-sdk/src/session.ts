import {
  EVENTS,
  Session,
  type IHandleIncomingRedirectOptions,
  type ILoginInputOptions,
  type ILogoutOptions,
  type ISessionEventListener,
  type ISessionInfo,
} from '@inrupt/solid-client-authn-browser';

export type SolidSessionSnapshot =
  | {
    status: 'initializing';
    webId?: undefined;
    error?: undefined;
  }
  | {
    status: 'anonymous';
    webId?: undefined;
    error?: undefined;
  }
  | {
    status: 'authenticated';
    webId: string;
    error?: undefined;
  }
  | {
    status: 'expired';
    webId?: string;
    error?: undefined;
  }
  | {
    status: 'error';
    webId?: string;
    error: Error;
  };

export type SolidSessionListener = (snapshot: SolidSessionSnapshot) => void;

export type SolidSessionAdapter = {
  readonly info: Pick<ISessionInfo, 'isLoggedIn' | 'webId'>;
  events: ISessionEventListener;
  fetch: typeof fetch;
  handleIncomingRedirect(
    options?: string | IHandleIncomingRedirectOptions,
  ): Promise<Pick<ISessionInfo, 'isLoggedIn' | 'webId'> | undefined>;
  login(options: ILoginInputOptions): Promise<void>;
  logout(options?: ILogoutOptions): Promise<void>;
};

export type SolidSessionRuntime = {
  readonly fetch: typeof fetch;
  /** A revocable capability for this exact WebID and authenticated session. */
  createAuthenticatedFetch(webId: string): typeof fetch;
  getSnapshot(): SolidSessionSnapshot;
  initialize(options?: { restorePreviousSession?: boolean }): Promise<SolidSessionSnapshot>;
  /** Complete a full-page redirect using the exact browser URL. */
  handleIncomingRedirect?(url: string): Promise<SolidSessionSnapshot>;
  login(options: ILoginInputOptions): Promise<void>;
  logout(options?: ILogoutOptions): Promise<void>;
  subscribe(listener: SolidSessionListener): () => void;
  dispose(): void;
};

export type CreateSolidSessionRuntimeOptions = {
  session?: SolidSessionAdapter;
};

type SolidSessionErrorListener = (error: string | null, errorDescription?: string | null) => unknown;

type SolidSessionErrorEventTarget = {
  on(eventName: 'error', listener: SolidSessionErrorListener): unknown;
  off(eventName: 'error', listener: SolidSessionErrorListener): unknown;
};

function snapshotFromSessionInfo(info?: Pick<ISessionInfo, 'isLoggedIn' | 'webId'>): SolidSessionSnapshot {
  if (info?.isLoggedIn && info.webId) {
    return {
      status: 'authenticated',
      webId: info.webId,
    };
  }

  return { status: 'anonymous' };
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function snapshotFromSessionError(
  error: unknown,
  info: Pick<ISessionInfo, 'webId'>,
): SolidSessionSnapshot {
  return {
    status: 'error',
    webId: info.webId,
    error: normalizeError(error),
  };
}

function snapshotFromSessionExpired(
  info: Pick<ISessionInfo, 'webId'>,
): SolidSessionSnapshot {
  return {
    status: 'expired',
    ...(info.webId === undefined ? {} : { webId: info.webId }),
  };
}

function areSnapshotsEqual(
  left: SolidSessionSnapshot | undefined,
  right: SolidSessionSnapshot,
): boolean {
  if (!left || left.status !== right.status || left.webId !== right.webId) {
    return false;
  }

  if (left.status === 'error' && right.status === 'error') {
    return left.error === right.error;
  }

  return true;
}

export function createSolidSessionRuntime(
  options: CreateSolidSessionRuntimeOptions = {},
): SolidSessionRuntime {
  const session: SolidSessionAdapter = options.session ?? new Session();
  const listeners = new Set<SolidSessionListener>();
  let snapshot: SolidSessionSnapshot = { status: 'initializing' };
  let lastNotifiedSnapshot: SolidSessionSnapshot | undefined;
  let initialization: Promise<SolidSessionSnapshot> | undefined;
  let initialized = false;
  let isInitializing = false;
  let initializationErrorSnapshot: SolidSessionSnapshot | undefined;
  let disposed = false;
  let authenticationGeneration = 0;
  let authenticationUnavailable = false;
  let authenticationOperations = 0;
  // Redirect completion has a lifecycle separate from signer renewal. Its own
  // LOGIN event may advance authenticationGeneration without cancelling it.
  let identityOperationGeneration = 0;
  let pendingIdentity: { generation: number; eventWebId?: string } | undefined;
  const invalidateAuthentication = () => {
    authenticationGeneration += 1;
    authenticationUnavailable = true;
  };

  const publish = (nextSnapshot: SolidSessionSnapshot): SolidSessionSnapshot => {
    if (disposed) return snapshot;
    if (nextSnapshot.status !== 'authenticated'
      || snapshot.status !== 'authenticated' || snapshot.webId !== nextSnapshot.webId) {
      invalidateAuthentication();
    }
    if (nextSnapshot.status === 'authenticated') authenticationUnavailable = false;
    snapshot = nextSnapshot;
    if (areSnapshotsEqual(lastNotifiedSnapshot, snapshot)) {
      return snapshot;
    }
    lastNotifiedSnapshot = snapshot;
    for (const listener of listeners) {
      listener(snapshot);
    }
    return snapshot;
  };

  const publishSessionInfo = () => {
    // Inrupt may emit LOGIN while a cancelled redirect is still settling.
    // These events cannot restore authority after logout/disposal.
    if (pendingIdentity) {
      if (pendingIdentity.generation !== identityOperationGeneration) return snapshot;
      if (pendingIdentity.eventWebId && pendingIdentity.eventWebId !== session.info.webId) return snapshot;
      pendingIdentity.eventWebId = session.info.webId;
    }
    // LOGIN/RESTORED establishes a new session even when the WebID is unchanged.
    // Token renewal changes Inrupt's signer without these login events.
    invalidateAuthentication();
    lastNotifiedSnapshot = undefined;
    return publish(snapshotFromSessionInfo(session.info));
  };
  const publishAnonymous = () => {
    identityOperationGeneration += 1;
    return publish({ status: 'anonymous' });
  };
  const publishSessionExpired = () => {
    identityOperationGeneration += 1;
    return publish(snapshotFromSessionExpired(session.info));
  };
  const publishSessionError = (
    code: string | null,
    description?: string | null,
  ) => {
    identityOperationGeneration += 1;
    const errorSnapshot = snapshotFromSessionError(
      description ?? code ?? 'Solid session error',
      session.info,
    );
    if (isInitializing) {
      initializationErrorSnapshot = errorSnapshot;
    }
    publish(errorSnapshot);
  };

  session.events.on(EVENTS.LOGIN, publishSessionInfo);
  session.events.on(EVENTS.SESSION_RESTORED, publishSessionInfo);
  session.events.on(EVENTS.LOGOUT, publishAnonymous);
  session.events.on(EVENTS.SESSION_EXPIRED, publishSessionExpired);
  const errorEvents = session.events as SolidSessionErrorEventTarget;
  errorEvents.on(EVENTS.ERROR, publishSessionError);

  return {
    fetch: session.fetch,

    createAuthenticatedFetch(webId: string) {
      const generation = authenticationGeneration;
      const assertCurrent = () => {
        if (disposed || authenticationOperations > 0 || authenticationUnavailable || generation !== authenticationGeneration
          || snapshot.status !== 'authenticated' || snapshot.webId !== webId
          || !session.info.isLoggedIn || session.info.webId !== webId) {
          const error = new Error('Authenticated session is no longer current');
          error.name = 'AbortError';
          throw error;
        }
      };
      return async (input, init) => {
        assertCurrent();
        const response = await (init === undefined ? session.fetch(input) : session.fetch(input, init));
        try {
          assertCurrent();
        } catch (error) {
          // The request may already have reached the server. Discard its stale
          // response rather than returning it to the previous identity's work.
          void response.body?.cancel().catch(() => undefined);
          throw error;
        }
        return response;
      };
    },

    getSnapshot() {
      return snapshot;
    },

    initialize(options = {}) {
      if (initialization) {
        return initialization;
      }
      // A runtime owns exactly one Inrupt Session for the lifetime of the
      // current document. Re-entering a route boundary must project the
      // existing snapshot instead of starting another prompt=none redirect.
      // Failed initialization remains retryable below.
      if (initialized) {
        return Promise.resolve(snapshot);
      }

      if (disposed) return Promise.resolve(snapshot);
      const operation = { generation: ++identityOperationGeneration, eventWebId: undefined as string | undefined };
      pendingIdentity = operation;
      const isCurrentOperation = (info?: Pick<ISessionInfo, 'isLoggedIn' | 'webId'>) => !disposed
        && operation.generation === identityOperationGeneration
        && (!info?.isLoggedIn || !operation.eventWebId || operation.eventWebId === info.webId);
      isInitializing = true;
      initializationErrorSnapshot = undefined;
      publish({ status: 'initializing' });
      const nextInitialization = session.handleIncomingRedirect({
        restorePreviousSession: options.restorePreviousSession ?? true,
      }).then((info) => {
        if (!isCurrentOperation(info ?? session.info)) return snapshot;
        const nextSnapshot = snapshotFromSessionInfo(info ?? session.info);
        if (nextSnapshot.status === 'anonymous' && initializationErrorSnapshot?.status === 'error') {
          return initializationErrorSnapshot;
        }
        initialized = true;
        return publish(nextSnapshot);
      })
        .catch((error: unknown) => isCurrentOperation()
          ? publish(snapshotFromSessionError(error, session.info)) : snapshot)
        .finally(() => {
          if (initialization === nextInitialization) {
            if (pendingIdentity === operation) pendingIdentity = undefined;
            initialization = undefined;
            isInitializing = false;
            initializationErrorSnapshot = undefined;
          }
        });
      initialization = nextInitialization;

      return initialization;
    },

    handleIncomingRedirect(url: string) {
      if (initialization) {
        return initialization;
      }

      if (disposed) return Promise.resolve(snapshot);
      const operation = { generation: ++identityOperationGeneration, eventWebId: undefined as string | undefined };
      pendingIdentity = operation;
      const isCurrentOperation = (info?: Pick<ISessionInfo, 'isLoggedIn' | 'webId'>) => !disposed
        && operation.generation === identityOperationGeneration
        && (!info?.isLoggedIn || !operation.eventWebId || operation.eventWebId === info.webId);
      isInitializing = true;
      initializationErrorSnapshot = undefined;
      publish({ status: 'initializing' });
      const nextInitialization = session.handleIncomingRedirect(url).then((info) => {
        if (!isCurrentOperation(info ?? session.info)) return snapshot;
        const nextSnapshot = snapshotFromSessionInfo(info ?? session.info);
        if (nextSnapshot.status === 'anonymous' && initializationErrorSnapshot?.status === 'error') {
          return initializationErrorSnapshot;
        }
        initialized = true;
        return publish(nextSnapshot);
      })
        .catch((error: unknown) => isCurrentOperation()
          ? publish(snapshotFromSessionError(error, session.info)) : snapshot)
        .finally(() => {
          if (initialization === nextInitialization) {
            if (pendingIdentity === operation) pendingIdentity = undefined;
            initialization = undefined;
            isInitializing = false;
            initializationErrorSnapshot = undefined;
          }
        });
      initialization = nextInitialization;

      return nextInitialization;
    },

    async login(options: ILoginInputOptions) {
      identityOperationGeneration += 1;
      invalidateAuthentication();
      authenticationOperations += 1;
      try {
        // Inrupt mutates one shared signer and emits untagged events. A new
        // login cannot safely overlap a previous redirect. Fail promptly so
        // callers can retry after it settles, or reload to obtain a new Session.
        if (initialization) {
          const error = new Error('Previous login is still completing. Reload before reconnecting.');
          error.name = 'SolidSessionPendingError';
          throw error;
        }
        if (disposed) throw new Error('Solid session runtime is disposed');
        await session.login(options);
      } catch (error) {
        publish(snapshotFromSessionError(error, session.info));
        throw error;
      } finally {
        authenticationOperations -= 1;
      }
    },

    async logout(options?: ILogoutOptions) {
      identityOperationGeneration += 1;
      invalidateAuthentication();
      authenticationOperations += 1;
      try {
        await session.logout(options);
        publish({ status: 'anonymous' });
      } catch (error) {
        publish(snapshotFromSessionError(error, session.info));
        throw error;
      } finally {
        authenticationOperations -= 1;
      }
    },

    subscribe(listener: SolidSessionListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      identityOperationGeneration += 1;
      invalidateAuthentication();
      disposed = true;
      listeners.clear();
      session.events.off(EVENTS.LOGIN, publishSessionInfo);
      session.events.off(EVENTS.SESSION_RESTORED, publishSessionInfo);
      session.events.off(EVENTS.LOGOUT, publishAnonymous);
      session.events.off(EVENTS.SESSION_EXPIRED, publishSessionExpired);
      errorEvents.off(EVENTS.ERROR, publishSessionError);
    },
  };
}
