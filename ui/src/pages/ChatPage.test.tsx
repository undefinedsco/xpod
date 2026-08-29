// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { XpodThemeProvider } from '../theme/XpodThemeProvider';
import { XPOD_THEME_STORAGE_KEY } from '../theme/xpod-theme-state';
import { ChatPage } from './ChatPage';

const useChatKitMock = vi.fn(() => ({ control: {} }));

vi.mock('@openai/chatkit-react', () => ({
  useChatKit: (options: unknown) => useChatKitMock(options),
  ChatKit: () => <div data-testid="chatkit" />,
}));

function anonymousAuthValue(): AuthContextType {
  const anonymous = { status: 'anonymous', mode: 'login' } as const;
  return {
    controls: {},
    isInitializing: false,
    initError: null,
    idpIndex: '/.account/',
    isLoggedIn: false,
    authenticating: false,
    hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    accountState: anonymous,
  };
}

function renderChatPage() {
  return render(
    <XpodThemeProvider>
      <AuthContext.Provider value={anonymousAuthValue()}>
        <ChatPage />
      </AuthContext.Provider>
    </XpodThemeProvider>,
  );
}

describe('ChatPage', () => {
  afterEach(() => {
    cleanup();
    useChatKitMock.mockClear();
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.colorScheme = '';
  });

  test('keeps account entry points inside the Xpod shell', () => {
    const rendered = renderChatPage();

    const hrefs = Array.from(rendered.container.querySelectorAll('a'))
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['/status/overview']));
    expect(hrefs.filter((href) => href === '/status/overview').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('link', { name: 'Login' }).getAttribute('href'))
      .toBe('/status/overview');
    expect(hrefs.some((href) => href?.startsWith('/.account'))).toBe(false);
  });

  test('passes the resolved global dark theme to ChatKit', () => {
    localStorage.setItem(XPOD_THEME_STORAGE_KEY, 'dark');

    renderChatPage();

    expect(useChatKitMock).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'dark' }),
    );
  });

  test('uses semantic theme tokens instead of hard-coded page colors', () => {
    const rendered = renderChatPage();

    expect(rendered.container.innerHTML).not.toMatch(
      /\b(?:bg|text|border|ring)-(?:gray|slate|zinc|white|blue|green)-/,
    );
  });
});
