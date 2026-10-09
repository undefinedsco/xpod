import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { waitFor } from '@testing-library/react';
import type { SolidSessionAdapter } from '@undefineds.co/solid-sdk';
import { AuthProvider } from '../context/AuthContext';
import { useAuth, type AuthContextType, type Controls } from '../context/AuthContextValue';
import { createXpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { useXpodSolidRuntime } from '../solid/useXpodSolidRuntime';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { XpodSolidRuntimeProvider } from '../solid/XpodSolidRuntimeProvider';
import { AccountAuthBoundary } from './AccountAuthBoundary';

const issuer = 'https://id.example/';
const index = `${issuer}.account/`;
const webId = `${issuer}alice/profile/card#me`;
const owned = (id = 'alice') => ({ account: {
  id, username: id, logout: `${index}${id}/logout/`, webId: `${index}${id}/webid/`,
  clientCredentials: `${index}${id}/client-credentials/`, bindings: `${index}${id}/bindings/`,
} });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
let root: Root | undefined;
let current: AuthContextType;
let host: XpodSolidRuntimeValue;
let observedStates: string[];
function Probe({ boundary = false }: { boundary?: boolean }) {
  const account = useAuth();
  const runtime = useXpodSolidRuntime();
  useLayoutEffect(() => { current = account; host = runtime; observedStates.push(account.accountState.status); });
  return <><span>{account.accountState.status}</span>{boundary && <AccountAuthBoundary><span>owned account</span></AccountAuthBoundary>}</>;
}
beforeEach(() => {
  observedStates = [];
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:3000/pod/models' });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
});

async function mount(cookieControls: Controls = { account: { create: `${index}create/` } }, sessionControls: Controls = owned(), options: { sdkFetch?: typeof fetch; actualIssuer?: string; boundary?: boolean } = {}) {
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/provision/status') return json({ managed: true, registered: true, oidcIssuer: issuer, provisionCode: 'test-local-scope' });
    if (url.href === index) return json({ controls: cookieControls });
    return new Response('', { status: 404 });
  });
  const events = new EventEmitter();
  let info: SolidSessionAdapter['info'] = { isLoggedIn: true, webId };
  const session: SolidSessionAdapter = {
    get info() { return info; }, events,
    fetch: options.sdkFetch ?? vi.fn(async (input: RequestInfo | URL) => String(input) === index
      ? json({ controls: sessionControls })
      : json({ bindings: [{ webId, storageUrl: 'https://local.example/alice/' }] })),
    login: vi.fn(), logout: vi.fn(async () => { info = { isLoggedIn: false }; events.emit('logout'); }),
    handleIncomingRedirect: vi.fn(async () => session.info),
  };
  const runtime = createXpodSolidRuntimeValue({ sessionFactory: () => session });
  runtime.setIssuer(options.actualIssuer ?? issuer);
  expect(await runtime.session.initialize({ restorePreviousSession: true })).toMatchObject({ status: 'authenticated', webId });
  runtime.pod.open = vi.fn(() => new Promise<Awaited<ReturnType<typeof runtime.pod.open>>>(() => {}));
  root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root!.render(<AuthProvider><XpodSolidRuntimeProvider value={runtime}><Probe boundary={options.boundary} /></XpodSolidRuntimeProvider></AuthProvider>);
  });
  return { runtime, session, events, network };
}

test('projects only server-confirmed owned Account controls from the mounted standard SDK session', async () => {
  const { session } = await mount();
  await waitFor(() => expect(current.accountState.status).toBe('authenticated'));
  expect(current.identity).toEqual({ id: 'alice', username: 'alice' });
  expect(current.identity?.webId).toBeUndefined();
  expect(current.controls).toEqual(owned());
  expect(current.idpIndex).toBe(index);
  expect(session.fetch).toHaveBeenCalledWith(index, expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
  await act(async () => { await current.refetchControls(); });
  expect(current.accountState.status).toBe('authenticated');
});

test('keeps a Cookie-authenticated Bob Account independent from the Alice Solid session', async () => {
  await mount(owned('bob'));
  await waitFor(() => expect(current.accountState.status).toBe('authenticated'));
  expect(current.controls).toEqual(owned('bob'));
  expect(current.identity?.id).toBe('bob');
});


test('uses the verified SDK Account source for owned bindings, and refuses foreign Account URLs', async () => {
  const { session } = await mount();
  await waitFor(() => expect(current.accountState.status).toBe('authenticated'));
  const response = await current.accountFetch!(`${index}alice/bindings/`);
  expect(await response.json()).toEqual({ bindings: [{ webId, storageUrl: 'https://local.example/alice/' }] });
  expect(session.fetch).toHaveBeenCalledWith(`${index}alice/bindings/`, expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
  await expect(current.accountFetch!('https://foreign.example/.account/alice/bindings/')).rejects.toThrow('outside current authority');
});

test('does not infer an Account from an authenticated WebID when the server refuses it', async () => {
  await mount(undefined, undefined, { sdkFetch: vi.fn(async () => new Response('', { status: 403 })) });
  await waitFor(() => expect(current.accountState.status).toBe('anonymous'));
  expect(current.identity).toBeUndefined();
  expect(current.controls?.account?.clientCredentials).toBeUndefined();
});

test('keeps Account initializing while a current SDK owned-controls request is pending', async () => {
  let resolve!: (response: Response) => void;
  const sdkFetch = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  await mount(undefined, undefined, { sdkFetch });
  await waitFor(() => expect(sdkFetch).toHaveBeenCalled());
  expect(current.accountState.status).toBe('initializing');
  expect(current.isInitializing).toBe(true);
  await act(async () => resolve(json({ controls: owned() })));
  await waitFor(() => expect(current.accountState.status).toBe('authenticated'));
});

test('revokes SDK Account capabilities on session logout and cannot commit a late owned response', async () => {
  let resolve!: (response: Response) => void;
  const sdkFetch = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  const { runtime } = await mount(undefined, undefined, { sdkFetch });
  await waitFor(() => expect(sdkFetch).toHaveBeenCalled());
  await act(async () => { await runtime.session.logout(); });
  await act(async () => resolve(json({ controls: owned() })));
  await waitFor(() => expect(current.accountState.status).toBe('anonymous'));
  expect(current.identity).toBeUndefined();
});

test('revokes an already issued SDK Account capability when the standard session ends', async () => {
  const { runtime } = await mount();
  await waitFor(() => expect(current.accountState.status).toBe('authenticated'));
  const assertCurrent = current.bindAccountCapability!();
  assertCurrent();
  await act(async () => { await runtime.session.logout(); });
  expect(assertCurrent).toThrow('Account 登录状态已改变');
  await waitFor(() => expect(current.accountState.status).toBe('anonymous'));
});

test('explicit Account logout cannot re-project the still-live SDK source during refresh', async () => {
  const { session } = await mount();
  await waitFor(() => expect(current.accountState.status).toBe('authenticated'));
  const calls = vi.mocked(session.fetch).mock.calls.length;
  await act(async () => { await current.logout(); });
  expect(current.accountState.status).toBe('anonymous');
  await act(async () => { await current.refetchControls(); });
  expect(current.accountState.status).toBe('anonymous');
  expect(vi.mocked(session.fetch).mock.calls).toHaveLength(calls);
});

test('a different SDK issuer cannot establish the discovered Cloud Account', async () => {
  const { session } = await mount(undefined, undefined, { actualIssuer: 'https://foreign.example/' });
  await waitFor(() => expect(current.accountState.status).toBe('anonymous'));
  expect(current.identity).toBeUndefined();
  expect(session.fetch).not.toHaveBeenCalled();
});


test('keeps an in-flight SDK credential holder when its owned Account controls become visible', async () => {
  const indexes: Array<(response: Response) => void> = [];
  let issue!: (response: Response) => void;
  const sdkFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === index) return new Promise<Response>(resolve => indexes.push(resolve));
    if (init?.method === 'POST') return new Promise<Response>(resolve => { issue = resolve; });
    return Promise.resolve(json({ id: 'test-client', webId }));
  });
  await mount(undefined, undefined, { sdkFetch });
  await waitFor(() => expect(indexes.length).toBeGreaterThan(0));
  const initial = indexes.length;
  const pending = host.requestPodAuthorization!();
  await waitFor(() => expect(indexes.length).toBeGreaterThan(initial));
  await act(async () => indexes.at(-1)!(json({ controls: owned() })));
  await waitFor(() => expect(sdkFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
  await act(async () => indexes.slice(0, initial).forEach(resolve => resolve(json({ controls: owned() }))));
  await waitFor(() => expect(current.accountState.status).toBe('authenticated'));
  await act(async () => issue(json({ id: 'test-client', secret: 'fixture-secret', resource: `${index}alice/client-credentials/test-client` })));
  expect(await pending).toMatch(/^Bearer sk-/u);
  expect(sdkFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(sdkFetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
});


test.each([500, 502, 503, 504, 408, 429])('retries SDK Account HTTP %s before accepting its owned controls', async status => {
  let probes = 0;
  // The bounded Account projection probe has its own signal; credential discovery is independent.
  const sdkFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input) !== index || !init?.signal ? json({}) : ++probes === 1
    ? new Response('', { status })
    : json({ controls: owned() }));
  await mount(undefined, undefined, { sdkFetch });
  await waitFor(() => expect(current.accountState.status).toBe('authenticated'), { timeout: 4_000 });
  expect(probes).toBe(2);
  expect(current.identity?.id).toBe('alice');
  expect(observedStates).not.toContain('anonymous');
});

test('keeps persistent SDK Account 503 retryable without displaying another password form', async () => {
  const sdkFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async input => String(input) === index ? new Response('', { status: 503 }) : json({}));
  await mount(undefined, undefined, { sdkFetch, boundary: true });
  await waitFor(() => expect(current.accountState.status).toBe('error'), { timeout: 4_000 });
  expect(sdkFetch.mock.calls.filter(([input, init]) => String(input) === index && init?.signal)).toHaveLength(4);
  expect(current.isAnonymous?.()).toBe(false);
  expect(current.isInitializing).toBe(false);
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('暂时不可用');
  expect(observedStates).not.toContain('anonymous');
  sdkFetch.mockImplementation(async () => json({ controls: owned() }));
  await act(async () => { await current.retry(); });
  expect(current.accountState.status).toBe('authenticated');
  expect(current.identity?.id).toBe('alice');
});

test.each([{}, { controls: null }, { controls: [] }])('retries malformed SDK Account 200 controls %j', async invalid => {
  let probes = 0;
  const sdkFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input) !== index || !init?.signal ? json({}) : json(++probes === 1 ? invalid : { controls: owned() }));
  await mount(undefined, undefined, { sdkFetch });
  await waitFor(() => expect(current.accountState.status).toBe('authenticated'), { timeout: 4_000 });
  expect(probes).toBe(2);
  expect(observedStates).not.toContain('anonymous');
});

test.each([401, 403])('accepts SDK Account HTTP %s as an authority refusal without inventing ownership', async status => {
  const sdkFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async input => String(input) === index ? new Response('', { status }) : json({}));
  await mount(undefined, undefined, { sdkFetch });
  await waitFor(() => expect(current.accountState.status).toBe('anonymous'));
  expect(sdkFetch.mock.calls.filter(([input, init]) => String(input) === index && init?.signal)).toHaveLength(1);
  expect(current.identity).toBeUndefined();
});

test('accepts valid anonymous SDK Account controls as the server authority result', async () => {
  const anonymous: Controls = { account: { create: `${index}create/` }, password: { login: `${index}password/login/` } };
  const sdkFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async input => String(input) === index ? json({ controls: anonymous }) : json({}));
  await mount(undefined, undefined, { sdkFetch });
  await waitFor(() => expect(current.accountState.status).toBe('anonymous'));
  expect(sdkFetch.mock.calls.filter(([input, init]) => String(input) === index && init?.signal)).toHaveLength(1);
  expect(current.controls).toEqual(anonymous);
  expect(current.identity).toBeUndefined();
});


test('uses Cookie-free SDK Account requests without inheriting another actor token', async () => {
  const { session } = await mount();
  await waitFor(() => expect(current.accountState.status).toBe('authenticated'));
  const request = new Request(`${index}alice/bindings/`, {
    method: 'POST', body: 'owner request', credentials: 'include',
    headers: { authorization: 'CSS-Account-Token other-actor-fixture', 'x-fixture': 'preserved' },
  });
  await current.accountFetch!(request, { headers: { authorization: 'CSS-Account-Token inherited-fixture', 'x-fixture': 'overridden' } });
  const [input, init] = vi.mocked(session.fetch).mock.calls.at(-1)!;
  const effective = new Request(input, init);
  expect(effective.credentials).toBe('omit');
  expect(effective.redirect).toBe('error');
  expect(effective.headers.get('authorization')).toBeNull();
  expect(effective.headers.get('x-fixture')).toBe('overridden');
  expect(effective.method).toBe('POST');
  expect(await effective.text()).toBe('owner request');
});

test('keeps Cookie Bob operations on their independent Cookie Account source', async () => {
  const { network, session } = await mount(owned('bob'));
  await waitFor(() => expect(current.accountState.status).toBe('authenticated'));
  const init: RequestInit = { credentials: 'include', headers: { authorization: 'CSS-Account-Token bob-fixture' } };
  await current.accountFetch!(`${index}bob/bindings/`, init);
  expect(network).toHaveBeenCalledWith(`${index}bob/bindings/`, { ...init, redirect: 'error' });
  expect(vi.mocked(session.fetch).mock.calls.some(([input]) => String(input) === `${index}bob/bindings/`)).toBe(false);
  expect(current.identity?.id).toBe('bob');
});


test.each([400, 404])('shows a Chinese retryable SDK Account error for HTTP %s without another password form', async status => {
  const sdkFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async input => String(input) === index
    ? new Response('', { status })
    : json({}));
  await mount(undefined, undefined, { sdkFetch, boundary: true });
  await waitFor(() => expect(current.accountState.status).toBe('error'));
  expect(sdkFetch.mock.calls.filter(([input, init]) => String(input) === index && init?.signal)).toHaveLength(1);
  expect(current.accountState).toEqual({ status: 'error', mode: 'login', message: 'Xpod 登录服务暂时不可用，请稍后重试。' });
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Xpod 登录服务暂时不可用，请稍后重试。');
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(observedStates).not.toContain('anonymous');
  expect(current.isAnonymous?.()).toBe(false);
  sdkFetch.mockImplementation(async () => json({ controls: owned() }));
  await act(async () => { await current.retry(); });
  expect(current.accountState.status).toBe('authenticated');
});
