import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundPodAccess } from './BackgroundPodAccess';
import { useBackgroundPodAccess } from './useBackgroundPodAccess';
import { XpodSolidRuntimeContext } from '../../../solid/XpodSolidRuntime';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const OTHER_WEB_ID = 'https://pod.example/bob/profile/card#me';
const ISSUER = 'https://pod.example/';
/** The API answers on the page's own origin, whatever the Pod's issuer is. */
const API_ORIGIN = window.location.origin;

function credential(overrides: Record<string, unknown> = {}) {
  return {
    credentialRef: 'taskcred_1', ownerWebId: WEB_ID, issuer: ISSUER, clientId: 'alice-client',
    version: 1, status: 'active', createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A read that stays in flight until the test resolves it, to control which identity answers first. */
function deferredCredentials() {
  let settle: (credentials: unknown[]) => void = () => undefined;
  const fetch = vi.fn(() => new Promise<Response>((resolve) => {
    settle = (credentials) => resolve(Response.json({ data: credentials }));
  }));
  return { fetch, settle: (credentials: unknown[] = []) => settle(credentials) };
}

/** A value the test resolves by hand, to hold a session capability in flight. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, settle: (value: T) => resolve(value) };
}

function postsTo(fetch: unknown): Array<[unknown, RequestInit]> {
  return (fetch as { mock: { calls: Array<[unknown, RequestInit]> } }).mock.calls
    .filter(([, init]) => init?.method === 'POST');
}

function runtimeWrapper(value: unknown) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <XpodSolidRuntimeContext.Provider value={value as never}>{children}</XpodSolidRuntimeContext.Provider>
    );
  }
  return Wrapper;
}

function runtimeValue(overrides: Record<string, unknown> = {}) {
  return {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Response.json({
          credential: {
            credentialRef: 'taskcred_1', ownerWebId: WEB_ID, issuer: ISSUER,
            clientId: 'alice-client', version: 1, status: 'active', createdAt: new Date().toISOString(),
          },
        }, { status: 201 });
      }
      if (init?.method === 'DELETE') {
        return Response.json({ revoked: 'taskcred_1' });
      }
      return Response.json({ data: overrides.existing ?? [] });
    }),
    webId: WEB_ID,
    podUrl: 'https://pod.example/alice/',
    issuer: ISSUER,
    state: { status: 'authenticated', webId: WEB_ID, podUrl: 'https://pod.example/alice/' },
    requestPodApiKey: vi.fn(async () => 'sk-alice-wrapper'),
    requestPodAuthorization: vi.fn(async () => 'Bearer sk-alice-wrapper'),
    ...overrides,
  } as never;
}

function renderPanel(value: unknown, props: Record<string, unknown> = {}) {
  return render(panel(value, props));
}

function panel(value: unknown, props: Record<string, unknown> = {}) {
  return (
    <XpodSolidRuntimeContext.Provider value={value as never}>
      <BackgroundPodAccess {...props} />
    </XpodSolidRuntimeContext.Provider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BackgroundPodAccess', () => {
  it('offers the grant when nothing is on file', async () => {
    renderPanel(runtimeValue());

    expect(await screen.findByText(/未授权/)).toBeDefined();
    expect(screen.getByRole('button', { name: '授权后台任务访问' })).toBeDefined();
  });

  it('grants with the session credential and shows what is on file', async () => {
    const value = runtimeValue();
    renderPanel(value);

    fireEvent.click(await screen.findByRole('button', { name: '授权后台任务访问' }));

    await waitFor(() => {
      expect(screen.getByText(/已授权 · v1/)).toBeDefined();
    });
    const post = (value as unknown as { fetch: { mock: { calls: Array<[unknown, RequestInit]> } } }).fetch.mock.calls
      .find(([, init]) => init?.method === 'POST');
    expect(post).toBeDefined();
    expect(String(post?.[0])).toBe(`${API_ORIGIN}/api/ai/task-credentials`);
    expect(JSON.parse(String(post?.[1].body))).toEqual({ apiKey: 'sk-alice-wrapper', name: 'Xpod 后台任务' });
  });

  it('describes an existing grant and revokes it', async () => {
    const existing = [{
      credentialRef: 'taskcred_9', ownerWebId: WEB_ID, issuer: ISSUER, clientId: 'alice-client',
      version: 2, status: 'active', createdAt: new Date().toISOString(),
      lastUsedAt: new Date('2026-09-24T10:00:00Z').toISOString(),
    }];
    const value = runtimeValue({ existing });
    renderPanel(value);

    expect(await screen.findByText(/已授权 · v2/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '撤销授权' }));

    await waitFor(() => {
      expect(screen.getByText(/未授权/)).toBeDefined();
    });
    const del = (value as unknown as { fetch: { mock: { calls: Array<[unknown, RequestInit]> } } }).fetch.mock.calls
      .find(([, init]) => init?.method === 'DELETE');
    expect(String(del?.[0])).toBe(`${API_ORIGIN}/api/ai/task-credentials/taskcred_9`);
  });

  it('shows a refusal notice and continues the blocked action after granting', async () => {
    const onGranted = vi.fn();
    renderPanel(runtimeValue(), { notice: 'Rebuild VECTOR needs background Pod access.', onGranted });

    expect(await screen.findByText('Rebuild VECTOR needs background Pod access.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '授权后台任务访问' }));

    await waitFor(() => {
      expect(onGranted).toHaveBeenCalledTimes(1);
    });
  });

  it('reports a session that cannot prepare a credential', async () => {
    renderPanel(runtimeValue({ requestPodApiKey: vi.fn(async () => undefined) }));

    fireEvent.click(await screen.findByRole('button', { name: '授权后台任务访问' }));

    expect(await screen.findByText('当前会话无法准备凭据')).toBeDefined();
  });

  it('surfaces a refused grant without leaving the panel stuck', async () => {
    const value = runtimeValue({
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'POST'
        ? Response.json({ error: 'task_credential_storage_unconfigured' }, { status: 503 })
        : Response.json({ data: [] }))),
    });
    renderPanel(value);

    fireEvent.click(await screen.findByRole('button', { name: '授权后台任务访问' }));

    expect(await screen.findByText('task_credential_storage_unconfigured')).toBeDefined();
    expect(screen.getByRole('button', { name: '授权后台任务访问' })).toBeDefined();
  });

  it('clears the granted identity on logout and never offers it to the next one', async () => {
    const view = renderPanel(runtimeValue({ existing: [credential({ credentialRef: 'taskcred_a', version: 3 })] }));
    expect(await screen.findByText(/已授权 · v3/)).toBeDefined();

    // Logout: no WebID, so nothing is granted and no credential may be revoked.
    view.rerender(panel(runtimeValue({ webId: undefined })));
    expect(screen.queryByText(/已授权 · v3/)).toBeNull();
    expect(screen.getByText(/未授权/)).toBeDefined();

    // A second identity signs in; its read is still pending, so the panel must stay empty.
    const pendingRead = deferredCredentials();
    view.rerender(panel(runtimeValue({ webId: OTHER_WEB_ID, fetch: pendingRead.fetch })));
    expect(screen.queryByText(/已授权 · v3/)).toBeNull();
    expect(screen.queryByRole('button', { name: '撤销授权' })).toBeNull();
  });

  it('hides the first identity credential as soon as a second identity takes over', async () => {
    const view = renderPanel(runtimeValue({ existing: [credential({ credentialRef: 'taskcred_a', version: 9 })] }));
    expect(await screen.findByText(/已授权 · v9/)).toBeDefined();

    const pendingRead = deferredCredentials();
    view.rerender(panel(runtimeValue({ webId: OTHER_WEB_ID, fetch: pendingRead.fetch })));
    // The old grant belongs to another WebID: it is neither shown nor revocable here.
    expect(screen.queryByText(/已授权 · v9/)).toBeNull();
    expect(screen.queryByRole('button', { name: '撤销授权' })).toBeNull();
    expect(screen.getByRole('button', { name: '授权后台任务访问' })).toBeDefined();
  });

  it('keeps an answer from the previous identity out of the new session', async () => {
    const slowRead = deferredCredentials();
    const view = renderPanel(runtimeValue({ fetch: slowRead.fetch }));
    expect(screen.getByText(/未授权/)).toBeDefined();

    view.rerender(panel(runtimeValue({
      webId: OTHER_WEB_ID,
      existing: [credential({ credentialRef: 'taskcred_b', ownerWebId: OTHER_WEB_ID, clientId: 'bob-client', version: 1 })],
    })));
    expect(await screen.findByText(/已授权 · v1/)).toBeDefined();

    await act(async () => {
      slowRead.settle([credential({ credentialRef: 'taskcred_a', version: 7 })]);
    });
    expect(screen.getByText(/已授权 · v1/)).toBeDefined();
    expect(screen.queryByText(/已授权 · v7/)).toBeNull();
  });

  it('starts the same identity from an empty panel when it signs back in', async () => {
    const view = renderPanel(runtimeValue({ existing: [credential({ credentialRef: 'taskcred_a', version: 3 })] }));
    expect(await screen.findByText(/已授权 · v3/)).toBeDefined();

    view.rerender(panel(runtimeValue({ webId: undefined })));
    expect(screen.queryByText(/已授权 · v3/)).toBeNull();
    expect(screen.getByText(/未授权/)).toBeDefined();

    // The same identity signs back in: the grant left by the previous sign-in is not this one's,
    // so the panel waits for the new read instead of offering the old credential for revocation.
    const pending = deferredCredentials();
    view.rerender(panel(runtimeValue({ webId: WEB_ID, fetch: pending.fetch })));
    expect(screen.queryByText(/已授权 · v3/)).toBeNull();
    expect(screen.queryByRole('button', { name: '撤销授权' })).toBeNull();
    expect((screen.getByRole('button', { name: '授权后台任务访问' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { pending.settle([credential({ credentialRef: 'taskcred_a2', version: 4 })]); });
    expect(await screen.findByText(/已授权 · v4/)).toBeDefined();
  });

  it('does not reuse a returning identity grant from before another identity signed in', async () => {
    const view = renderPanel(runtimeValue({ existing: [credential({ credentialRef: 'taskcred_a', version: 4 })] }));
    expect(await screen.findByText(/已授权 · v4/)).toBeDefined();

    view.rerender(panel(runtimeValue({ webId: OTHER_WEB_ID, fetch: deferredCredentials().fetch })));
    expect(screen.queryByText(/已授权 · v4/)).toBeNull();

    const pending = deferredCredentials();
    view.rerender(panel(runtimeValue({ webId: WEB_ID, fetch: pending.fetch })));
    expect(screen.queryByText(/已授权 · v4/)).toBeNull();
    expect(screen.queryByRole('button', { name: '撤销授权' })).toBeNull();
    expect((screen.getByRole('button', { name: '授权后台任务访问' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { pending.settle([credential({ credentialRef: 'taskcred_a2', version: 5 })]); });
    expect(await screen.findByText(/已授权 · v5/)).toBeDefined();
  });

  it('does not let a read from an earlier sign-in overwrite the new one', async () => {
    const staleRead = deferredCredentials();
    const view = renderPanel(runtimeValue({ fetch: staleRead.fetch }));
    expect(screen.getByText(/未授权/)).toBeDefined();

    view.rerender(panel(runtimeValue({ webId: undefined })));
    const freshRead = deferredCredentials();
    view.rerender(panel(runtimeValue({ webId: WEB_ID, fetch: freshRead.fetch })));

    await act(async () => { freshRead.settle([credential({ credentialRef: 'taskcred_new', version: 8 })]); });
    expect(await screen.findByText(/已授权 · v8/)).toBeDefined();

    await act(async () => { staleRead.settle([credential({ credentialRef: 'taskcred_old', version: 7 })]); });
    expect(screen.getByText(/已授权 · v8/)).toBeDefined();
    expect(screen.queryByText(/已授权 · v7/)).toBeNull();
  });

  it('drops a grant whose session ended while the key was being prepared', async () => {
    const key = deferred<string | undefined>();
    const first = runtimeValue({ requestPodApiKey: vi.fn(() => key.promise) });
    const view = renderPanel(first);

    fireEvent.click(await screen.findByRole('button', { name: '授权后台任务访问' }));
    expect(await screen.findByRole('button', { name: '正在授权…' })).toBeDefined();

    const second = runtimeValue({ webId: OTHER_WEB_ID });
    view.rerender(panel(second));

    await act(async () => { key.settle('sk-alice-wrapper'); });

    expect(postsTo(first.fetch)).toHaveLength(0);
    expect(postsTo(second.fetch)).toHaveLength(0);
  });

  it('clears a read failure once a reload succeeds', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'task_credential_storage_unconfigured' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [credential({ credentialRef: 'taskcred_ok', version: 2 })] }));
    const value = runtimeValue({ fetch: read });
    const { result } = renderHook(() => useBackgroundPodAccess(), { wrapper: runtimeWrapper(value) });

    await waitFor(() => { expect(result.current.error).toBe('task_credential_storage_unconfigured'); });
    expect(result.current.credential).toBeUndefined();

    await act(async () => { await result.current.reload(); });

    expect(result.current.error).toBeUndefined();
    expect(result.current.credential?.credentialRef).toBe('taskcred_ok');
  });
});
