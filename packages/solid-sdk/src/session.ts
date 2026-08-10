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
  let isInitializing = false;
  let initializationErrorSnapshot: SolidSessionSnapshot | undefined;
  let disposed = false;

  const publish = (nextSnapshot: SolidSessionSnapshot): SolidSessionSnapshot => {
    snapshot = nextSnapshot;
    if (disposed) {
      return snapshot;
    }
    if (areSnapshotsEqual(lastNotifiedSnapshot, snapshot)) {
      return snapshot;
    }
    lastNotifiedSnapshot = snapshot;
    for (const listener of listeners) {
      listener(snapshot);
    }
    return snapshot;
  };

  const publishSessionInfo = () => publish(snapshotFromSessionInfo(session.info));
  const publishAnonymous = () => publish({ status: 'anonymous' });
  const publishSessionExpired = () => publish(snapshotFromSessionExpired(session.info));
  const publishSessionError = (
    code: string | null,
    description?: string | null,
  ) => {
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

    getSnapshot() {
      return snapshot;
    },

    initialize(options = {}) {
      if (initialization) {
        return initialization;
      }

      isInitializing = true;
      initializationErrorSnapshot = undefined;
      publish({ status: 'initializing' });
      const nextInitialization = session.handleIncomingRedirect({
        restorePreviousSession: options.restorePreviousSession ?? true,
      }).then((info) => {
        const nextSnapshot = snapshotFromSessionInfo(info ?? session.info);
        if (nextSnapshot.status === 'anonymous' && initializationErrorSnapshot?.status === 'error') {
          return initializationErrorSnapshot;
        }
        return publish(nextSnapshot);
      })
        .catch((error: unknown) => publish(snapshotFromSessionError(error, session.info)))
        .finally(() => {
          if (initialization === nextInitialization) {
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

      isInitializing = true;
      initializationErrorSnapshot = undefined;
      publish({ status: 'initializing' });
      const nextInitialization = session.handleIncomingRedirect(url).then((info) => {
        const nextSnapshot = snapshotFromSessionInfo(info ?? session.info);
        if (nextSnapshot.status === 'anonymous' && initializationErrorSnapshot?.status === 'error') {
          return initializationErrorSnapshot;
        }
        return publish(nextSnapshot);
      })
        .catch((error: unknown) => publish(snapshotFromSessionError(error, session.info)))
        .finally(() => {
          if (initialization === nextInitialization) {
            initialization = undefined;
            isInitializing = false;
            initializationErrorSnapshot = undefined;
          }
        });
      initialization = nextInitialization;

      return nextInitialization;
    },

    login(options: ILoginInputOptions) {
      return session.login(options);
    },

    async logout(options?: ILogoutOptions) {
      await session.logout(options);
      publish({ status: 'anonymous' });
    },

    subscribe(listener: SolidSessionListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
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
