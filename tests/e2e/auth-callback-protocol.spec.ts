import { expect, test } from '@playwright/test';
import { setupAccount, type AccountSetup } from '../integration/helpers/solidAccount';
import { completeOidcLogin } from '../helpers/browserSolidOidc';
import { XpodTestStack } from '../helpers/XpodTestStack';

// This protocol probe needs a real CSS OIDC stack and Chromium. Keep it opt-in
// alongside the other environment-backed acceptance tests.
test.describe('Xpod same-origin callback protocol', () => {
  let stack: XpodTestStack | undefined;
  let account: AccountSetup | null = null;

  test.beforeAll(async () => {
    test.skip(!process.env.XPOD_AUTH_CALLBACK_PROTOCOL_E2E, 'Set XPOD_AUTH_CALLBACK_PROTOCOL_E2E=true to run the real protocol probe');
    stack = new XpodTestStack();
    await stack.start('local', { transport: 'port' });
    account = await setupAccount(stack.baseUrl, 'callback');
    if (!account?.email || !account.password) {
      throw new Error('Callback protocol probe requires a browser-capable test account');
    }
  });

  test.afterAll(async () => {
    await stack?.stop();
  });

  test('preserves the transaction query alongside Inrupt code and state', async ({ page }) => {
    test.skip(!account, 'Test account setup did not run');
    test.setTimeout(120_000);
    const registeredRedirectUris: string[] = [];
    let callbackUrl: URL | undefined;

    page.on('request', (request) => {
      try {
        const url = new URL(request.url());
        if (url.pathname.endsWith('/authorize') || url.pathname.includes('/oidc/authorize')) {
          const redirectUri = url.searchParams.get('redirect_uri');
          if (redirectUri) registeredRedirectUris.push(redirectUri);
        }
      } catch {
        // Ignore non-URL requests.
      }
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      try {
        const url = new URL(frame.url());
        if (url.pathname === '/auth/callback') callbackUrl = url;
      } catch {
        // Ignore transient browser URLs.
      }
    });

    try {
      await completeOidcLogin(page, {
        ...account!,
        email: account!.email!,
        password: account!.password!,
      }, {
        baseUrl: stack!.baseUrl,
        startUrl: new URL('/settings/models', stack!.baseUrl).href,
        timeoutMs: 75_000,
      });
    } catch {
      // Task 5 intentionally permits the callback to stop at the deterministic
      // missing-selected-storage action before consent selection is implemented.
    }

    await expect.poll(() => registeredRedirectUris.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect.poll(() => callbackUrl?.searchParams.has('transaction') ?? false, { timeout: 10_000 }).toBe(true);
    const callback = callbackUrl!;
    const transaction = callback.searchParams.get('transaction');
    expect(transaction).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(callback.searchParams.get('code')).toBeTruthy();
    expect(callback.searchParams.get('state')).toBeTruthy();
    expect(registeredRedirectUris.some((redirectUri) => {
      const registered = new URL(redirectUri);
      return registered.pathname === '/auth/callback' && registered.searchParams.get('transaction') === transaction;
    })).toBe(true);
  });
});
