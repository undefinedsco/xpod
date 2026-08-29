import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LoadingScreen } from './LoadingScreen';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LoadingScreen', () => {
  test('keeps initialization in the same compact card as sign-in', () => {
    vi.stubGlobal('xpodDesktop', undefined);
    render(<LoadingScreen />);

    const page = screen.getByTestId('auth-surface-page');
    const card = screen.getByRole('region', { name: '正在加载 Xpod' });
    expect(page.getAttribute('data-auth-surface-presentation')).toBe('compact');
    expect(card.classList.contains('w-[280px]')).toBe(true);
    expect(card.classList.contains('h-[400px]')).toBe(true);
    expect(card.querySelector('.border-b')).toBeNull();
    expect(screen.getByRole('heading', { name: '正在加载 Xpod' }).classList.contains('sr-only')).toBe(true);
    expect(screen.getByTestId('xpod-login-brand')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('正在加载…');
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByTestId('auth-surface-body').classList.contains('overflow-hidden')).toBe(true);
    expect(page.children).toHaveLength(1);
    expect(page.firstElementChild).toBe(card);
    expect(page.querySelectorAll('[role="region"]')).toHaveLength(1);
  });

  test('fills the desktop login window instead of drawing another card', () => {
    vi.stubGlobal('xpodDesktop', { platform: 'darwin' });
    render(<LoadingScreen />);

    const page = screen.getByTestId('auth-surface-page');
    const frame = screen.getByRole('region', { name: '正在加载 Xpod' });
    expect(page.getAttribute('data-auth-surface-host')).toBe('window');
    expect(frame.getAttribute('data-auth-surface-frame')).toBe('window');
    expect(frame.classList.contains('h-full')).toBe(true);
    expect(frame.classList.contains('w-full')).toBe(true);
    expect(frame.className).not.toContain('rounded-');
    expect(frame.className).not.toContain('shadow-');
    expect(frame.className).not.toContain('w-[280px]');
    expect(page.querySelector('input')).toBeNull();
  });
});
