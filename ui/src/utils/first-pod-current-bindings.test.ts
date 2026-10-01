// @vitest-environment jsdom
//
// 只有**当前 provision target** 的权威绑定能证明就绪；其他 root、读失败都不能
// 被当作“没有存储”。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveFirstPodCurrentBindings } from './first-pod-current-bindings';

const ACCOUNT_ID = 'alice';
const BINDINGS = `/.account/account/${ACCOUNT_ID}/bindings/`;
const WEBID = `/.account/account/${ACCOUNT_ID}/webid/`;

function makeProvisionCode(payload: Record<string, unknown>): string {
  return `${btoa(JSON.stringify(payload)).replace(/=+$/gu, '')}.signature`;
}

function installProvisionContext(payload: Record<string, unknown>): void {
  window.__XPOD__ = { authenticating: false, provisionCode: makeProvisionCode(payload) };
}

function reset(): void {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.__XPOD__ = undefined;
}

beforeEach(reset);
afterEach(reset);

function requestPath(input: RequestInfo | URL): string {
  return new URL(String(input), window.location.origin).pathname;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function controls(overrides: Record<string, string | undefined> = {}) {
  return { account: { id: ACCOUNT_ID, bindings: BINDINGS, webId: WEBID, ...overrides } };
}

const LIVE_CODE = { spUrl: 'https://node.example/', serviceToken: 'token', exp: Math.floor(Date.now() / 1000) + 3600 };

describe('resolveFirstPodCurrentBindings', () => {
  it('is ready for a durable binding on the current target root, even with an expired code', async () => {
    installProvisionContext({ spUrl: 'https://node-a.example/', spDomain: 'node-a.example', serviceToken: 'token', exp: 1 });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (requestPath(input) === BINDINGS) {
        return jsonResponse({ bindings: [{ webId: 'https://id.example/alice/card#me', storageUrl: 'https://node-a.example/alice/' }] });
      }
      throw new Error(`Unexpected request ${requestPath(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveFirstPodCurrentBindings({ controls: controls(), idpIndex: '/.account/' });

    expect(result.status).toBe('ready');
    expect(result.bindings).toEqual([{ webId: 'https://id.example/alice/card#me', storageUrl: 'https://node-a.example/alice/' }]);
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === WEBID)).toBe(false);
  });

  it('is ready when the live scoped lookup reports the Account storage on the current root', async () => {
    installProvisionContext(LIVE_CODE);
    const webId = 'https://node.example/alice/card#me';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === BINDINGS) return jsonResponse({ bindings: [] });
      if (path === WEBID) return jsonResponse({ webIdLinks: { [webId]: '/.account/webid/alice/' } });
      if (path === '/provision/webids') {
        expect(JSON.parse(String(init?.body))).toEqual({ webIds: [webId] });
        return jsonResponse({ entries: [{ webId, storageUrl: 'https://node.example/alice/' }] });
      }
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveFirstPodCurrentBindings({ controls: controls(), idpIndex: '/.account/' });

    expect(result.status).toBe('ready');
    expect(result.bindings).toEqual([{ webId, storageUrl: 'https://node.example/alice/' }]);
  });

  it('is none when only another root is bound and the current target has nothing', async () => {
    installProvisionContext(LIVE_CODE);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === BINDINGS) {
        return jsonResponse({ bindings: [{ webId: 'https://cloud.example/owner/card#me', storageUrl: 'https://cloud.example/owner/' }] });
      }
      if (path === '/provision/webids') return jsonResponse({ entries: [] });
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveFirstPodCurrentBindings({ controls: controls({ webId: undefined }), idpIndex: '/.account/' });

    expect(result).toEqual({ status: 'none', bindings: [] });
  });

  it('fails closed when the current target needs candidates but the WebID control is missing', async () => {
    installProvisionContext(LIVE_CODE);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (requestPath(input) === BINDINGS) return jsonResponse({ bindings: [] });
      throw new Error(`Unexpected request ${requestPath(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveFirstPodCurrentBindings({ controls: controls({ webId: undefined }), idpIndex: '/.account/' });

    expect(result).toEqual({ status: 'unreadable', bindings: [] });
  });

  it('fails closed when the Account WebID read is broken', async () => {
    installProvisionContext(LIVE_CODE);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === BINDINGS) return jsonResponse({ bindings: [] });
      if (path === WEBID) return jsonResponse({ message: 'boom' }, 500);
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveFirstPodCurrentBindings({ controls: controls(), idpIndex: '/.account/' });

    expect(result).toEqual({ status: 'unreadable', bindings: [] });
  });

  it('is none without a provision target and no durable pair, ready with an unscoped durable pair', async () => {
    window.__XPOD__ = undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (requestPath(input) === BINDINGS) return jsonResponse({ bindings: [] });
      throw new Error(`Unexpected request ${requestPath(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolveFirstPodCurrentBindings({ controls: controls(), idpIndex: '/.account/' }))
      .toEqual({ status: 'none', bindings: [] });

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (requestPath(input) === BINDINGS) {
        return jsonResponse({ bindings: [{ webId: 'https://id.example/alice/card#me', storageUrl: 'https://id.example/alice/' }] });
      }
      throw new Error(`Unexpected request ${requestPath(input)}`);
    }));
    const ready = await resolveFirstPodCurrentBindings({ controls: controls(), idpIndex: '/.account/' });
    expect(ready.status).toBe('ready');
  });
});
