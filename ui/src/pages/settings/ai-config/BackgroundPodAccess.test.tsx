import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundPodAccess } from './BackgroundPodAccess';
import { XpodSolidRuntimeContext } from '../../../solid/XpodSolidRuntime';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const ISSUER = 'https://pod.example/';
/** The API answers on the page's own origin, whatever the Pod's issuer is. */
const API_ORIGIN = window.location.origin;

function runtimeValue(overrides: Record<string, unknown> = {}) {
  return {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
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
  return render(
    <XpodSolidRuntimeContext.Provider value={value as never}>
      <BackgroundPodAccess {...props} />
    </XpodSolidRuntimeContext.Provider>,
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
});
