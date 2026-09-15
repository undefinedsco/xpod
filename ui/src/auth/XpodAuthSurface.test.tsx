import { cleanup, render, screen } from '@testing-library/react';
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

test('Account login document uses the compact narrow card', () => {
  const setWindowMode = vi.fn();
  vi.stubGlobal('xpodDesktop', { setWindowMode });
  render(<XpodBlockingAccountCredentialsSurface surface="page" surfaceTitle="账号" mode="login"
    values={{ password: '' }} onChange={() => undefined} onSubmit={() => undefined} copy={xpodAccountCredentialsCopy} />);
  expect(screen.getByTestId('web-account-page')).toBeTruthy();
  expect(screen.queryByTestId('auth-surface-page')).toBeNull();
  expect(screen.getByLabelText('邮箱')).toBeTruthy();
  expect(screen.queryByTestId('web-account-introduction')).toBeNull();
  expect(screen.getByTestId('web-account-panel').getAttribute('data-web-account-layout')).toBe('compact');
  expect(setWindowMode).toHaveBeenCalledWith('account');
  const panel = screen.getByTestId('web-account-panel');
  expect(panel.getAttribute('data-web-account-host')).toBe('window');
  expect(panel.className).not.toMatch(/rounded-|border|shadow/);
  expect(screen.getByTestId('web-account-page').className).toContain('bg-background');
});

test('compact Account documents retain their card even inside a desktop workspace', () => {
  const setWindowMode = vi.fn();
  vi.stubGlobal('xpodDesktop', { setWindowMode });
  render(<WebAccountLayout title="账号" presentation="compact">Embedded controls</WebAccountLayout>);
  const panel = screen.getByTestId('web-account-panel');
  expect(panel.getAttribute('data-web-account-host')).toBe('document');
  expect(panel.className).toContain('rounded-xl');
  expect(panel.className).toContain('border');
  expect(setWindowMode).not.toHaveBeenCalled();
});

test('blocking Account login in a browser retains the document card', () => {
  vi.stubGlobal('xpodDesktop', undefined);
  render(<XpodBlockingAccountCredentialsSurface surface="page" surfaceTitle="账号" mode="login"
    values={{ password: '' }} onChange={() => undefined} onSubmit={() => undefined} copy={xpodAccountCredentialsCopy} />);
  const panel = screen.getByTestId('web-account-panel');
  expect(panel.getAttribute('data-web-account-host')).toBe('document');
  expect(panel.className).toContain('rounded-xl');
  expect(panel.className).toContain('border');
});

test('Account registration shares the compact Account frame', () => {
  const setWindowMode = vi.fn();
  vi.stubGlobal('xpodDesktop', { setWindowMode });
  render(<XpodBlockingAccountCredentialsSurface surface="page" surfaceTitle="账号" mode="register"
    values={{ password: '' }} onChange={() => undefined} onSubmit={() => undefined} copy={xpodAccountCredentialsCopy} />);
  expect(screen.getByTestId('web-account-page')).toBeTruthy();
  expect(screen.queryByTestId('auth-surface-page')).toBeNull();
  expect(screen.getByLabelText('邮箱')).toBeTruthy();
  expect(screen.queryByTestId('web-account-introduction')).toBeNull();
  expect(screen.getByTestId('web-account-panel').getAttribute('data-web-account-layout')).toBe('compact');
  expect(setWindowMode).toHaveBeenCalledWith('account');
});

test('CSS consent documents use Account window geometry', () => {
  const setWindowMode = vi.fn();
  vi.stubGlobal('xpodDesktop', { setWindowMode });
  render(<XpodAccountPageSurface title="授权" presentation="compact"><p>Consent</p></XpodAccountPageSurface>);
  expect(screen.getByTestId('web-account-panel').getAttribute('data-web-account-layout')).toBe('compact');
  expect(screen.queryByTestId('web-account-introduction')).toBeNull();
  expect(setWindowMode).toHaveBeenCalledWith('account');
});
