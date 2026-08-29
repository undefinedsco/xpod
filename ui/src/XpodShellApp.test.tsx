// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { XpodShellApp } from './XpodShellApp';

vi.mock('@undefineds.co/shared-ui', () => ({ Toaster: () => null }));
vi.mock('./auth/XpodAuthProvider', () => ({
  XpodAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./theme/XpodThemeRoot', () => ({
  XpodThemeRoot: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./xpod-shell-routes', () => ({
  xpodShellRoutes: [
    {
      path: 'ai-connections',
      element: <Link to="/status/overview">Open Status</Link>,
    },
    {
      path: 'status/overview',
      element: <main>Status overview</main>,
    },
  ],
}));

afterEach(() => {
  window.history.replaceState(null, '', '/');
  window.xpodDesktop = undefined;
});

describe('XpodShellApp callback hand-off', () => {
  test('uses workspace window mode for the product shell', () => {
    const setWindowMode = vi.fn();
    window.xpodDesktop = { setIdentity: vi.fn(), setWindowMode };
    render(<XpodShellApp initialPathname="/status/overview" />);
    expect(setWindowMode).toHaveBeenCalledWith('workspace');
  });

  test('uses the callback destination once and then leaves rail navigation to BrowserRouter', () => {
    window.history.replaceState(null, '', '/auth/callback');
    render(<XpodShellApp initialPathname="/ai-connections" />);

    expect(window.location.pathname).toBe('/ai-connections');
    fireEvent.click(screen.getByRole('link', { name: 'Open Status' }));

    expect(window.location.pathname).toBe('/status/overview');
    expect(screen.getByText('Status overview')).toBeTruthy();
  });
});
