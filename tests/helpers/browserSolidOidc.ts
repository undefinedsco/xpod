import type { Frame, Page, Request, Response } from '@playwright/test';
import type { AccountSetup } from '../integration/helpers/solidAccount';

export type BrowserSolidAccount = AccountSetup & {
  email: string;
  password: string;
};

export type BrowserSolidCredentials = Pick<BrowserSolidAccount, 'email' | 'password'>
  & Partial<Pick<BrowserSolidAccount, 'webId' | 'podUrl'>>;

const OIDC_PRIMARY_ACTION_NAME = /authorize|allow|approve|consent|continue|submit|yes|log in|login|sign in|继续|允许|授权|批准|同意|登录|进入/iu;
const OIDC_LOGIN_ACTION_NAME = /log in|login|sign in|登录|进入/iu;

export interface BrowserOidcTrace {
  authorizationRequestSeen: boolean;
  authCodeChallengeSeen: boolean;
  authCodeChallengeMethodS256: boolean;
  redirectCodeSeen: boolean;
  tokenAuthorizationCodeGrantSeen: boolean;
  tokenCodeVerifierSeen: boolean;
  callbackPathSeen: boolean;
  callbackHasCode: boolean;
  callbackHasState: boolean;
  callbackTransaction?: string;
  callbackReturnTo?: string;
  passwordSubmitted: boolean;
  authorizationRedirectUris: string[];
}

export interface CompleteOidcLoginOptions {
  baseUrl: string;
  startUrl?: string;
  timeoutMs?: number;
  /** Resolve only when the scenario's protected route is actually ready. */
  ready?: (page: Page) => boolean | Promise<boolean>;
  /** Require callback code/state evidence before accepting route readiness. */
  requireCallbackEvidence?: boolean;
  /** Resolve an intentional callback failure without waiting for protected-route readiness. */
  failure?: (page: Page) => boolean | Promise<boolean>;
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
  account: BrowserSolidCredentials,
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
    callbackPathSeen: false,
    callbackHasCode: false,
    callbackHasState: false,
    passwordSubmitted: false,
    authorizationRedirectUris: [],
  };
  const browserErrors: string[] = [];
  const networkDiagnostics: string[] = [];
  const startedAt = Date.now();
  const recordDiagnostic = (entry: string) => {
    if (networkDiagnostics.length < 80) networkDiagnostics.push(`${Date.now() - startedAt}ms ${entry}`);
  };
  const observeConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === 'error') browserErrors.push(message.text().slice(0, 240));
  };
  const observePageError = (error: Error) => browserErrors.push(error.message.slice(0, 240));

  const observeRequest = (request: Request) => {
    try {
      const url = new URL(request.url());
      observeCallbackUrl(url);
      const hasAuthorizationCodeParams = url.searchParams.get('response_type') === 'code'
        && url.searchParams.has('client_id')
        && url.searchParams.has('redirect_uri');
      const redirectUri = url.searchParams.get('redirect_uri');
      if (redirectUri) trace.authorizationRedirectUris.push(redirectUri);
      if (url.pathname.startsWith('/api/ai/gateway/')) {
        const headers = request.headers();
        const authorizationScheme = headers.authorization?.split(/\s+/u, 1)[0] ?? '<none>';
        recordDiagnostic(
          `request ${request.method()} ${safeNetworkPath(url)} auth=${authorizationScheme} dpop=${headers.dpop ? 'present' : 'absent'}`,
        );
      }
      if (isDiagnosticPath(url.pathname) || url.pathname.startsWith('/app/')) {
        recordDiagnostic(`request ${request.method()} ${safeNetworkPath(url)}`);
      }
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

  const observeResponse = (response: Response) => {
    try {
      const url = new URL(response.url());
      observeCallbackUrl(url);
      if (response.status() >= 400) {
        recordDiagnostic(`response ${response.status()} ${response.request().method()} ${safeNetworkPath(url)}`);
        void response.text().then((body) => {
          const safeBody = body
            .replace(/Bearer\s+[^\s"']+/giu, 'Bearer <redacted>')
            .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '<redacted-jwt>')
            .replace(/sk-[A-Za-z0-9._-]+/gu, 'sk-<redacted>')
            .replace(/\s+/gu, ' ')
            .trim()
            .slice(0, 500);
          if (safeBody) {
            recordDiagnostic(`response-body ${response.status()} ${safeNetworkPath(url)} ${safeBody}`);
          }
        }).catch(() => undefined);
      }
      if (isDiagnosticPath(url.pathname) || url.pathname.startsWith('/app/')) {
        recordDiagnostic(`response ${response.status()} ${response.request().method()} ${safeNetworkPath(url)}`);
        if (url.pathname === '/.account/' && response.ok()) {
          void response.json().then((payload: unknown) => {
            const controls = payload && typeof payload === 'object' && !Array.isArray(payload)
              ? (payload as { controls?: unknown }).controls
              : undefined;
            const account = controls && typeof controls === 'object' && !Array.isArray(controls)
              ? (controls as { account?: unknown }).account
              : undefined;
            const keys = account && typeof account === 'object' && !Array.isArray(account)
              ? Object.keys(account).sort().join(',')
              : '<none>';
            recordDiagnostic(`account-controls account-keys=${keys}`);
          }).catch(() => undefined);
        }
      }
    } catch {
      // Ignore responses which are not valid URLs for diagnostics.
    }
  };

  const observeNavigation = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    try {
      const url = new URL(frame.url());
      observeCallbackUrl(url);
    } catch {
      // Ignore transient browser URLs.
    }
  };

  const observeRequestFailed = (request: Request) => {
    try {
      const url = new URL(request.url());
      if (isDiagnosticPath(url.pathname) || url.pathname.startsWith('/app/')) {
        recordDiagnostic(`failed ${request.method()} ${safeNetworkPath(url)} ${request.failure()?.errorText ?? '<unknown>'}`);
      }
    } catch {
      // Ignore requests which are not valid URLs for diagnostics.
    }
  };

  const observeCallbackUrl = (url: URL) => {
    if (url.origin !== baseOrigin || url.pathname !== '/auth/callback') return;
    if (url.searchParams.has('code')) trace.redirectCodeSeen = true;
    trace.callbackPathSeen = true;
    trace.callbackHasCode ||= url.searchParams.has('code');
    trace.callbackHasState ||= url.searchParams.has('state');
    trace.callbackTransaction ??= url.searchParams.get('transaction') ?? undefined;
    trace.callbackReturnTo ??= url.searchParams.get('returnTo') ?? undefined;
  };

  page.on('request', observeRequest);
  page.on('response', observeResponse);
  page.on('requestfailed', observeRequestFailed);
  page.on('framenavigated', observeNavigation);
  page.on('console', observeConsole);
  page.on('pageerror', observePageError);
  try {
    if (options.startUrl) {
      await page.goto(options.startUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    }

    const deadline = Date.now() + timeoutMs;
    let submittedPassword = false;
    let productWebIdEntryClicked = false;
    let localSpaceClickedAt = 0;
    let lastPhase = '';

    while (Date.now() < deadline) {
      if (!trace.callbackTransaction) {
        trace.callbackTransaction = await readActiveCallbackTransaction(page);
      }
      const phase = safePath(page.url());
      if (phase !== lastPhase) {
        lastPhase = phase;
        recordDiagnostic(`phase ${phase}`);
      }
      if (await options.failure?.(page)) return trace;
      const routeReady = await (options.ready?.(page) ?? isSettingsWorkspaceReady(page, baseOrigin));
      if (trace.callbackPathSeen && !trace.callbackTransaction) {
        trace.callbackTransaction = await findConsumedCallbackTransaction(page);
      }
      const callbackReady = !options.requireCallbackEvidence
        || (trace.callbackPathSeen
          && trace.callbackHasCode
          && trace.callbackHasState
          && await hasConsumedCallback(page, trace.callbackTransaction));
      if (routeReady && callbackReady) {
        return trace;
      }
      if (trace.callbackPathSeen
        && await page.getByText('Could not connect to Xpod', { exact: true }).isVisible({ timeout: 100 }).catch(() => false)) {
        throw new Error(
          `Solid OIDC browser login reached the Xpod recovery boundary; `
          + `currentPath=${safePath(page.url())}; network=${networkDiagnostics.join(' || ')}; `
          + `visibleText=${await page.locator('body').innerText({ timeout: 1_000 })
            .then((value) => value.replace(/\s+/gu, ' ').trim().slice(0, 240))
            .catch(() => '<unavailable>')}`,
        );
      }

      // In the narrow stack layout the Provider list is the initial pane and
      // the main pane (including either login or authenticated detail) is not
      // exposed until an item is opened. Open one item so the same readiness
      // and login checks used on desktop can run without viewport heuristics.
      const stackProvider = page.locator('[data-workspace-mode="stack"] [role="option"]').first();
      if (await stackProvider.isVisible({ timeout: 250 }).catch(() => false)) {
        await stackProvider.click({ timeout: 2_000, noWaitAfter: true });
        await page.waitForTimeout(100);
        continue;
      }

      const localSpace = page.getByRole('button', { name: /^(?:本机|Local)$/iu }).first();
      if (await localSpace.isVisible({ timeout: 250 }).catch(() => false)) {
        await localSpace.click({ timeout: 2_000, noWaitAfter: true });
        continue;
      }

      const localCardLabel = page.getByText(/^(?:本机|Local)$/iu).last();
      if (await localCardLabel.isVisible({ timeout: 250 }).catch(() => false)) {
        const localCardAction = localCardLabel
          .locator('..')
          .locator('..')
          .getByRole('button', { name: /continue|继续/iu })
          .first();
        if (await localCardAction.isVisible({ timeout: 250 }).catch(() => false)) {
          if (Date.now() - localSpaceClickedAt > 3_000) {
            localSpaceClickedAt = Date.now();
            await localCardAction.click({ force: true, noWaitAfter: true, timeout: 2_000 }).catch(() => undefined);
          }
          await page.waitForTimeout(350);
          continue;
        }
      }

      const emailInput = page.locator('input[type="email"], input[name="email"], input#email').first();
      const passwordInput = page.locator('input[type="password"], input[name="password"], input#password').first();
      const emailVisible = await emailInput.isVisible({ timeout: 250 }).catch(() => false);
      const passwordVisible = await passwordInput.isVisible({ timeout: 250 }).catch(() => false);
      if (emailVisible && passwordVisible && !submittedPassword) {
        await emailInput.fill(account.email, { timeout: 2_000 });
        await passwordInput.fill(account.password, { timeout: 2_000 });
        await passwordInput.press('Enter', { timeout: 2_000 });
        submittedPassword = true;
        trace.passwordSubmitted = true;
        await page.waitForTimeout(350);
        continue;
      }

      const productWebIdEntry = page.getByRole('button', { name: /使用 WebID 登录|Sign in with WebID/iu }).first();
      if (!productWebIdEntryClicked
        && await productWebIdEntry.isVisible({ timeout: 250 }).catch(() => false)
        && await productWebIdEntry.isEnabled({ timeout: 250 }).catch(() => false)) {
        productWebIdEntryClicked = true;
        await productWebIdEntry.click({ timeout: 2_000, noWaitAfter: true });
        await page.waitForTimeout(350);
        continue;
      }

      const consentWebIdSelect = page.locator('#oidc-consent-webid');
      if (await consentWebIdSelect.isVisible({ timeout: 100 }).catch(() => false)) {
        // A single exact WebID/Pod binding is auto-approved by the Account
        // surface. During that transition the native select remains visible
        // but is disabled. Do not let Playwright's selectOption wait until the
        // scenario timeout while the page is already navigating away.
        if (!await consentWebIdSelect.isEnabled({ timeout: 100 }).catch(() => false)) {
          await page.waitForTimeout(100);
          continue;
        }
        const currentOptionValue = await consentWebIdSelect.inputValue();
        const availableOptions = await consentWebIdSelect.locator('option').evaluateAll((options) => options.map((option) => ({
          label: option.textContent?.trim() ?? '',
          value: (option as HTMLOptionElement).value,
          disabled: (option as HTMLOptionElement).disabled,
        })));
        const selectableOptions = availableOptions.filter((option) => option.value && !option.disabled);
        const normalizedWebId = account.webId ? new URL(account.webId).href : undefined;
        const normalizedPodUrl = account.podUrl?.replace(/\/$/u, '');
        const requestedOption = (currentOptionValue
          ? selectableOptions.find((option) => option.value === currentOptionValue)
          : undefined) ?? (account.webId
          ? selectableOptions.find((option) => {
            const separator = option.value.indexOf('|');
            if (separator < 0) return false;
            const optionWebId = option.value.slice(0, separator);
            const optionPodUrl = option.value.slice(separator + 1).replace(/\/$/u, '');
            return optionWebId === normalizedWebId
              && (!normalizedPodUrl || optionPodUrl === normalizedPodUrl);
          })
            ?? selectableOptions.find((option) => option.value.startsWith(`${normalizedWebId}|`))
          : selectableOptions.length === 1 ? selectableOptions[0] : undefined);
        if (!requestedOption) {
          throw new Error(account.webId
            ? `The requested WebID and Pod are not available for this account: ${account.webId}; available=${selectableOptions.map((option) => option.label).join(',')}`
            : 'Multiple WebID and Pod bindings are available, but the login scenario did not provide the expected binding.');
        }
        // React renders the first native option even while its controlled
        // value is still empty. Always select the resolved option so the
        // change event commits the exact binding into the consent state.
        await consentWebIdSelect.selectOption(requestedOption.value, { timeout: 2_000 });
        const consentStorageSelect = page.locator('#oidc-consent-storage');
        if (await consentStorageSelect.isVisible({ timeout: 100 }).catch(() => false)
          && await consentStorageSelect.isEnabled({ timeout: 100 }).catch(() => false)) {
          await consentStorageSelect.selectOption(requestedOption.value, { timeout: 2_000 });
        }
      }

      const webIdRadios = page.locator('input[type="radio"][name="webId"]');
      const webIdRadioCount = await webIdRadios.count();
      if (webIdRadioCount > 0) {
        let matchingRadio = account.webId ? undefined : webIdRadios.first();
        if (account.webId) {
          for (let index = 0; index < webIdRadioCount; index += 1) {
            const candidate = webIdRadios.nth(index);
            if (await candidate.getAttribute('value') === account.webId) {
              matchingRadio = candidate;
              break;
            }
          }
          if (!matchingRadio) {
            const availableWebIds = await webIdRadios.evaluateAll((inputs) => inputs
              .map((input) => (input as HTMLInputElement).value));
            throw new Error(`The requested WebID is not available for this account: ${account.webId}; available=${availableWebIds.join(',')}`);
          }
        } else if (webIdRadioCount > 1) {
          throw new Error('Multiple WebIDs are available, but the login scenario did not provide the expected WebID.');
        }

        if (!await matchingRadio!.isChecked()) {
          await matchingRadio!.check({ timeout: 2_000 });
        }
      }

      // One exact binding is auto-consented. Multiple eligible bindings are
      // intentionally different: CSS must present one explicit Pod chooser
      // and consent action inside the same OIDC transaction.
      const currentPath = safePath(page.url());
      const storageChooserVisible = await page.locator('#oidc-consent-storage').isVisible({ timeout: 100 }).catch(() => false);
      if (submittedPassword
        && webIdRadioCount === 0
        && !storageChooserVisible
        && baseOrigin === new URL(page.url()).origin
        && (currentPath === '/.account/oidc/consent/' || currentPath === '/.account/login/')) {
        const secondLoginAction = page.getByRole('button', {
          name: OIDC_LOGIN_ACTION_NAME,
        }).first();
        if (await secondLoginAction.isVisible({ timeout: 100 }).catch(() => false)) {
          throw new Error(`Xpod exposed a second visible login action after password submission: ${await secondLoginAction.innerText()}`);
        }
      }

      const action = page.getByRole('button', {
        name: OIDC_PRIMARY_ACTION_NAME,
      });
      const actionCount = await action.count();
      let clickedAction = false;
      for (let index = 0; index < actionCount; index += 1) {
        const candidate = action.nth(index);
        if (!await candidate.isVisible({ timeout: 250 }).catch(() => false)) continue;
        if (!await candidate.isEnabled({ timeout: 250 }).catch(() => false)) continue;
        await candidate.click({ timeout: 2_000, noWaitAfter: true });
        clickedAction = true;
        break;
      }
      if (clickedAction) {
        await page.waitForTimeout(350);
        continue;
      }

      const actionLink = page.getByRole('link', {
        name: OIDC_PRIMARY_ACTION_NAME,
      });
      const actionLinkCount = await actionLink.count();
      let clickedActionLink = false;
      for (let index = 0; index < actionLinkCount; index += 1) {
        const candidate = actionLink.nth(index);
        if (!await candidate.isVisible({ timeout: 250 }).catch(() => false)) continue;
        await candidate.click({ timeout: 2_000, noWaitAfter: true });
        clickedActionLink = true;
        break;
      }
      if (clickedActionLink) {
        await page.waitForTimeout(350);
        continue;
      }

      const submitInput = page.locator('input[type="submit"]').first();
      if (await submitInput.isVisible({ timeout: 250 }).catch(() => false)
        && await submitInput.isEnabled({ timeout: 250 }).catch(() => false)) {
        await submitInput.click({ timeout: 2_000, noWaitAfter: true });
        await page.waitForTimeout(350);
        continue;
      }

      await page.waitForTimeout(350);
    }

    const visibleText = await page.locator('body').innerText({ timeout: 1_000 })
      .then((value) => value.replace(/\s+/gu, ' ').trim().slice(0, 240))
      .catch(() => '<unavailable>');
    const callbackDebug = await page.evaluate(() => ({
      params: [...new URL(window.location.href).searchParams.keys()],
      storageKeys: Object.keys(window.sessionStorage).filter((key) => key.startsWith('xpod.auth.')),
      completion: Object.keys(window.sessionStorage)
        .filter((key) => key.startsWith('xpod.auth.callback.completed.'))
        .map((key) => window.sessionStorage.getItem(key)),
    })).catch(() => ({ params: [], storageKeys: [], completion: [] }));
    throw new Error(
      `Solid OIDC browser login did not finish before timeout; submittedPassword=${submittedPassword}; currentPath=${safePath(page.url())}; trace=${JSON.stringify({
        authorizationRequestSeen: trace.authorizationRequestSeen,
        authCodeChallengeSeen: trace.authCodeChallengeSeen,
        redirectCodeSeen: trace.redirectCodeSeen,
        tokenAuthorizationCodeGrantSeen: trace.tokenAuthorizationCodeGrantSeen,
        tokenCodeVerifierSeen: trace.tokenCodeVerifierSeen,
        callbackPathSeen: trace.callbackPathSeen,
        callbackHasCode: trace.callbackHasCode,
        callbackHasState: trace.callbackHasState,
        callbackTransaction: trace.callbackTransaction,
        authorizationRedirectUris: trace.authorizationRedirectUris.map((value) => {
          try { return safeNetworkPath(new URL(value)); } catch { return '<invalid>'; }
        }),
      })}; params=${callbackDebug.params.join(',')}; storageKeys=${callbackDebug.storageKeys.join(',')}; completion=${callbackDebug.completion.join(',')}; browserErrors=${browserErrors.join(' | ')}; network=${networkDiagnostics.join(' || ')}; visibleText=${visibleText}`,
    );
  } finally {
    page.off('request', observeRequest);
    page.off('response', observeResponse);
    page.off('requestfailed', observeRequestFailed);
    page.off('framenavigated', observeNavigation);
    page.off('console', observeConsole);
    page.off('pageerror', observePageError);
  }
}

async function isSettingsWorkspaceReady(page: Page, baseOrigin: string): Promise<boolean> {
  try {
    const url = new URL(page.url());
    if (url.origin !== baseOrigin || !url.pathname.startsWith('/settings')) return false;
    const workspaceVisible = await page
      .locator('[data-workspace-layout]')
      .first()
      .isVisible({ timeout: 250 });
    if (!workspaceVisible) return false;
    // The shared login view intentionally renders inside the same workspace
    // shell and the Provider navigation stays visible beside it. Only the
    // authenticated detail region proves that OIDC returned a usable session.
    // In stack/mobile mode that region is mounted in the hidden main pane until
    // a Provider is selected, so attachment—not visibility—is the contract.
    return await page.locator('[data-testid="workspace-main-pane"] section[role="region"]').first()
      .count() > 0;
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

function isDiagnosticPath(pathname: string): boolean {
  return pathname === '/.account/'
    || pathname.startsWith('/.account/oidc/')
    || pathname.includes('/account/bindings')
    || pathname === '/auth/callback'
    || pathname.endsWith('/authorize')
    || pathname.endsWith('/token');
}

function safeNetworkPath(url: URL): string {
  const keys = [...url.searchParams.keys()].sort();
  return `${url.pathname}${keys.length > 0 ? `?keys=${keys.join(',')}` : ''}`;
}

async function hasConsumedCallback(page: Page, transactionId?: string): Promise<boolean> {
  if (!transactionId) return false;
  return await page.evaluate((id) => {
    const completed = window.sessionStorage.getItem(`xpod.auth.callback.completed.v1.${id}`);
    const active = window.sessionStorage.getItem('xpod.auth.transaction.v1.active');
    return completed !== null && active !== id;
  }, transactionId).catch(() => false);
}

async function readActiveCallbackTransaction(page: Page): Promise<string | undefined> {
  return await page.evaluate(() => window.sessionStorage.getItem('xpod.auth.transaction.v1.active') ?? undefined)
    .catch(() => undefined);
}

async function findConsumedCallbackTransaction(page: Page): Promise<string | undefined> {
  return await page.evaluate(() => {
    const completedPrefix = 'xpod.auth.callback.completed.v1.';
    const consumedPrefix = 'xpod.auth.transaction.v1.consumed.';
    const completed = Object.keys(window.sessionStorage)
      .filter((key) => key.startsWith(completedPrefix))
      .map((key) => key.slice(completedPrefix.length));
    const consumed = new Set(Object.keys(window.sessionStorage)
      .filter((key) => key.startsWith(consumedPrefix))
      .map((key) => key.slice(consumedPrefix.length)));
    const candidates = completed.filter((id) => consumed.has(id));
    return candidates.length === 1 ? candidates[0] : undefined;
  }).catch(() => undefined);
}
