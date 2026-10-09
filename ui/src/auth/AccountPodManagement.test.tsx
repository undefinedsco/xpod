// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { saveConsentContinuation, saveManagementContinuation, peekConsentContinuation } from '../utils/safe-continuation';
import * as firstPod from '../utils/consent-first-pod';
import * as pod from '../utils/pod';
import { AccountPodManagement } from './AccountPodManagement';

vi.mock('./account-storage-bindings', () => ({ fetchAccountStorageBindings: vi.fn(async () => []) }));
const interaction = '/.account/interaction/original';
const returnTo = `${interaction}/oidc/consent/`;

function setup(options: { management?: boolean; expired?: boolean } = {}) {
  const browserWindow = window;
  const navigation = { origin: browserWindow.location.origin, pathname: `${interaction}/manage-pod/`, assign: vi.fn() };
  const facade = Object.create(browserWindow);
  Object.defineProperty(facade, 'location', { value: navigation });
  vi.stubGlobal('window', facade);
  let valid = true;
  const assertCurrent = () => { if (!valid) throw new Error('Account changed'); };
  const auth: AuthContextType = {
    controls: { account: { id: 'alice' }, oidc: { cancel: `${interaction}/oidc/cancel/` } },
    identity: { id: 'alice' }, idpIndex: '/.account/', isLoggedIn: true,
    isInitializing: false, initError: null, authenticating: false, hasOidcPending: true,
    accountState: { status: 'authenticated' }, bindAccountCapability: () => assertCurrent,
    refetchControls: vi.fn(), retry: vi.fn(), logout: vi.fn(),
  };
  if (options.management) saveManagementContinuation({ accountId: 'alice', returnTo: '/.account/account/' });
  else saveConsentContinuation({ accountId: 'alice', interaction, returnTo });
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(
    init?.method === 'POST' ? { location: '/cancelled' } : options.expired ? {} : { client: { client_id: 'app' } },
  ), { status: options.expired ? 404 : 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const view = render(<AuthContext.Provider value={auth}><AccountPodManagement /></AuthContext.Provider>);
  return { navigation, fetchMock, auth, view, invalidate: () => { valid = false; } };
}

afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.sessionStorage.clear();
});

it('reconfirms the exact original interaction on return and consumes it once without creation', async () => {
  const { navigation, fetchMock } = setup();
  fireEvent.click(await screen.findByRole('button', { name: '回到授权' }));
  await waitFor(() => expect(navigation.assign).toHaveBeenCalledWith(returnTo));
  expect(fetchMock.mock.calls.map(([input]) => new URL(String(input), window.location.origin).pathname)).toEqual([returnTo, returnTo]);
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(peekConsentContinuation({ accountId: 'alice' })).toBeNull();
});

it('scopes cancellation exactly once even when the control is already interaction-scoped', async () => {
  const { navigation, fetchMock } = setup();
  fireEvent.click(await screen.findByRole('button', { name: '取消授权' }));
  await waitFor(() => expect(navigation.assign).toHaveBeenCalledWith('/cancelled'));
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([input]) => input))
    .toEqual([`${interaction}/oidc/cancel/`]);
  expect(peekConsentContinuation({ accountId: 'alice' })).toBeNull();
});

it('rejects a captured Account session that changed before the return click', async () => {
  const { navigation, fetchMock, invalidate } = setup();
  const button = await screen.findByRole('button', { name: '回到授权' });
  invalidate(); fireEvent.click(button);
  await screen.findByText('这个授权任务已失效，请回到应用重新发起。');
  expect(navigation.assign).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('rejects a captured session that changes during authority confirmation', async () => {
  const { navigation, fetchMock, invalidate } = setup();
  const button = await screen.findByRole('button', { name: '回到授权' });
  fetchMock.mockImplementationOnce(async () => {
    invalidate();
    return new Response(JSON.stringify({ client: { client_id: 'app' } }), { status: 200 });
  });
  fireEvent.click(button);
  await screen.findByText('这个授权任务已失效，请回到应用重新发起。');
  expect(navigation.assign).not.toHaveBeenCalled();
});

it('clears a server-expired interaction instead of offering a stale return', async () => {
  const { navigation, fetchMock } = setup({ expired: true });
  await screen.findByText('这个账号还没有任何存储空间。创建后即可用它授权应用访问。');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(peekConsentContinuation({ accountId: 'alice' })).toBeNull());
  expect(screen.queryByRole('button', { name: '回到授权' })).toBeNull();
  expect(navigation.assign).not.toHaveBeenCalled();
});

it('daily management returns only to Account with no consent request', async () => {
  const { navigation, fetchMock } = setup({ management: true });
  fireEvent.click(await screen.findByRole('button', { name: '返回账号' }));
  expect(navigation.assign).toHaveBeenCalledWith('/.account/account/');
  expect(fetchMock).not.toHaveBeenCalled();
});


it('keeps Cloud creation on its verified Account source while Local preparation uses the original transport', async () => {
  const { auth, view, fetchMock } = setup({ management: true });
  const authority = 'https://id.example/.account/';
  const createUrl = `${authority}alice/pod/`;
  const accountFetch = vi.fn(async () => new Response('{}'));
  auth.idpIndex = authority;
  auth.accountFetch = accountFetch;
  auth.controls = { account: { id: 'alice', pod: createUrl, bindings: `${authority}alice/bindings/` } };
  vi.spyOn(pod, 'resolveProvisionCodeForCurrentScope').mockResolvedValue(undefined);
  const create = vi.spyOn(firstPod, 'createFirstPodAndWaitForBinding').mockImplementation(async options => {
    expect(options.fetchImpl).toBeTypeOf('function');
    options.assertCurrentAccount?.();
    await options.fetchImpl!(createUrl, { method: 'POST' });
    await options.fetchImpl!('/provision/status');
    await options.fetchImpl!('https://card.example/profile/card');
    options.assertCurrentAccount?.();
    return [];
  });
  view.rerender(<AuthContext.Provider value={auth}><AccountPodManagement /></AuthContext.Provider>);
  fireEvent.change(screen.getByLabelText('创建存储空间'), { target: { value: 'alice-pod' } });
  fireEvent.click(screen.getByRole('button', { name: /^创建$/u }));
  await screen.findByText('存储空间已创建。');
  expect(create).toHaveBeenCalledTimes(1);
  expect(accountFetch).toHaveBeenCalledTimes(1);
  expect(accountFetch).toHaveBeenCalledWith(createUrl, { method: 'POST' });
  expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(['/provision/status', 'https://card.example/profile/card']);
});
