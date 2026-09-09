import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { OpenPodRuntime, SolidSessionRuntime } from '@undefineds.co/solid-sdk';
import { createMockStorageCapableWebExtensionHost, createMockWebExtensionHost } from '../src/testing';
import type {
  AppletSlotProps,
  SinglePaneAppletModule,
  TwoPaneAppletModule,
  WebExtensionModule,
  WebExtensionSolidCapability,
} from '../src/web';

function createSession(status: 'anonymous' | 'authenticated' | 'initializing'): SolidSessionRuntime {
  return {
    fetch: globalThis.fetch,
    getSnapshot: () => status === 'authenticated'
      ? {
        status,
        webId: 'https://pod.example/alice/profile/card#me',
      }
      : { status },
    initialize: async () => ({ status: 'anonymous' }),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    subscribe: () => () => undefined,
    dispose: vi.fn(),
  };
}

describe('WebExtensionSolidCapability', () => {
  it('creates an anonymous in-memory Solid capability by default', async () => {
    const host = createMockWebExtensionHost();

    expect(host.solid.session.getSnapshot()).toEqual({ status: 'anonymous' });
    expect(host.solid.pod).toBeUndefined();
    await expect(host.solid.requireLogin()).resolves.toBeUndefined();
  });

  it('provides an explicit storage-capable mock when a Pod is required', () => {
    const host = createMockStorageCapableWebExtensionHost();

    expect(host.solid.pod).toEqual({ status: 'unavailable' });
  });

  it('accepts an authenticated Solid capability override with a ready Pod runtime', () => {
    const database = { kind: 'mock-db' };
    const current: OpenPodRuntime<typeof database> = {
      webId: 'https://pod.example/alice/profile/card#me',
      podUrl: 'https://pod.example/alice/',
      database,
      collections: 'ready',
    };
    const host = createMockWebExtensionHost({
      solid: {
        session: createSession('authenticated'),
        pod: {
          status: 'ready',
          current,
        },
        requireLogin: async () => undefined,
      },
    });

    expect(host.solid.session.getSnapshot()).toEqual({
      status: 'authenticated',
      webId: 'https://pod.example/alice/profile/card#me',
    });
    expect(host.solid.pod?.status).toBe('ready');
    if (host.solid.pod?.status !== 'ready') {
      throw new Error('Expected ready Solid Pod');
    }
    expect(host.solid.pod.current.database).toBe(database);
  });

  it('preserves ready and error Pod states on explicit Solid overrides', () => {
    const error = new Error('Pod unavailable');
    const ready: WebExtensionSolidCapability = {
      session: createSession('authenticated'),
      pod: {
        status: 'ready',
        current: {
          webId: 'https://pod.example/alice/profile/card#me',
          podUrl: 'https://pod.example/alice/',
          database: { ready: true },
          collections: 'ready',
        },
      },
      requireLogin: async () => undefined,
    };
    const failed: WebExtensionSolidCapability = {
      session: createSession('authenticated'),
      pod: {
        status: 'error',
        error,
      },
      requireLogin: async () => undefined,
    };

    expect(createMockWebExtensionHost({ solid: ready }).solid.pod?.status).toBe('ready');
    const failedPod = createMockWebExtensionHost({ solid: failed }).solid.pod;
    if (failedPod.status !== 'error') {
      throw new Error('Expected error Solid Pod');
    }
    expect(failedPod.error).toBe(error);
  });

  it('does not expose raw OAuth token fields on the Host or Solid capability', () => {
    const host = createMockWebExtensionHost();

    expect('session' in host).toBe(false);
    expect('pod' in host).toBe(false);
    expect('accessToken' in host).toBe(false);
    expect('refreshToken' in host).toBe(false);
    expect('accessToken' in host.solid).toBe(false);
    expect('refreshToken' in host.solid).toBe(false);
  });

  it('lets tests override mock requireLogin behavior', async () => {
    const requireLogin = vi.fn(async () => undefined);
    const host = createMockWebExtensionHost({
      solid: {
        session: createSession('anonymous'),
        pod: { status: 'unavailable' },
        requireLogin,
      },
    });

    await host.solid.requireLogin();

    expect(requireLogin).toHaveBeenCalledTimes(1);
  });
});

describe('WebExtensionHost type surface', () => {
  it('does not expose destructive or direct auth methods through applet Solid session', () => {
    const host = createMockWebExtensionHost();

    expect('dispose' in host.solid.session).toBe(false);
    expect('login' in host.solid.session).toBe(false);
    expect('logout' in host.solid.session).toBe(false);
  });

  it('uses a discriminated Pod state contract', () => {
    const database = { typed: true };
    const ready: WebExtensionSolidCapability<typeof database>['pod'] = {
      status: 'ready',
      current: {
        webId: 'https://pod.example/alice/profile/card#me',
        podUrl: 'https://pod.example/alice/',
        database,
        collections: 'ready',
      },
    };
    const error = new Error('Pod unavailable');
    const failed: WebExtensionSolidCapability['pod'] = {
      status: 'error',
      error,
    };
    const unavailable: WebExtensionSolidCapability['pod'] = {
      status: 'unavailable',
    };

    expect(ready.current.database).toBe(database);
    expect(failed.error).toBe(error);
    expect('current' in unavailable).toBe(false);
    expect('error' in unavailable).toBe(false);
  });

  it('carries the database generic through public applet host types', () => {
    type Database = { typed: true };

    expectTypeOf<AppletSlotProps<unknown, Database>['host']['solid']['pod']>()
      .toEqualTypeOf<WebExtensionSolidCapability<Database>['pod']>();
    expectTypeOf<Parameters<TwoPaneAppletModule<unknown, Database>['createController']>[0]['solid']['pod']>()
      .toEqualTypeOf<WebExtensionSolidCapability<Database>['pod']>();
    expectTypeOf<Parameters<SinglePaneAppletModule<unknown, Database>['render']>[0]['host']['solid']['pod']>()
      .toEqualTypeOf<WebExtensionSolidCapability<Database>['pod']>();
    expectTypeOf<WebExtensionModule<Database>['applets']>()
      .toEqualTypeOf<Record<string, SinglePaneAppletModule<unknown, Database> | TwoPaneAppletModule<unknown, Database>>>();
  });
});
