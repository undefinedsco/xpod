import type { Frame, Page, Request } from '@playwright/test';
import type { AccountSetup } from '../integration/helpers/solidAccount';

export type BrowserSolidAccount = AccountSetup & {
  email: string;
  password: string;
};

export interface BrowserOidcTrace {
  authorizationRequestSeen: boolean;
  authCodeChallengeSeen: boolean;
  authCodeChallengeMethodS256: boolean;
  redirectCodeSeen: boolean;
  tokenAuthorizationCodeGrantSeen: boolean;
  tokenCodeVerifierSeen: boolean;
}

export interface CompleteOidcLoginOptions {
  baseUrl: string;
  startUrl?: string;
  timeoutMs?: number;
}

/**
 * Complete the browser's real Solid OIDC flow.
 *
 * The helper only observes navigation and requests. It deliberately does not
 * install a route, replace fetch, inject tokens, or persist a pre-authenticated
 * storage state. This keeps the acceptance path representative of a user login.
 */
export async function completeOidcLogin(
  page: Page,
  account: BrowserSolidAccount,
  options: CompleteOidcLoginOptions,
): Promise<BrowserOidcTrace> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const baseOrigin = new URL(options.baseUrl).origin;
  const trace: BrowserOidcTrace = {
    authorizationRequestSeen: false,
    authCodeChallengeSeen: false,
    authCodeChallengeMethodS256: false,
    redirectCodeSeen: false,
    tokenAuthorizationCodeGrantSeen: false,
    tokenCodeVerifierSeen: false,
  };

  const observeRequest = (request: Request) => {
    try {
      const url = new URL(request.url());
      const hasAuthorizationCodeParams = url.searchParams.get('response_type') === 'code'
        && url.searchParams.has('client_id')
        && url.searchParams.has('redirect_uri');
      if (hasAuthorizationCodeParams || url.pathname.endsWith('/authorize') || url.pathname.includes('/oidc/authorize')) {
        trace.authorizationRequestSeen = true;
      }
      if (url.searchParams.has('code_challenge')) {
        trace.authCodeChallengeSeen = true;
        trace.authCodeChallengeMethodS256 = url.searchParams.get('code_challenge_method') === 'S256';
      }
      if (url.pathname.endsWith('/token') || url.pathname.includes('/oidc/token')) {
        const params = new URLSearchParams(request.postData() ?? '');
        trace.tokenAuthorizationCodeGrantSeen = params.get('grant_type') === 'authorization_code';
        trace.tokenCodeVerifierSeen = params.has('code_verifier');
      }
    } catch {
      // Ignore requests which are not valid URLs for the trace.
    }
  };

  const observeNavigation = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    try {
      const url = new URL(frame.url());
      if (url.origin === baseOrigin && url.searchParams.has('code')) {
        trace.redirectCodeSeen = true;
      }
    } catch {
      // Ignore transient browser URLs.
    }
  };

  page.on('request', observeRequest);
  page.on('framenavigated', observeNavigation);
  try {
    if (options.startUrl) {
      await page.goto(options.startUrl, { waitUntil: 'domcontentloaded' });
    }

    const deadline = Date.now() + timeoutMs;
    let submittedPassword = false;
    let resumedFromAccountHome = false;

    while (Date.now() < deadline) {
      if (await isSettingsWorkspaceReady(page, baseOrigin)) {
        return trace;
      }

      const localSpace = page.getByRole('button', { name: '本机', exact: true }).first();
      if (await localSpace.isVisible({ timeout: 250 }).catch(() => false)) {
        await localSpace.click();
      }

      const emailInput = page.locator('input[type="email"], input[name="email"], input#email').first();
      const passwordInput = page.locator('input[type="password"], input[name="password"], input#password').first();
      const emailVisible = await emailInput.isVisible({ timeout: 250 }).catch(() => false);
      const passwordVisible = await passwordInput.isVisible({ timeout: 250 }).catch(() => false);
      if (emailVisible && passwordVisible && !submittedPassword) {
        await emailInput.fill(account.email);
        await passwordInput.fill(account.password);
        await passwordInput.press('Enter');
        submittedPassword = true;
        await page.waitForTimeout(350);
        continue;
      }

      const action = page.getByRole('button', {
        name: /authorize|allow|approve|consent|continue|submit|yes|log in|login|sign in|继续|允许|授权|同意|登录|进入/iu,
      }).first();
      if (await action.isVisible({ timeout: 250 }).catch(() => false)) {
        await action.click();
        await page.waitForTimeout(350);
        continue;
      }

      const submitInput = page.locator('input[type="submit"]').first();
      if (await submitInput.isVisible({ timeout: 250 }).catch(() => false)) {
        await submitInput.click();
        await page.waitForTimeout(350);
        continue;
      }

      if (submittedPassword && !resumedFromAccountHome && options.startUrl && isAccountHome(page.url(), baseOrigin)) {
        resumedFromAccountHome = true;
        await page.goto(options.startUrl, { waitUntil: 'domcontentloaded' });
        continue;
      }

      await page.waitForTimeout(350);
    }

    throw new Error(
      `Solid OIDC browser login did not finish before timeout; submittedPassword=${submittedPassword}; currentPath=${safePath(page.url())}`,
    );
  } finally {
    page.off('request', observeRequest);
    page.off('framenavigated', observeNavigation);
  }
}

function isAccountHome(rawUrl: string, baseOrigin: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === baseOrigin && url.pathname === '/.account/';
  } catch {
    return false;
  }
}

async function isSettingsWorkspaceReady(page: Page, baseOrigin: string): Promise<boolean> {
  try {
    const url = new URL(page.url());
    if (url.origin !== baseOrigin || !url.pathname.startsWith('/settings')) return false;
    return await page.locator('[data-testid="workspace-list-pane"], [data-workspace-layout="two-pane"]').first().isVisible({ timeout: 250 });
  } catch {
    return false;
  }
}

function safePath(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.pathname}${url.search ? '?…' : ''}`;
  } catch {
    return '<unknown>';
  }
}
