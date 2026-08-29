// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { XpodThemeProvider } from './XpodThemeProvider';
import { useXpodTheme } from './xpod-theme-context';
import { XPOD_THEME_STORAGE_KEY, initializeXpodTheme } from './xpod-theme-state';

type ThemeListener = (event: MediaQueryListEvent) => void;

function installColorScheme(dark: boolean) {
  let matches = dark;
  const listeners = new Set<ThemeListener>();
  const media = {
    media: '(prefers-color-scheme: dark)',
    get matches() { return matches; },
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: ThemeListener) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: ThemeListener) => listeners.delete(listener)),
    addListener: vi.fn((listener: ThemeListener) => listeners.add(listener)),
    removeListener: vi.fn((listener: ThemeListener) => listeners.delete(listener)),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
  window.matchMedia = vi.fn(() => media);
  return {
    set(next: boolean) {
      matches = next;
      const event = { matches: next, media: media.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

function ThemeProbe() {
  const theme = useXpodTheme();
  return <span data-testid="theme">{theme.preference}:{theme.resolvedTheme}</span>;
}

describe('Xpod global theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.colorScheme = '';
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test('initializes every document from the current system color scheme', () => {
    installColorScheme(true);

    expect(initializeXpodTheme()).toEqual({ preference: 'system', resolvedTheme: 'dark' });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  test('reacts to live system theme changes from one provider', async () => {
    const scheme = installColorScheme(false);
    render(<XpodThemeProvider><ThemeProbe /></XpodThemeProvider>);

    expect(screen.getByTestId('theme').textContent).toBe('system:light');
    await act(async () => scheme.set(true));
    expect(screen.getByTestId('theme').textContent).toBe('system:dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test('honours a persisted explicit preference over the system', () => {
    installColorScheme(true);
    localStorage.setItem(XPOD_THEME_STORAGE_KEY, 'light');

    render(<XpodThemeProvider><ThemeProbe /></XpodThemeProvider>);

    expect(screen.getByTestId('theme').textContent).toBe('light:light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
