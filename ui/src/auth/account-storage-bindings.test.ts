import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Controls } from '../context/AuthContextValue';
import {
  AccountStorageBindingsError,
  fetchAccountStorageBindings,
} from './account-storage-bindings';

describe('account storage bindings client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => key === 'xpod.cssAccountToken' ? 'account-token' : null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });
  });

  it('fetches the exact pair rows from controls.account.bindings with stored Account headers', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      bindings: [
        {
          webId: 'https://app.example/alice/profile/card#me',
          storageUrl: 'https://app.example/alice/',
        },
        {
          webId: 'https://app.example/bob/profile/card#me',
          storageUrl: 'https://app.example/alice/',
        },
      ],
      webIds: ['https://evil.example/should-not-be-used'],
      pods: ['https://app.example/not-authoritative'],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const controls = {
      account: { bindings: '/.account/account/account-1/bindings/' },
    } satisfies Controls;

    await expect(fetchAccountStorageBindings({
      controls,
      origin: 'https://app.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toEqual([
      {
        webId: 'https://app.example/alice/profile/card#me',
        storageUrl: 'https://app.example/alice/',
      },
      {
        webId: 'https://app.example/bob/profile/card#me',
        storageUrl: 'https://app.example/alice/',
      },
    ]);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://app.example/.account/account/account-1/bindings/',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({
          Authorization: 'CSS-Account-Token account-token',
          Accept: 'application/json',
        }),
      }),
    );
  });

  it('rejects a missing control or an endpoint outside the current origin', async () => {
    await expect(fetchAccountStorageBindings({
      controls: { account: {} },
      origin: 'https://app.example',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })).rejects.toMatchObject<AccountStorageBindingsError>({ code: 'missing-control' });

    await expect(fetchAccountStorageBindings({
      controls: { account: { bindings: 'https://evil.example/bindings/' } },
      origin: 'https://app.example',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })).rejects.toMatchObject<AccountStorageBindingsError>({ code: 'cross-origin' });
  });

  it('fails closed on forbidden, failed, malformed, or cross-origin binding responses', async () => {
    const controls = { account: { bindings: '/.account/bindings/' } } satisfies Controls;
    const forbidden = vi.fn(async () => new Response('', { status: 403 }));
    await expect(fetchAccountStorageBindings({
      controls,
      origin: 'https://app.example',
      fetchImpl: forbidden as unknown as typeof fetch,
    })).rejects.toMatchObject<AccountStorageBindingsError>({ code: 'forbidden' });

    const failed = vi.fn(async () => new Response('', { status: 502 }));
    await expect(fetchAccountStorageBindings({
      controls,
      origin: 'https://app.example',
      fetchImpl: failed as unknown as typeof fetch,
    })).rejects.toMatchObject<AccountStorageBindingsError>({ code: 'request-failed' });

    const malformed = vi.fn(async () => new Response(JSON.stringify({ bindings: [{ webId: 'bad' }] }), { status: 200 }));
    await expect(fetchAccountStorageBindings({
      controls,
      origin: 'https://app.example',
      fetchImpl: malformed as unknown as typeof fetch,
    })).rejects.toMatchObject<AccountStorageBindingsError>({ code: 'invalid-response' });

    const crossOrigin = vi.fn(async () => new Response(JSON.stringify({ bindings: [{
      webId: 'https://evil.example/alice/profile/card#me',
      storageUrl: 'https://app.example/alice/',
    }] }), { status: 200 }));
    await expect(fetchAccountStorageBindings({
      controls,
      origin: 'https://app.example',
      fetchImpl: crossOrigin as unknown as typeof fetch,
    })).rejects.toMatchObject<AccountStorageBindingsError>({ code: 'cross-origin' });
  });
});
