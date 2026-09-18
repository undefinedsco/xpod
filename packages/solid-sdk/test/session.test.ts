import { EventEmitter } from 'node:events';
import { EVENTS, Session } from '@inrupt/solid-client-authn-browser';
import { describe, expect, it, vi } from 'vitest';
import { createSolidSessionRuntime } from '../src/session';
import type { SolidSessionSnapshot } from '../src/session';

type FakeSessionInfo = {
  isLoggedIn: boolean;
  webId?: string;
};

type FakeSession = {
  info: FakeSessionInfo;
  events: EventEmitter;
  fetch: typeof fetch;
  handleIncomingRedirect: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
};

function createFakeSession(info: FakeSessionInfo = { isLoggedIn: false }): FakeSession {
  return {
    info,
    events: new EventEmitter(),
    fetch: vi.fn() as unknown as typeof fetch,
    handleIncomingRedirect: vi.fn(async () => undefined),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };
}

describe('createSolidSessionRuntime', () => {
  it('initializes with restorePreviousSession once for concurrent callers and publishes authenticated state', async () => {
    let resolveRedirect: (value: FakeSessionInfo) => void = () => undefined;
    const session = createFakeSession();
    const redirect = new Promise<FakeSessionInfo>((resolve) => {
      resolveRedirect = resolve;
    });
    session.handleIncomingRedirect.mockReturnValue(redirect);
    const runtime = createSolidSessionRuntime({ session });
    const snapshots: SolidSessionSnapshot[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot));

    expect(runtime.getSnapshot()).toEqual({ status: 'initializing' });
    const first = runtime.initialize();
    const second = runtime.initialize();
    expect(runtime.getSnapshot()).toEqual({ status: 'initializing' });
    resolveRedirect({
      isLoggedIn: true,
      webId: 'https://pod.example/alice/profile/card#me',
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        status: 'authenticated',
        webId: 'https://pod.example/alice/profile/card#me',
      },
      {
        status: 'authenticated',
        webId: 'https://pod.example/alice/profile/card#me',
      },
    ]);
    expect(session.handleIncomingRedirect).toHaveBeenCalledTimes(1);
    expect(session.handleIncomingRedirect).toHaveBeenCalledWith({
      restorePreviousSession: true,
    });
    expect(snapshots).toEqual([
      { status: 'initializing' },
      {
        status: 'authenticated',
        webId: 'https://pod.example/alice/profile/card#me',
      },
    ]);
  });

  it('publishes anonymous when initialization does not restore a logged-in session', async () => {
    const session = createFakeSession();
    const runtime = createSolidSessionRuntime({ session });
    const snapshots: SolidSessionSnapshot[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot));

    await expect(runtime.initialize()).resolves.toEqual({ status: 'anonymous' });
    expect(snapshots).toEqual([
      { status: 'initializing' },
      { status: 'anonymous' },
    ]);
  });

  it('does not repeat successful restoration when a route boundary remounts', async () => {
    const session = createFakeSession({
      isLoggedIn: true,
      webId: 'https://pod.example/alice/profile/card#me',
    });
    session.handleIncomingRedirect.mockResolvedValue(session.info);
    const runtime = createSolidSessionRuntime({ session });

    const first = await runtime.initialize({ restorePreviousSession: true });
    const second = await runtime.initialize({ restorePreviousSession: true });

    expect(first).toEqual({
      status: 'authenticated',
      webId: 'https://pod.example/alice/profile/card#me',
    });
    expect(second).toBe(first);
    expect(session.handleIncomingRedirect).toHaveBeenCalledTimes(1);
  });

  it('does not restore again after an explicit callback was handled in the same document', async () => {
    const session = createFakeSession({
      isLoggedIn: true,
      webId: 'https://pod.example/alice/profile/card#me',
    });
    session.handleIncomingRedirect.mockResolvedValue(session.info);
    const runtime = createSolidSessionRuntime({ session });

    const callback = await runtime.handleIncomingRedirect('https://app.example/auth/callback?code=ok');
    const restored = await runtime.initialize({ restorePreviousSession: true });

    expect(restored).toBe(callback);
    expect(session.handleIncomingRedirect).toHaveBeenCalledTimes(1);
    expect(session.handleIncomingRedirect).toHaveBeenCalledWith(
      'https://app.example/auth/callback?code=ok',
    );
  });

  it('only caches pending initialization and allows retry after a failed restore', async () => {
    const session = createFakeSession();
    session.handleIncomingRedirect
      .mockRejectedValueOnce(new Error('first restore failed'))
      .mockResolvedValueOnce({
        isLoggedIn: true,
        webId: 'https://pod.example/alice/profile/card#me',
      });
    const runtime = createSolidSessionRuntime({ session });
    const snapshots: SolidSessionSnapshot[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot));

    await expect(runtime.initialize()).resolves.toMatchObject({
      status: 'error',
      error: expect.objectContaining({ message: 'first restore failed' }),
    });
    await expect(runtime.initialize()).resolves.toEqual({
      status: 'authenticated',
      webId: 'https://pod.example/alice/profile/card#me',
    });

    expect(session.handleIncomingRedirect).toHaveBeenCalledTimes(2);
    expect(snapshots).toEqual([
      { status: 'initializing' },
      {
        status: 'error',
        error: expect.objectContaining({ message: 'first restore failed' }),
      },
      { status: 'initializing' },
      {
        status: 'authenticated',
        webId: 'https://pod.example/alice/profile/card#me',
      },
    ]);
  });

  it('exposes the underlying session fetch and delegates login options unchanged', async () => {
    const session = createFakeSession();
    const runtime = createSolidSessionRuntime({ session });
    const loginOptions = {
      oidcIssuer: 'https://issuer.example/',
      redirectUrl: 'https://app.example/callback',
      clientName: 'LinX',
    };

    await runtime.login(loginOptions);

    expect(runtime.fetch).toBe(session.fetch);
    expect(session.login).toHaveBeenCalledTimes(1);
    expect(session.login).toHaveBeenCalledWith(loginOptions);
  });

  it('delegates logout and publishes anonymous after logout completes', async () => {
    const session = createFakeSession({
      isLoggedIn: true,
      webId: 'https://pod.example/alice/profile/card#me',
    });
    const runtime = createSolidSessionRuntime({ session });
    const snapshots: SolidSessionSnapshot[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot));

    await runtime.logout({ logoutType: 'app' });

    expect(session.logout).toHaveBeenCalledWith({ logoutType: 'app' });
    expect(runtime.getSnapshot()).toEqual({ status: 'anonymous' });
    expect(snapshots).toEqual([{ status: 'anonymous' }]);
  });

  it('publishes error when initialization fails', async () => {
    const session = createFakeSession();
    const error = new Error('redirect failed');
    session.handleIncomingRedirect.mockRejectedValue(error);
    const runtime = createSolidSessionRuntime({ session });
    const snapshots: SolidSessionSnapshot[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot));

    await expect(runtime.initialize()).resolves.toEqual({
      status: 'error',
      error,
    });
    expect(runtime.getSnapshot()).toEqual({ status: 'error', error });
    expect(snapshots).toEqual([
      { status: 'initializing' },
      { status: 'error', error },
    ]);
  });

  it('normalizes non-Error initialization failures to Error snapshots', async () => {
    const session = createFakeSession();
    session.handleIncomingRedirect.mockRejectedValue('redirect failed');
    const runtime = createSolidSessionRuntime({ session });

    const snapshot = await runtime.initialize();

    expect(snapshot.status).toBe('error');
    if (snapshot.status === 'error') {
      expect(snapshot.error).toBeInstanceOf(Error);
      expect(snapshot.error.message).toBe('redirect failed');
    }
  });

  it('keeps an initialization error when redirect handling emits error then resolves unauthenticated', async () => {
    const session = createFakeSession();
    session.handleIncomingRedirect.mockImplementation(async () => {
      session.events.emit(EVENTS.ERROR, 'redirect', 'Provider denied access');
      return { isLoggedIn: false };
    });
    const runtime = createSolidSessionRuntime({ session });
    const snapshots: SolidSessionSnapshot[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot));

    const result = await runtime.initialize();

    expect(result).toEqual({
      status: 'error',
      error: expect.objectContaining({ message: 'Provider denied access' }),
    });
    expect(runtime.getSnapshot()).toEqual({
      status: 'error',
      error: expect.objectContaining({ message: 'Provider denied access' }),
    });
    expect(snapshots).toEqual([
      { status: 'initializing' },
      {
        status: 'error',
        error: expect.objectContaining({ message: 'Provider denied access' }),
      },
    ]);
  });

  it('syncs snapshots from Inrupt session events', () => {
    const session = createFakeSession();
    const runtime = createSolidSessionRuntime({ session });
    const snapshots: SolidSessionSnapshot[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot));

    session.info.isLoggedIn = true;
    session.info.webId = 'https://pod.example/alice/profile/card#me';
    session.events.emit(EVENTS.LOGIN);
    session.info.webId = 'https://pod.example/alice/restored/profile/card#me';
    session.events.emit(EVENTS.SESSION_RESTORED, 'https://app.example/current');
    session.events.emit(EVENTS.ERROR, 'redirect', 'Provider denied access');
    session.events.emit(EVENTS.SESSION_EXPIRED);
    session.events.emit(EVENTS.LOGOUT);

    expect(snapshots).toEqual([
      {
        status: 'authenticated',
        webId: 'https://pod.example/alice/profile/card#me',
      },
      {
        status: 'authenticated',
        webId: 'https://pod.example/alice/restored/profile/card#me',
      },
      {
        status: 'error',
        webId: 'https://pod.example/alice/restored/profile/card#me',
        error: expect.objectContaining({ message: 'Provider denied access' }),
      },
      {
        status: 'expired',
        webId: 'https://pod.example/alice/restored/profile/card#me',
      },
      { status: 'anonymous' },
    ]);
  });

  it('does not duplicate authenticated notifications when redirect handling emits login before resolving', async () => {
    const session = createFakeSession();
    session.handleIncomingRedirect.mockImplementation(async () => {
      session.info.isLoggedIn = true;
      session.info.webId = 'https://pod.example/alice/profile/card#me';
      session.events.emit(EVENTS.LOGIN);
      return {
        isLoggedIn: true,
        webId: 'https://pod.example/alice/profile/card#me',
      };
    });
    const runtime = createSolidSessionRuntime({ session });
    const snapshots: SolidSessionSnapshot[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot));

    await runtime.initialize();

    expect(snapshots).toEqual([
      { status: 'initializing' },
      {
        status: 'authenticated',
        webId: 'https://pod.example/alice/profile/card#me',
      },
    ]);
  });

  it('does not duplicate authenticated notifications when redirect handling emits session restored before resolving', async () => {
    const session = createFakeSession();
    session.handleIncomingRedirect.mockImplementation(async () => {
      session.info.isLoggedIn = true;
      session.info.webId = 'https://pod.example/alice/restored/profile/card#me';
      session.events.emit(EVENTS.SESSION_RESTORED, 'https://app.example/current');
      return {
        isLoggedIn: true,
        webId: 'https://pod.example/alice/restored/profile/card#me',
      };
    });
    const runtime = createSolidSessionRuntime({ session });
    const snapshots: SolidSessionSnapshot[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot));

    await runtime.initialize();

    expect(snapshots).toEqual([
      { status: 'initializing' },
      {
        status: 'authenticated',
        webId: 'https://pod.example/alice/restored/profile/card#me',
      },
    ]);
  });

  it('does not duplicate anonymous notifications when logout emits before resolving', async () => {
    const session = createFakeSession({
      isLoggedIn: true,
      webId: 'https://pod.example/alice/profile/card#me',
    });
    session.logout.mockImplementation(async () => {
      session.info.isLoggedIn = false;
      session.info.webId = undefined;
      session.events.emit(EVENTS.LOGOUT);
    });
    const runtime = createSolidSessionRuntime({ session });
    const snapshots: SolidSessionSnapshot[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot));

    await runtime.logout();

    expect(snapshots).toEqual([{ status: 'anonymous' }]);
  });

  it('cleans up Inrupt event listeners and runtime subscribers when disposed', () => {
    const session = createFakeSession();
    const runtime = createSolidSessionRuntime({ session });
    const listener = vi.fn();
    runtime.subscribe(listener);

    expect(session.events.listenerCount(EVENTS.LOGIN)).toBe(1);
    expect(session.events.listenerCount(EVENTS.SESSION_RESTORED)).toBe(1);
    expect(session.events.listenerCount(EVENTS.LOGOUT)).toBe(1);
    expect(session.events.listenerCount(EVENTS.ERROR)).toBe(1);
    expect(session.events.listenerCount(EVENTS.SESSION_EXPIRED)).toBe(1);

    runtime.dispose();
    session.info.isLoggedIn = true;
    session.info.webId = 'https://pod.example/alice/profile/card#me';
    session.events.emit(EVENTS.LOGIN);

    expect(session.events.listenerCount(EVENTS.LOGIN)).toBe(0);
    expect(session.events.listenerCount(EVENTS.SESSION_RESTORED)).toBe(0);
    expect(session.events.listenerCount(EVENTS.LOGOUT)).toBe(0);
    expect(session.events.listenerCount(EVENTS.ERROR)).toBe(0);
    expect(session.events.listenerCount(EVENTS.SESSION_EXPIRED)).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops publishing to unsubscribed listeners', async () => {
    const session = createFakeSession();
    const runtime = createSolidSessionRuntime({ session });
    const listener = vi.fn();

    const unsubscribe = runtime.subscribe(listener);
    unsubscribe();
    await runtime.initialize();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('identity-bound authenticated fetch', () => {
  const webId = 'https://ID.example:443/alice#me';
  async function authenticated() {
    const session = createFakeSession({ isLoggedIn: true, webId });
    session.fetch = vi.fn(async () => new Response('ok')) as typeof fetch;
    const runtime = createSolidSessionRuntime({ session });
    await runtime.initialize();
    return { session, runtime, bound: runtime.createAuthenticatedFetch(webId) };
  }
  it('preserves raw fetch and current bindings for the exact WebID', async () => {
    const { session, runtime, bound } = await authenticated();
    expect(runtime.fetch).toBe(session.fetch);
    await bound('/first');
    await bound('/refreshed');
    expect(session.fetch).toHaveBeenCalledTimes(2);
    await expect(runtime.createAuthenticatedFetch('https://id.example/alice#me')('/wrong')).rejects.toThrow();
    expect(session.fetch).toHaveBeenCalledTimes(2);
  });
  it('revokes at logout start and stays revoked after failed logout until explicit restore', async () => {
    const { session, runtime, bound } = await authenticated();
    let rejectLogout!: (error: Error) => void;
    session.logout.mockImplementation(() => new Promise((_, reject) => { rejectLogout = reject; }));
    const pending = runtime.logout();
    await expect(bound('/during')).rejects.toThrow();
    session.events.emit(EVENTS.SESSION_RESTORED);
    await expect(runtime.createAuthenticatedFetch(webId)('/during-restore')).rejects.toThrow();
    rejectLogout(new Error('offline'));
    await expect(pending).rejects.toThrow('offline');
    await expect(runtime.createAuthenticatedFetch(webId)('/after-failure')).rejects.toThrow();
    session.logout.mockResolvedValue(undefined);
    await runtime.logout();
    await expect(bound('/after-retry')).rejects.toThrow();
    session.events.emit(EVENTS.SESSION_RESTORED);
    await expect(bound('/same-identity-new-session')).rejects.toThrow();
    await runtime.createAuthenticatedFetch(webId)('/new-binding');
    expect(session.fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps a binding valid when Inrupt changes signer and emits SESSION_EXTENDED', async () => {
    const firstSigner = vi.fn(async () => new Response('first'));
    const renewedSigner = vi.fn(async () => new Response('renewed'));
    // Real Inrupt Session dispatch; injected signers perform no network/authentication.
    const authentication = { fetch: firstSigner };
    const session = new Session({ clientAuthentication: authentication as never });
    session.info.isLoggedIn = true;
    session.info.webId = webId;
    const runtime = createSolidSessionRuntime({ session });
    // The runtime consumes restored info; avoid Inrupt's browser-only login listener.
    session.events.emit(EVENTS.SESSION_RESTORED, 'https://app.example');
    const bound = runtime.createAuthenticatedFetch(webId);
    expect(await (await bound('/before-refresh')).text()).toBe('first');
    authentication.fetch = renewedSigner;
    session.events.emit(EVENTS.SESSION_EXTENDED, 3600);
    expect(await (await bound('/after-refresh')).text()).toBe('renewed');
    expect(firstSigner).toHaveBeenCalledTimes(1);
    expect(renewedSigner).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });
  it('discards an in-flight response after a same-WebID session restore', async () => {
    const { session, runtime, bound } = await authenticated();
    let resolveResponse!: (response: Response) => void;
    vi.mocked(session.fetch).mockImplementation(() => new Promise((resolve) => { resolveResponse = resolve; }));
    const pending = bound('/pending');
    session.events.emit(EVENTS.SESSION_RESTORED);
    const response = new Response('old response');
    const cancel = vi.spyOn(response.body!, 'cancel');
    resolveResponse(response);
    await expect(pending).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot()).toMatchObject({ status: 'authenticated', webId });
  });
  it('fails closed after failed login and supports explicit reauthentication', async () => {
    const { session, runtime, bound } = await authenticated();
    session.login.mockRejectedValueOnce(new Error('offline'));
    await expect(runtime.login({ oidcIssuer: 'https://id.example' })).rejects.toThrow('offline');
    expect(runtime.getSnapshot()).toMatchObject({ status: 'error' });
    await expect(bound('/old')).rejects.toThrow();
    await expect(runtime.createAuthenticatedFetch(webId)('/failed')).rejects.toThrow();
    session.login.mockImplementation(async () => { session.events.emit(EVENTS.LOGIN); });
    await runtime.login({ oidcIssuer: 'https://id.example' });
    await expect(bound('/old-after-retry')).rejects.toThrow();
    await runtime.createAuthenticatedFetch(webId)('/current');
    expect(session.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([EVENTS.LOGOUT, EVENTS.SESSION_EXPIRED, EVENTS.ERROR])('revokes bindings on %s', async (event) => {
    const { session, bound } = await authenticated();
    session.events.emit(event, 'failed');
    await expect(bound('/old')).rejects.toThrow();
    expect(session.fetch).not.toHaveBeenCalled();
  });
  it('revokes on identity switch, same-WebID restore, and dispose', async () => {
    const { session, runtime, bound } = await authenticated();
    session.info.webId = 'https://id.example/bob#me';
    session.events.emit(EVENTS.LOGIN);
    await expect(bound('/alice')).rejects.toThrow();
    const bob = runtime.createAuthenticatedFetch(session.info.webId);
    session.events.emit(EVENTS.SESSION_RESTORED);
    await expect(bob('/old-bob')).rejects.toThrow();
    const current = runtime.createAuthenticatedFetch(session.info.webId);
    runtime.dispose();
    await expect(current('/disposed')).rejects.toThrow();
    expect(session.fetch).not.toHaveBeenCalled();
  });
});

describe('pending identity completion lifecycle', () => {
  it.each(['initialize', 'callback'] as const)('ignores late %s completion after logout, including its LOGIN event', async (operation) => {
    const session = createFakeSession();
    let finish!: (info: FakeSessionInfo) => void;
    session.handleIncomingRedirect.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const runtime = createSolidSessionRuntime({ session });
    const pending = operation === 'initialize' ? runtime.initialize() : runtime.handleIncomingRedirect!('https://app.example/callback');
    await runtime.logout();
    session.info.isLoggedIn = true; session.info.webId = 'https://id.example/A#me';
    session.events.emit(EVENTS.LOGIN);
    finish(session.info);
    await pending;
    expect(runtime.getSnapshot()).toEqual({ status: 'anonymous' });
    await expect(runtime.createAuthenticatedFetch(session.info.webId)('/old')).rejects.toThrow();
    expect(session.fetch).not.toHaveBeenCalled();
  });
  it.each(['initialize', 'callback'] as const)('does not mutate a disposed runtime after late %s', async (operation) => {
    const session = createFakeSession();
    let finish!: (info: FakeSessionInfo) => void;
    session.handleIncomingRedirect.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const runtime = createSolidSessionRuntime({ session });
    const pending = operation === 'initialize' ? runtime.initialize() : runtime.handleIncomingRedirect!('https://app.example/callback');
    runtime.dispose();
    const disposedSnapshot = runtime.getSnapshot();
    finish({ isLoggedIn: true, webId: 'https://id.example/A#me' });
    await pending;
    expect(runtime.getSnapshot()).toBe(disposedSnapshot);
  });
  it.each(['initialize', 'callback'] as const)('does not overwrite new B with late A %s result', async (operation) => {
    const session = createFakeSession();
    let finish!: (info: FakeSessionInfo) => void;
    session.handleIncomingRedirect.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const runtime = createSolidSessionRuntime({ session });
    const pending = operation === 'initialize' ? runtime.initialize() : runtime.handleIncomingRedirect!('https://app.example/callback');
    session.info.isLoggedIn = true; session.info.webId = 'https://id.example/B#me';
    session.events.emit(EVENTS.LOGIN);
    finish({ isLoggedIn: true, webId: 'https://id.example/A#me' });
    await pending;
    expect(runtime.getSnapshot()).toEqual({ status: 'authenticated', webId: 'https://id.example/B#me' });
    await expect(runtime.createAuthenticatedFetch('https://id.example/A#me')('/old')).rejects.toThrow();
  });
  it.each([EVENTS.LOGOUT, EVENTS.SESSION_EXPIRED, EVENTS.ERROR])('invalidates pending restore on external %s', async (event) => {
    const session = createFakeSession();
    let finish!: (info: FakeSessionInfo) => void;
    session.handleIncomingRedirect.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const runtime = createSolidSessionRuntime({ session });
    const pending = runtime.initialize();
    session.events.emit(event, 'failed');
    const invalidated = runtime.getSnapshot();
    session.info.isLoggedIn = true; session.info.webId = 'https://id.example/A#me';
    session.events.emit(EVENTS.LOGIN);
    finish(session.info);
    await pending;
    expect(runtime.getSnapshot()).toBe(invalidated);
    await expect(runtime.createAuthenticatedFetch(session.info.webId)('/old')).rejects.toThrow();
  });
  it('fails promptly for a stuck restore and supports retry after it settles', async () => {
    const session = createFakeSession();
    let finish!: (info: FakeSessionInfo) => void;
    session.handleIncomingRedirect.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const runtime = createSolidSessionRuntime({ session });
    const pending = runtime.initialize();
    session.login.mockImplementation(async () => {
      session.info.isLoggedIn = true; session.info.webId = 'https://id.example/B#me';
      session.events.emit(EVENTS.LOGIN);
    });
    await expect(runtime.login({ oidcIssuer: 'https://id.example' })).rejects.toThrow('Reload before reconnecting');
    expect(session.login).not.toHaveBeenCalled();
    session.info.isLoggedIn = true; session.info.webId = 'https://id.example/A#me';
    session.events.emit(EVENTS.LOGIN);
    finish(session.info);
    await pending;
    await runtime.login({ oidcIssuer: 'https://id.example' });
    expect(runtime.getSnapshot()).toEqual({ status: 'authenticated', webId: 'https://id.example/B#me' });
    await runtime.createAuthenticatedFetch('https://id.example/B#me')('/current');
    expect(session.fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts its own LOGIN event and allows the completed current binding', async () => {
    const session = createFakeSession();
    const runtime = createSolidSessionRuntime({ session });
    session.handleIncomingRedirect.mockImplementation(async () => {
      session.info.isLoggedIn = true; session.info.webId = 'https://id.example/A#me';
      session.events.emit(EVENTS.LOGIN);
      return session.info;
    });
    await expect(runtime.initialize()).resolves.toEqual({ status: 'authenticated', webId: 'https://id.example/A#me' });
    await runtime.createAuthenticatedFetch(session.info.webId!)('/current');
    expect(session.fetch).toHaveBeenCalledTimes(1);
  });
});
