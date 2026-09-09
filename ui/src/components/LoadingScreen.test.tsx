import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LoadingScreen } from './LoadingScreen';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LoadingScreen', () => {
  test('keeps Web initialization inside the same bounded document panel as sign-in', () => {
    vi.stubGlobal('xpodDesktop', undefined);
    render(<LoadingScreen />);

    const page = screen.getByTestId('web-account-page');
    const frame = screen.getByRole('region', { name: '正在加载 Xpod' });
    expect(screen.queryByTestId('auth-surface-page')).toBeNull();
    expect(screen.getByTestId('web-account-introduction')).toBeTruthy();
    expect(frame.className).toContain('max-w-md');
    expect(screen.getByRole('heading', { name: '正在加载 Xpod' }).classList.contains('sr-only')).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('正在加载…');
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(page.querySelectorAll('[role="region"]')).toHaveLength(1);
  });

  test('does not switch Account loading into a WebID window when a desktop bridge exists', () => {
    vi.stubGlobal('xpodDesktop', { platform: 'darwin' });
    render(<LoadingScreen />);

    const page = screen.getByTestId('web-account-page');
    const frame = screen.getByRole('region', { name: '正在加载 Xpod' });
    expect(screen.queryByTestId('auth-surface-page')).toBeNull();
    expect(frame.className).toContain('max-w-md');
    expect(page.querySelector('input')).toBeNull();
  });
});
