import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { Simulate } from 'react-dom/test-utils';
import { ThemeToggle } from '../../ui/admin/src/components/ThemeToggle';
import { render, flushPromises } from './testUtils';

describe('ThemeToggle', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.dataset.mode = 'light';
    window.localStorage.clear();
  });

  it('切换模式时更新 html dataset 与 localStorage', async () => {
    const { container, unmount } = render(<ThemeToggle />);

    try {
      const button = container.querySelector('button');
      expect(button).toBeTruthy();

      act(() => {
        Simulate.click(button!);
      });
      await flushPromises();

      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.dataset.mode).toBe('dark');
      expect(window.localStorage.getItem('xpod-theme')).toBe('dark');

      act(() => {
        Simulate.click(button!);
      });
      await flushPromises();

      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(document.documentElement.dataset.mode).toBe('light');
      expect(window.localStorage.getItem('xpod-theme')).toBe('light');
    } finally {
      unmount();
    }
  });

  it('初始根据存储值为 dark', () => {
    window.localStorage.setItem('xpod-theme', 'dark');
    const { unmount } = render(<ThemeToggle />);

    try {
      expect(document.documentElement.dataset.mode).toBe('dark');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    } finally {
      unmount();
    }
  });

  it('无存储时尊重系统偏好暗色', () => {
    window.localStorage.clear();
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn().mockReturnValue({
        matches: true,
        media: '(prefers-color-scheme: dark)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
      configurable: true,
    });

    const { unmount } = render(<ThemeToggle />);

    try {
      expect(document.documentElement.dataset.mode).toBe('dark');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    } finally {
      unmount();
      Object.defineProperty(window, 'matchMedia', {
        value: originalMatchMedia,
        configurable: true,
      });
    }
  });
});
