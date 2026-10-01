import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { XpodAccountPageSurface, XpodAuthSurface, XpodBlockingAccountCredentialsSurface } from './XpodAuthSurface';
import { xpodAccountCredentialsCopy } from './xpod-account-copy';
import { WebAccountLayout } from './WebAccountLayout';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('XpodAuthSurface', () => {
  beforeEach(() => {
    window.xpodDesktop = { setIdentity: vi.fn(), setWindowMode: vi.fn() };
  });

  afterEach(() => {
    cleanup();
    delete window.xpodDesktop;
  });

  test.each(['page', 'modal'] as const)(
    'locks the %s presentation to the current window',
    (mode) => {
      render(
        <XpodAuthSurface mode={mode} title="登录 Xpod">
          <span>content</span>
        </XpodAuthSurface>,
      );

      const surface = screen.getByTestId(`auth-surface-${mode}`);
      const frame = mode === 'modal'
        ? screen.getByRole('dialog', { name: '登录 Xpod' })
        : screen.getByRole('region', { name: '登录 Xpod' });
      expect(surface.getAttribute('data-auth-surface-host')).toBe('window');
      expect(surface.getAttribute('data-auth-surface-presentation')).toBe('compact');
      expect(surface.className).not.toContain('bg-black/50');
      expect(frame.getAttribute('data-auth-surface-frame')).toBe('window');
      expect(frame.className).toContain('h-full');
      expect(frame.className).toContain('w-full');
      expect(window.xpodDesktop?.setWindowMode).toHaveBeenCalledWith('auth');
    },
  );

  test('restores workspace mode only after the authentication surface leaves', () => {
    const { unmount } = render(
      <XpodAuthSurface mode="modal" title="登录 Xpod">content</XpodAuthSurface>,
    );
    const setWindowMode = window.xpodDesktop?.setWindowMode;

    expect(setWindowMode).toHaveBeenLastCalledWith('auth');
    unmount();
    expect(setWindowMode).toHaveBeenLastCalledWith('workspace');
  });


});

test('generic WebID auth preserves its lead without becoming a CSS Account document', () => {
  vi.stubGlobal('xpodDesktop', undefined);
  render(<XpodAuthSurface mode="page" title="WebID login" lead={<p>Identity-specific lead</p>}><p>Login action</p></XpodAuthSurface>);
  expect(screen.queryByTestId('web-account-page')).toBeNull();
  expect(screen.getByText('Identity-specific lead')).toBeTruthy();
  expect(screen.getByText('Login action')).toBeTruthy();
});

test('Account login document uses the Pod sign-in window frame in the desktop shell', () => {
  const setWindowMode = vi.fn();
  vi.stubGlobal('xpodDesktop', { setWindowMode });
  render(<XpodBlockingAccountCredentialsSurface surface="page" surfaceTitle="账号" mode="login"
    values={{ password: '' }} onChange={() => undefined} onSubmit={() => undefined} copy={xpodAccountCredentialsCopy} />);
  expect(screen.getByTestId('web-account-page')).toBeTruthy();
  expect(screen.queryByTestId('auth-surface-page')).toBeNull();
  expect(screen.getByLabelText('邮箱')).toBeTruthy();
  expect(screen.queryByTestId('web-account-introduction')).toBeNull();
  expect(screen.getByTestId('web-account-panel').getAttribute('data-web-account-layout')).toBe('window');
  expect(setWindowMode).toHaveBeenCalledWith('account');
  const panel = screen.getByTestId('web-account-panel');
  expect(panel.getAttribute('data-web-account-host')).toBe('window');
  const frame = screen.getByRole('region', { name: '账号' });
  expect(frame.getAttribute('data-pod-sign-in-frame')).toBe('window');
  expect(frame.className).toContain('bg-background');
  expect(panel.className).not.toMatch(/rounded-|border|shadow/);
  // Service bar and the single heading come from the shared sign-in view.
  expect(screen.getByText(/Xpod · 账号服务/)).toBeTruthy();
  expect(screen.getAllByRole('heading')).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1, name: '登录 Xpod' })).toBeTruthy();
});

test('Account documents embedded in a desktop workspace stay a page frame and keep the sign-in service bar', () => {
  const setWindowMode = vi.fn();
  vi.stubGlobal('xpodDesktop', { setWindowMode });
  render(<WebAccountLayout title="账号">Embedded controls</WebAccountLayout>);
  const panel = screen.getByTestId('web-account-panel');
  expect(panel.getAttribute('data-web-account-host')).toBe('document');
  expect(panel.getAttribute('data-web-account-layout')).toBe('page');
  expect(screen.getByRole('heading', { level: 1, name: '账号' }).className).toContain('text-[17px]');
  expect(screen.getByRole('region', { name: '账号' }).getAttribute('data-pod-sign-in-frame')).toBe('page');
  expect(screen.getByText(/Xpod · 账号服务/)).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1, name: '账号' })).toBeTruthy();
  // The retired tagline is gone.
  expect(screen.queryByText('Personal Messages Platform')).toBeNull();
  expect(setWindowMode).not.toHaveBeenCalled();
});

test('blocking Account login in a browser uses the page frame', () => {
  vi.stubGlobal('xpodDesktop', undefined);
  render(<XpodBlockingAccountCredentialsSurface surface="page" surfaceTitle="账号" mode="login"
    values={{ password: '' }} onChange={() => undefined} onSubmit={() => undefined} copy={xpodAccountCredentialsCopy} />);
  const panel = screen.getByTestId('web-account-panel');
  expect(panel.getAttribute('data-web-account-host')).toBe('document');
  expect(screen.getByRole('region', { name: '账号' }).getAttribute('data-pod-sign-in-frame')).toBe('page');
});

test('Account login and registration are the shared sign-in and register views, presentation only', () => {
  vi.stubGlobal('xpodDesktop', undefined);
  const onSubmit = vi.fn();
  const onChange = vi.fn();
  const onFieldChange = vi.fn();
  const onModeChange = vi.fn();
  const onRegister = vi.fn();
  const { rerender } = render(<XpodBlockingAccountCredentialsSurface surface="page" surfaceTitle="账号" mode="login"
    values={{ email: 'a@example.test', password: '' }} onChange={onChange} onFieldChange={onFieldChange}
    onSubmit={onSubmit} onModeChange={onModeChange} onRegister={onRegister}
    rememberAccount onRememberAccountChange={() => undefined} copy={xpodAccountCredentialsCopy} />);
  expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('a@example.test');
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw' } });
  expect(onChange).toHaveBeenCalledWith({ email: 'a@example.test', password: 'pw' });
  expect(onFieldChange).toHaveBeenCalledWith('password', 'pw');
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(onSubmit).toHaveBeenCalledWith({ email: 'a@example.test', password: 'pw' });
  fireEvent.click(screen.getByRole('button', { name: '注册账号' }));
  expect(onRegister).toHaveBeenCalledTimes(1);

  rerender(<XpodBlockingAccountCredentialsSurface surface="page" surfaceTitle="账号" mode="register"
    values={{ email: '', password: '' }} onChange={onChange}
    onSubmit={onSubmit} onModeChange={onModeChange} copy={xpodAccountCredentialsCopy}
    />);
  expect(screen.getByRole('heading', { level: 1, name: '注册 Xpod' })).toBeTruthy();
  // Registration only collects Account fields; the Pod name is asked for at consent.
  expect(screen.queryByLabelText('Pod 名称')).toBeNull();
  expect(screen.getByLabelText('邮箱')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '已有账号？登录' }));
  expect(onModeChange).toHaveBeenCalledWith('login');
});

test('Account registration shares the Account frame', () => {
  const setWindowMode = vi.fn();
  vi.stubGlobal('xpodDesktop', { setWindowMode });
  render(<XpodBlockingAccountCredentialsSurface surface="page" surfaceTitle="账号" mode="register"
    values={{ password: '' }} onChange={() => undefined} onSubmit={() => undefined} copy={xpodAccountCredentialsCopy} />);
  expect(screen.getByTestId('web-account-page')).toBeTruthy();
  expect(screen.queryByTestId('auth-surface-page')).toBeNull();
  expect(screen.getByLabelText('邮箱')).toBeTruthy();
  expect(screen.queryByTestId('web-account-introduction')).toBeNull();
  expect(screen.getByTestId('web-account-panel').getAttribute('data-web-account-layout')).toBe('window');
  expect(setWindowMode).toHaveBeenCalledWith('account');
});

test('CSS consent documents use Account window geometry', () => {
  const setWindowMode = vi.fn();
  vi.stubGlobal('xpodDesktop', { setWindowMode });
  render(<XpodAccountPageSurface title="授权"><p>Consent</p></XpodAccountPageSurface>);
  expect(screen.getByTestId('web-account-panel').getAttribute('data-web-account-layout')).toBe('window');
  expect(screen.queryByTestId('web-account-introduction')).toBeNull();
  expect(setWindowMode).toHaveBeenCalledWith('account');
});

test('a browser page frame shows the account-service introduction the host supplies', () => {
  vi.stubGlobal('xpodDesktop', undefined);
  render(<WebAccountLayout title="登录 Xpod" intro={<p>账号服务介绍</p>}>content</WebAccountLayout>);
  const intro = screen.getByText('账号服务介绍');
  expect(intro.closest('[data-pod-sign-in="intro"]')).toBeTruthy();
});

test.each([['window', 'window'], ['document', 'page']] as const)('WebAccountLayout puts its layout and host attributes on the region element (%s host)', (host, frame) => {
  vi.stubGlobal('xpodDesktop', undefined);
  render(<WebAccountLayout title="账号" host={host}>content</WebAccountLayout>);
  const region = screen.getByRole('region', { name: '账号' });
  expect(region.getAttribute('data-web-account-layout')).toBe(host === 'window' ? 'window' : 'page');
  expect(region.getAttribute('data-web-account-host')).toBe(host);
  // Without an intro the body keeps the full width; the intro column is host-supplied.
  expect(region.querySelector('[data-pod-sign-in="intro"]')).toBeNull();
  expect(region.getAttribute('data-pod-sign-in-frame')).toBe(frame);
});
