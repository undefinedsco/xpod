import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LoadingScreen } from './LoadingScreen';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LoadingScreen', () => {
  test('keeps Web Account initialization inside its compact document panel', () => {
    vi.stubGlobal('xpodDesktop', undefined);
    render(<LoadingScreen />);

    const page = screen.getByTestId('web-account-page');
    const frame = screen.getByRole('region', { name: '正在加载 Xpod' });
    expect(screen.queryByTestId('auth-surface-page')).toBeNull();
    expect(screen.queryByTestId('web-account-introduction')).toBeNull();
    expect(frame.getAttribute('data-web-account-layout')).toBe('compact');
    expect(frame.getAttribute('data-web-account-host')).toBe('document');
    expect(screen.getByRole('heading', { name: '正在加载 Xpod' }).classList.contains('sr-only')).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('正在加载…');
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(page.querySelectorAll('[role="region"]')).toHaveLength(1);
  });

  test('uses the native Account window mode and restores the workspace on unmount', () => {
    const setWindowMode = vi.fn();
    vi.stubGlobal('xpodDesktop', { platform: 'darwin', setWindowMode });
    const { unmount } = render(<LoadingScreen />);

    const page = screen.getByTestId('web-account-page');
    const frame = screen.getByRole('region', { name: '正在加载 Xpod' });
    expect(screen.queryByTestId('auth-surface-page')).toBeNull();
    expect(frame.getAttribute('data-web-account-layout')).toBe('compact');
    expect(frame.getAttribute('data-web-account-host')).toBe('window');
    expect(setWindowMode).toHaveBeenCalledWith('account');
    expect(setWindowMode).not.toHaveBeenCalledWith('auth');
    expect(page.querySelector('input')).toBeNull();
    unmount();
    expect(setWindowMode).toHaveBeenLastCalledWith('workspace');
  });
});
