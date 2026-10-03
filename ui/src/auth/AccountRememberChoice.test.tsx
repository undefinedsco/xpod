// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { WelcomePage } from '../pages/WelcomePage';
import { XpodAccountCredentials } from './XpodAccountCredentials';
import { rememberPendingXpodAccountEmail } from './xpod-remembered-login';

const cloudIssuer = 'https://identity.example.test/.account/';
const otherIssuer = 'https://other.example.test/.account/';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function authValue(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    controls: { password: { login: '/.account/login/password/' } },
    idpIndex: cloudIssuer,
    isLoggedIn: false, authenticating: false, hasOidcPending: false,
    isInitializing: false, initError: null,
    accountState: { status: 'anonymous', mode: 'login' },
    refetchControls: vi.fn(), retry: vi.fn(), logout: vi.fn(),
    ...overrides,
  };
}

for (const surface of ['welcome', 'credentials', 'page-credentials'] as const) {
  describe(`${surface} Account remember choice`, () => {
    function view(auth: AuthContextType) {
      return <AuthContext.Provider value={auth}><MemoryRouter>
        {surface === 'welcome' ? <WelcomePage /> : <XpodAccountCredentials surface={surface === 'page-credentials' ? 'page' : 'embedded'} />}
      </MemoryRouter></AuthContext.Provider>;
    }

    it('defaults to unchecked when this authority has no prior choice', () => {
      render(view(authValue()));
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    });

    it('restores an explicit checked choice for the same authority', () => {
      rememberPendingXpodAccountEmail('fixture@example.test', undefined, cloudIssuer, true);
      render(view(authValue()));
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    });

    it('restores an explicit unchecked choice for the same authority', () => {
      rememberPendingXpodAccountEmail('fixture@example.test', undefined, cloudIssuer, false);
      render(view(authValue()));
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    });

    it('waits for the actual Account authority before restoring its choice', () => {
      rememberPendingXpodAccountEmail('fixture@example.test', undefined, cloudIssuer, false);
      const mounted = render(view(authValue({ isInitializing: true, idpIndex: '/.account/' })));
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
      mounted.rerender(view(authValue()));
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    });

    it('keeps a user choice made during bootstrap and scopes it to the first confirmed authority', () => {
      rememberPendingXpodAccountEmail('fixture@example.test', undefined, cloudIssuer, false);
      const mounted = render(view(authValue({ isInitializing: true, idpIndex: '/.account/' })));
      fireEvent.click(screen.getByRole('checkbox'));
      mounted.rerender(view(authValue()));
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
      mounted.rerender(view(authValue({ idpIndex: otherIssuer })));
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    });

    it('waits for authority bootstrap before reading a persistent email hint', () => {
      rememberPendingXpodAccountEmail('alpha@example.test', undefined, cloudIssuer, true);
      const mounted = render(view(authValue({ isInitializing: true, idpIndex: '/.account/' })));
      expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('');
      mounted.rerender(view(authValue()));
      expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('alpha@example.test');
    });

    it('keeps bootstrap-era field edits and clears the password for a different authority', () => {
      rememberPendingXpodAccountEmail('alpha@example.test', undefined, cloudIssuer, true);
      const mounted = render(view(authValue({ isInitializing: true, idpIndex: '/.account/' })));
      fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'typed@example.test' } });
      fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'fixture-password' } });
      mounted.rerender(view(authValue()));
      expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('typed@example.test');
      expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('fixture-password');
      mounted.rerender(view(authValue({ idpIndex: otherIssuer })));
      expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('');
      expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('');
    });

    it('isolates email and password when switching between confirmed authorities', () => {
      rememberPendingXpodAccountEmail('alpha@example.test', undefined, cloudIssuer, true);
      rememberPendingXpodAccountEmail('beta@example.test', undefined, otherIssuer, false);
      const mounted = render(view(authValue()));
      expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('alpha@example.test');
      fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'fixture-password' } });
      mounted.rerender(view(authValue({ idpIndex: otherIssuer })));
      expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('beta@example.test');
      expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('');
      mounted.rerender(view(authValue()));
      expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('alpha@example.test');
    });

    it('does not submit credentials before the Account authority is confirmed', async () => {
      const passwordPosts: unknown[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') passwordPosts.push(init.body);
        return Response.json({ edition: 'local', managed: false });
      }));
      render(view(authValue({ isInitializing: true })));
      fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'typed@example.test' } });
      fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'fixture-password' } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '登录', exact: true })); });
      expect(passwordPosts).toHaveLength(0);
    });

    it('does not inherit another authority choice and keeps the current user edit', () => {
      rememberPendingXpodAccountEmail('fixture@example.test', undefined, otherIssuer, false);
      const mounted = render(view(authValue()));
      const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
      fireEvent.click(checkbox);
      mounted.rerender(view(authValue({ authenticating: true })));
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
      mounted.rerender(view(authValue({ idpIndex: 'https://fresh.example.test/.account/' })));
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    });
  });
}
