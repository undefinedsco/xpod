import { EventEmitter } from 'node:events';
import { EVENTS } from '@inrupt/solid-client-authn-browser';
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
        status: 'error',
        webId: 'https://pod.example/alice/restored/profile/card#me',
        error: expect.objectContaining({ message: 'Solid session expired' }),
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
