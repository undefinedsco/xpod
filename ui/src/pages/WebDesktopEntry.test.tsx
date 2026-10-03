// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import WebDesktopEntry from './WebDesktopEntry';
import { AccountPodManagementPage } from './AccountPodManagementPage';
vi.mock('../auth/AccountPodManagement', () => ({ AccountPodManagement: () => <div>desktop Pod management</div> }));
import { saveConsentContinuation, saveManagementContinuation } from '../utils/safe-continuation';
const session = vi.hoisted(() => ({ accountId: 'alice', accountIndex: '/.account/' as string | undefined, valid: true, guard: vi.fn(), bind: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ AuthProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../context/AuthContextValue', () => ({ useAuth: () => ({
  identity: { id: session.accountId }, controls: { account: { id: session.accountId } }, bindAccountCapability: session.bind, idpIndex: session.accountIndex,
}) }));
beforeEach(() => {
  window.xpodDesktop = undefined;
  session.accountId = 'alice'; session.valid = true; session.guard.mockReset(); session.bind.mockReset();
  session.accountIndex = '/.account/';
  session.guard.mockImplementation(() => { if (!session.valid) throw new Error('revoked'); });
  session.bind.mockReturnValue(session.guard);
  sessionStorage.clear(); history.replaceState({}, '', '/settings/pod');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test('offers an actual desktop download and lightweight account entry without starting a Pod operation', async () => {
  const network = vi.fn(); vi.stubGlobal('fetch', network); render(<WebDesktopEntry />);
  expect(screen.getByRole('link', { name: '下载桌面 Xpod' }).getAttribute('href')).toBe('https://github.com/undefinedsco/xpod/releases/latest');
  expect(screen.getByRole('link', { name: '账号页面' }).getAttribute('href')).toBe(`${location.origin}/.account/account/`);
  await waitFor(() => expect(session.guard).toHaveBeenCalled());
  expect(network).not.toHaveBeenCalled();
});
test('managed Local links to the discovered Cloud account authority', () => {
  session.accountIndex = 'https://id.example/.account/'; render(<WebDesktopEntry />);
  expect(screen.getByRole('link', { name: '账号页面' }).getAttribute('href')).toBe('https://id.example/.account/account/');
});
test('an unknown or unsafe Account index cannot fall back to a local account', () => {
  session.accountIndex = undefined; const view = render(<WebDesktopEntry />);
  expect(screen.queryByRole('link', { name: '账号页面' })).toBeNull();
  session.accountIndex = 'https://user:password@id.example/.account/'; view.rerender(<WebDesktopEntry />);
  expect(screen.queryByRole('link', { name: '账号页面' })).toBeNull();
});
test('return to consent requires a live exact interaction and rechecks it on click', async () => {
  saveConsentContinuation({ accountId: 'alice', interaction: '/.account/interaction/request-a', returnTo: '/.account/interaction/request-a/oidc/consent/' });
  const network = vi.fn().mockResolvedValueOnce(Response.json({ client: { client_id: 'application-a' } }))
    .mockResolvedValueOnce(new Response('', { status: 410 }));
  vi.stubGlobal('fetch', network); render(<WebDesktopEntry />);
  fireEvent.click(await screen.findByRole('button', { name: '回到授权' }));
  await screen.findByRole('alert');
  expect(network).toHaveBeenCalledTimes(2);
  expect(network.mock.calls.every(([url, options]) => url.endsWith('/request-a/oidc/consent/') && options.method === 'GET' && options.redirect === 'manual')).toBe(true);
  expect(screen.queryByRole('button', { name: '回到授权' })).toBeNull();
});
test('account switch hides the previous tab task before any click', async () => {
  saveManagementContinuation({ accountId: 'alice', returnTo: '/.account/account/' });
  const view = render(<WebDesktopEntry />);
  await screen.findByRole('button', { name: '返回账号' });
  session.accountId = 'bob'; view.rerender(<WebDesktopEntry />);
  expect(screen.queryByRole('button', { name: '返回账号' })).toBeNull();
  await waitFor(() => expect(session.guard.mock.calls.length).toBeGreaterThan(1));
});
test('an account revoked during the authority response cannot offer a return to the old request', async () => {
  saveConsentContinuation({ accountId: 'alice', interaction: '/.account/interaction/request-a', returnTo: '/.account/interaction/request-a/oidc/consent/' });
  const network = vi.fn(async () => { session.valid = false; return Response.json({ client: { client_id: 'application-a' } }); });
  vi.stubGlobal('fetch', network); render(<WebDesktopEntry />);
  await waitFor(() => expect(network).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(session.guard.mock.calls.length).toBeGreaterThan(1));
  expect(screen.queryByRole('button', { name: '回到授权' })).toBeNull();
});

test('legacy Account Pod management admission stays lightweight in a browser', async () => {
  const network = vi.fn(); vi.stubGlobal('fetch', network);
  history.replaceState({}, '', '/.account/interaction/request-a/manage-pod/');
  render(<AccountPodManagementPage />);
  expect(screen.getByRole('heading', { name: '在桌面 Xpod 中管理' })).toBeTruthy();
  expect(screen.queryByText('desktop Pod management')).toBeNull();
  await waitFor(() => expect(session.guard).toHaveBeenCalled());
  expect(network).not.toHaveBeenCalled();
});

test('legacy Account Pod management admission preserves desktop management', () => {
  window.xpodDesktop = { setIdentity: vi.fn() };
  render(<AccountPodManagementPage />);
  expect(screen.getByText('desktop Pod management')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: '在桌面 Xpod 中管理' })).toBeNull();
});
