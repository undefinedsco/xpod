// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { createFirstPodAndWaitForBinding } from '../utils/consent-first-pod';
import { FirstPodPage } from './FirstPodPage';

vi.mock('../utils/consent-first-pod', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/consent-first-pod')>(),
  createFirstPodAndWaitForBinding: vi.fn(),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); window.__XPOD__ = undefined; window.sessionStorage.clear(); });

describe('FirstPodPage authorization continuation', () => {
  it.each([false, true])('waits for durable Local ownership and recovers prepared storage (existing=%s)', async (existing) => {
    const webId = `${window.location.origin}/alice/profile/card#me`;
    const cloud = { webId, storageUrl: `${window.location.origin}/alice/` };
    const local = { webId, storageUrl: `https://node.example/${existing ? 'previous-pod' : 'alice'}/` };
    window.__XPOD__ = { provisionCode: `${btoa(JSON.stringify({ spUrl: 'https://node.example/', serviceToken: 'token', exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature` };
    let committed = false;
    const onReady = vi.fn();
    vi.mocked(createFirstPodAndWaitForBinding).mockResolvedValue([local]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path === '/.account/bindings') return new Response(JSON.stringify({ bindings: committed ? [cloud, local] : [cloud] }));
      if (path === '/provision/webids') return new Response(JSON.stringify({ entries: existing ? [local] : [] }));
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const account = {
      controls: { account: { username: 'alice', bindings: '/.account/bindings', pod: '/.account/pod' } },
      idpIndex: `${window.location.origin}/.account/`, hasOidcPending: false,
      refetchControls: vi.fn(),
    } as unknown as AuthContextType;
    render(<AuthContext.Provider value={account}><MemoryRouter><FirstPodPage onReady={onReady} /></MemoryRouter></AuthContext.Provider>);
    await waitFor(() => expect(createFirstPodAndWaitForBinding).toHaveBeenCalledTimes(1));
    expect(createFirstPodAndWaitForBinding).toHaveBeenCalledWith(expect.objectContaining({ username: existing ? 'previous-pod' : 'alice' }));
    expect(onReady).not.toHaveBeenCalled();
    committed = true;
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(account.refetchControls).not.toHaveBeenCalled();
  });
});
