// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { XpodAuthSurface, XpodBlockingAccountCredentialsSurface } from './XpodAuthSurface';

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

  test('locks blocking Account credentials to the same window policy', () => {
    render(
      <XpodBlockingAccountCredentialsSurface
        surface="page"
        surfaceTitle="登录 Xpod"
        mode="login"
        values={{ email: '', password: '' }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        copy={{
          productName: 'Xpod',
          loginTitle: '登录',
          registerTitle: '注册',
          usernameLabel: 'Pod',
          usernamePlaceholder: 'Pod',
          emailLabel: '邮箱',
          emailPlaceholder: '邮箱',
          passwordLabel: '密码',
          passwordPlaceholder: '密码',
          confirmationLabel: '确认密码',
          confirmationPlaceholder: '确认密码',
          loginAction: '登录',
          registerAction: '注册',
          switchToRegister: '注册',
          switchToLogin: '登录',
          usernameChecking: '检查中',
          usernameAvailable: '可用',
          usernameUnavailable: '不可用',
          suggestionsLabel: '建议',
          mismatchError: '不一致',
        }}
      />,
    );

    const surface = screen.getByTestId('auth-surface-page');
    expect(surface.getAttribute('data-auth-surface-host')).toBe('window');
    expect(surface.getAttribute('data-auth-surface-presentation')).toBe('compact');
    expect(screen.getByTestId('auth-surface-body').className).toContain('overflow-y-auto');
  });
});
