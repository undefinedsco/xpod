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
  // 旧续接页不再自动创建（设计第二部分 §4.1 / U05）：深链只做转发或导航，
  // 单纯访问不产生资源。创建改由 Pod 管理页的显式操作承担。
  it.each([false, true])('does not create storage from the continuation page (existing=%s)', async (existing) => {
    const webId = `${window.location.origin}/alice/profile/card#me`;
    const cloud = { webId, storageUrl: `${window.location.origin}/alice/` };
    const local = { webId, storageUrl: `https://node.example/${existing ? 'previous-pod' : 'alice'}/` };
    window.__XPOD__ = { provisionCode: `${btoa(JSON.stringify({ spUrl: 'https://node.example/', serviceToken: 'token', exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature` };
    const onReady = vi.fn();
    vi.mocked(createFirstPodAndWaitForBinding).mockResolvedValue([local]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path === '/.account/bindings') return new Response(JSON.stringify({ bindings: [cloud, local] }));
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
    // 不再推导 Pod 名称、不再创建，也不写回 Account；直接继续。
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(createFirstPodAndWaitForBinding).not.toHaveBeenCalled();
    expect(account.refetchControls).not.toHaveBeenCalled();
  });
});
