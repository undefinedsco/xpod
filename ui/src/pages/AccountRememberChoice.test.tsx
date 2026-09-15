import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { XpodAccountCredentials } from '../auth/XpodAccountCredentials';
import { WelcomePage } from './WelcomePage';

const account: AuthContextType = {
  controls: { password: { login: '/.account/login/password/' } },
  isInitializing: false, initError: null, idpIndex: '/.account/',
  isLoggedIn: false, authenticating: false, hasOidcPending: false,
  refetchControls: async () => ({ status: 'authenticated' }), retry: async () => undefined,
  logout: async () => undefined, accountState: { status: 'anonymous', mode: 'login' },
};
const surfaces = ['welcome', 'embedded', 'page'] as const;
function renderLogin(surface: typeof surfaces[number]) {
  render(<AuthContext.Provider value={account}><MemoryRouter>
    {surface === 'welcome' ? <WelcomePage /> : <XpodAccountCredentials surface={surface} />}
  </MemoryRouter></AuthContext.Provider>);
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'alice@example.test' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password-123' } });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); window.sessionStorage.clear(); });

it.each(surfaces)('preserves the default remember choice in %s Account login', async (surface) => {
  const requests: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response('{}', { status: 401 });
  }));
  renderLogin(surface);
  expect((screen.getByRole('checkbox', { name: '记住账号' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({ remember: true });
});

it.each(surfaces)('keeps remember disabled across failed login and retry in %s', async (surface) => {
  const requests: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response('{}', { status: 401 });
  }));
  renderLogin(surface);
  fireEvent.click(screen.getByRole('checkbox', { name: '记住账号' }));
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  await screen.findByRole('alert');
  expect((screen.getByRole('checkbox', { name: '记住账号' }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests).toEqual([
    expect.objectContaining({ remember: false }), expect.objectContaining({ remember: false }),
  ]);
});

it.each(surfaces)('locks the remember choice while %s submits credentials', async (surface) => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  renderLogin(surface);
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '记住账号' }) as HTMLInputElement).disabled).toBe(true));
  await waitFor(() => expect(finish).toBeDefined());
  finish(new Response('{}', { status: 401 }));
  await screen.findByRole('alert');
  expect((screen.getByRole('checkbox', { name: '记住账号' }) as HTMLInputElement).disabled).toBe(false);
});
