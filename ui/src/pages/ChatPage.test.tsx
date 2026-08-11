// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { ChatPage } from './ChatPage';

vi.mock('@openai/chatkit-react', () => ({
  useChatKit: () => ({ control: {} }),
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
    accountAuthState: anonymous,
    authState: anonymous,
    state: anonymous,
  };
}

describe('ChatPage', () => {
  afterEach(cleanup);

  test('keeps account entry points inside the Xpod shell', () => {
    const rendered = render(
      <AuthContext.Provider value={anonymousAuthValue()}>
        <ChatPage />
      </AuthContext.Provider>,
    );

    const hrefs = Array.from(rendered.container.querySelectorAll('a'))
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([
      '/status/overview',
      '/status/overview?account=open',
    ]);
    expect(screen.getByRole('link', { name: 'Login' }).getAttribute('href'))
      .toBe('/status/overview?account=open');
    expect(hrefs.some((href) => href?.startsWith('/.account'))).toBe(false);
  });
});
