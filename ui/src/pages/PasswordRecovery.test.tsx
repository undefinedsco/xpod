import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { ForgotPasswordPage } from './ForgotPasswordPage';
import { ResetPasswordPage } from './ResetPasswordPage';

const account: AuthContextType = {
  controls: {}, isInitializing: false, initError: null,
  idpIndex: 'https://id.example/.account/', isLoggedIn: false,
  authenticating: false, hasOidcPending: false,
  refetchControls: async () => undefined, retry: async () => undefined,
  logout: async () => undefined, accountState: { status: 'anonymous', mode: 'login' },
};

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}{location.search}</span>;
}

function renderRecovery(reset: boolean, controls = account.controls) {
  render(<AuthContext.Provider value={{ ...account, controls }}>
    <MemoryRouter initialEntries={[`/.account/login/password/${reset ? 'reset' : 'forgot'}/?returnTo=%2Fsettings%2F&rid=private-reset-record`]}>
      <Routes><Route path="/.account/login/password/reset/" element={<ResetPasswordPage />} /><Route path="/.account/login/password/forgot/" element={<ForgotPasswordPage />} /><Route path="/.account/login/password/" element={<div>Login</div>} /></Routes>
      <LocationProbe />
    </MemoryRouter>
  </AuthContext.Provider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([false, true])('sends recovery to the Account authority with relative controls (reset=%s)', async (reset) => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  renderRecovery(reset, { password: { forgot: '/.account/login/password/forgot/', reset: '/.account/login/password/reset/' } });
  if (reset) {
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-password-123' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'new-password-123' } });
  } else {
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'alice@example.test' } });
  }
  fireEvent.click(screen.getByRole('button', { name: reset ? '重设密码' : '发送重置链接' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    `https://id.example/.account/login/password/${reset ? 'reset' : 'forgot'}/`,
    expect.objectContaining({ method: 'POST', credentials: 'include' }),
  ));
});

it.each([false, true])('returns to login with the application destination but without recovery secrets (reset=%s)', (reset) => {
  renderRecovery(reset);
  fireEvent.click(screen.getByRole('button', { name: '返回登录' }));
  expect(screen.getByTestId('location').textContent).toBe('/.account/login/password/?returnTo=%2Fsettings%2F');
});
