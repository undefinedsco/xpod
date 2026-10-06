import { errors, type Frame, type Locator, type Page, type Request, type Response } from '@playwright/test';
import type { AccountSetup } from '../integration/helpers/solidAccount';

export type BrowserSolidAccount = AccountSetup & {
  email: string;
  password: string;
};

export type BrowserSolidCredentials = Pick<BrowserSolidAccount, 'email' | 'password'>
  & Partial<Pick<BrowserSolidAccount, 'webId' | 'podUrl'>>;

const OIDC_PRIMARY_ACTION_NAME = /authorize|allow|approve|consent|continue|submit|yes|log in|login|sign in|继续|允许|授权|批准|同意|登录|进入/iu;
const OIDC_LOGIN_ACTION_NAME = /log in|login|sign in|登录|进入/iu;

/**
 * Disruptive controls the helper must never activate. The broad discovery
 * regex above intentionally matches label fragments, so logout
 * (`退出登录` → `登录`) and cancel-authorization (`取消授权` → `授权`) are
 * discovered as candidates and must be refused on the exact node that would be
 * clicked, atomically with the click, so a remount cannot swap it out.
 * Passed into `evaluate` because Node module scope is not serialized to the page.
 */
const OIDC_NEGATIVE_ACTION_SOURCE = '退出登录|退出|注销|登出|取消授权|取消|撤销|拒绝|切换账号|switch\\s*account|switch\\s*user|log\\s*out|sign\\s*out|logout|revoke|cancel|reject|deny|decline';

/** Resolve to `fallback` if `work` outlives `ms`, so no probe can outlive the
 * live test; the timer is always cleared. */
export async function boundedProbe<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The single activation path for every non-password OIDC control (button,
 * submit input or anchor). Refuses disruptive labels (logout / cancel / revoke /
 * switch-account) and password forms, then clicks the *same* node inside one
 * browser task: a later Locator click could resolve to a freshly mounted
 * password submit or a different control.
 */
export async function clickNonPasswordOidcAction(candidate: Locator, policy: { manualConsent?: boolean } = {}): Promise<boolean> {
  return candidate.evaluate((element, activation) => {
    const control = element as HTMLButtonElement | HTMLInputElement;
    // Read and refuse on the same DOM task that would activate the control.
    // Consent can mount between the caller's ready probe and this evaluation.
    if (activation.manualConsent && control.ownerDocument.querySelector('[data-pod-sign-in-state="consent"]')) return false;
    if (!control.isConnected || control.matches(':disabled') || control.getAttribute('aria-disabled') === 'true') return false;
    const name = [control.getAttribute('aria-label') ?? '', control.textContent ?? '', control.value ?? ''].join(' ');
    if (new RegExp(activation.negativeActionSource, 'iu').test(name)) return false;
    const form = control.form ?? control.closest('form');
    if (form?.querySelector('input[type="password"], input[name="password"], input#password')) return false;
    control.click();
    return true;
  }, { negativeActionSource: OIDC_NEGATIVE_ACTION_SOURCE, manualConsent: policy.manualConsent }, { timeout: 1_000 }).catch((error: unknown) => {
    // Navigation can remove a discovered control before evaluation. Use the
    // native cancellable deadline; a Promise.race could leave a late click.
    if (error instanceof errors.TimeoutError) return false;
    throw error;
  });
}

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
  /** Counts only actual password requests; bodies are never retained. */
  passwordRequestCount?: number;
  passwordSubmitCount?: number;
  secondPasswordFormSeen?: boolean;
  secondLoginActionSeen?: boolean;
  authorizationRedirectUris: string[];
  /** Observed authorization `scope` sets, normalized (deduped, sorted) per authorize
   * request; `'<none>'` when no scope was sent. Never inferred from requested input and
   * never retains state/PKCE/other authorization secrets. */
  authorizationScopeSets?: string[];
  /** Observed native Consent selection, never inferred from requested input. */
  storageBindingSelected?: { webId: string; podUrl: string };
  /** Explicit Consent remember-client scenario choice and the value the surface
   * actually retained before approval. Never inferred from requested input. */
  rememberClientRequested?: boolean;
  rememberClientObserved?: boolean;
  /** Actual Consent POSTs and the safe `remember` boolean they carried. */
  consentRequestCount?: number;
  consentRememberPosted?: boolean;
  /** The product auto-consents one exact binding and renders no chooser at all;
   * `true` only when the live Consent surface was observed with no WebID or
   * storage chooser and no WebID radio, never inferred from requested input. */
  consentSingleBindingOffered?: boolean;
}

interface ObservedAuthorization { redirectUri: string; state: string; s256: boolean }
interface CallbackLifecycle {
  completed: Array<{ id: string; record: string }>;
  consumed: string[];
  active?: string;
}

/** Correlate a new lifecycle marker with this call's actual PKCE request and
 * code/state callback. A pre-callback active hint is not a completed login. */
function correlateCallback(input: {
  origin: string; startedAt: number; baseline: string[]; authorizations: ObservedAuthorization[];
  callbacks: string[]; lifecycle: CallbackLifecycle;
}): string | undefined {
  const matches = new Set<string>();
  for (const callbackHref of input.callbacks) {
    const callback = new URL(callbackHref);
    const state = callback.searchParams.get('state');
    if (callback.origin !== input.origin || callback.pathname !== '/auth/callback' || callback.hash
      || callback.username || callback.password || !callback.searchParams.get('code') || !state
      || callback.searchParams.getAll('code').length !== 1 || callback.searchParams.getAll('state').length !== 1) continue;
    const authorized = input.authorizations.some(entry => {
      try {
        const redirect = new URL(entry.redirectUri);
        return entry.s256 && entry.state === state && redirect.origin === input.origin
          && redirect.pathname === callback.pathname && !redirect.hash && !redirect.username && !redirect.password
          && Array.from(redirect.searchParams).every(([key, value]) => callback.searchParams.get(key) === value);
      } catch { return false; }
    });
    if (!authorized) continue;
    for (const { id, record } of input.lifecycle.completed) {
      if (input.baseline.includes(id) || input.lifecycle.active === id || !input.lifecycle.consumed.includes(id)
        || callback.searchParams.has('transaction') && callback.searchParams.get('transaction') !== id) continue;
      try {
        const marker = JSON.parse(record) as { callback?: unknown; completedAt?: unknown; destination?: unknown };
        if (typeof marker.callback !== 'string' || typeof marker.destination !== 'string'
          || typeof marker.completedAt !== 'number' || !Number.isFinite(marker.completedAt)
          || marker.completedAt < input.startedAt || marker.completedAt > Date.now()) continue;
        const identity = new URL(marker.callback), destination = new URL(marker.destination);
        if (identity.origin === callback.origin && identity.pathname === callback.pathname
          && !identity.hash && !identity.username && !identity.password && identity.searchParams.size === 1
          && identity.searchParams.get('state') === state && destination.origin === input.origin
          && !destination.username && !destination.password) matches.add(id);
      } catch { /* A malformed or unrelated marker is never completion evidence. */ }
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

async function readCallbackLifecycle(page: Page): Promise<CallbackLifecycle> {
  return page.evaluate(() => {
    const completedPrefix = 'xpod.auth.callback.completed.v1.';
    const consumedPrefix = 'xpod.auth.transaction.v1.consumed.';
    const keys = Object.keys(window.sessionStorage);
    return {
      completed: keys.filter(key => key.startsWith(completedPrefix)).map(key => ({
        id: key.slice(completedPrefix.length), record: window.sessionStorage.getItem(key) ?? '',
      })),
      consumed: keys.filter(key => key.startsWith(consumedPrefix)).map(key => key.slice(consumedPrefix.length)),
      active: window.sessionStorage.getItem('xpod.auth.transaction.v1.active') ?? undefined,
    };
  }).catch(() => ({ completed: [], consumed: [] }));
}

export function chooseConsentBinding(options: Array<{ value: string; disabled: boolean }>, currentValue: string,
  account: Pick<BrowserSolidCredentials, 'webId' | 'podUrl'>): string | undefined {
  const selectable = options.filter(option => option.value && !option.disabled);
  const webId = account.webId ? new URL(account.webId).href : undefined;
  const podUrl = account.podUrl?.replace(/\/$/u, '');
  const matches = (value: string): boolean => {
    const separator = value.indexOf('|');
    return separator >= 0 && (!webId || value.slice(0, separator) === webId)
      && (!podUrl || value.slice(separator + 1).replace(/\/$/u, '') === podUrl);
  };
  if (webId || podUrl) return selectable.find(option => option.value === currentValue && matches(option.value))?.value
    ?? selectable.find(option => matches(option.value))?.value;
  return selectable.find(option => option.value === currentValue)?.value
    ?? (selectable.length === 1 ? selectable[0].value : undefined);
}

/** What the rendered Consent surface actually offered, read from the live DOM. */
export interface ConsentSurfaceState {
  surfaceVisible: boolean;
  webIdChooserVisible: boolean;
  storageChooserVisible: boolean;
  webIdRadioCount: number;
}

/** The shared Consent view auto-consents exactly one binding and renders no
 * chooser in that case (`single = webIds.length === 1`), so the absence of
 * every chooser on a visible surface is the product's own single-binding ABI.
 * Any chooser at all means the scenario must make an explicit choice. */
export function consentOffersSingleBinding(state: ConsentSurfaceState): boolean {
  return state.surfaceVisible && !state.webIdChooserVisible && !state.storageChooserVisible
    && state.webIdRadioCount === 0;
}

/** The live runtime binding the browser actually established for this login. */
export interface BrowserRuntimeBinding {
  status?: string;
  webId?: string;
  podUrl?: string;
}

/** Callback/PKCE evidence plus an exact binding proof that never invents a
 * choice: either the observed explicit selection, or the product's
 * single-binding auto-consent corroborated by the authenticated runtime
 * binding. A surface that offered any chooser can never take the second path,
 * and a mismatched selection never falls through to it. */
export function consentBindingProven(trace: BrowserOidcTrace, binding: { webId: string; storageUrl: string },
  runtime: BrowserRuntimeBinding | undefined): boolean {
  const callbackProven = trace.authorizationRequestSeen && trace.authCodeChallengeMethodS256
    && trace.tokenAuthorizationCodeGrantSeen && trace.tokenCodeVerifierSeen
    && trace.callbackHasCode && trace.callbackHasState;
  if (!callbackProven) return false;
  if (trace.storageBindingSelected) {
    return trace.storageBindingSelected.webId === binding.webId
      && trace.storageBindingSelected.podUrl === binding.storageUrl;
  }
  return trace.consentSingleBindingOffered === true && runtime?.status === 'authenticated'
    && runtime.webId === binding.webId && runtime.podUrl === binding.storageUrl;
}

export interface CompleteOidcLoginOptions {
  baseUrl: string;
  startUrl?: string;
  timeoutMs?: number;
  /** Resolve only when the scenario's protected route is actually ready. */
  ready?: (page: Page) => boolean | Promise<boolean>;
  /** Require callback code/state evidence before accepting route readiness. */
  requireCallbackEvidence?: boolean;
  /** Explicit UI choice; undefined preserves the form default for this scenario. */
  rememberAccount?: boolean;
  /** Explicit Consent remember-client choice, independent of account remembering.
   * undefined preserves the surface default; true or false must be offered, set
   * and retained before approval or the scenario fails. */
  rememberClient?: boolean;
  /** Let the scenario inspect and approve Consent instead of the generic action driver. */
  manualConsent?: boolean;
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
  // Interleaved tab scenarios must activate the tab being operated, just as
  // a user does; background renderer throttling can otherwise stall scrolling.
  await page.bringToFront();
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
    authorizationScopeSets: [],
  };
  const browserErrors: string[] = [];
  const networkDiagnostics: string[] = [];
  const startedAt = Date.now();
  const initialCallbackIds = (await readCallbackLifecycle(page)).completed.map(entry => entry.id);
  const observedAuthorizations: ObservedAuthorization[] = [];
  const observedCallbacks = new Set<string>();
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
      if (hasAuthorizationCodeParams) {
        const scopes = [...new Set(url.searchParams.getAll('scope')
          .flatMap(value => value.split(' ')).filter(Boolean))].sort();
        trace.authorizationScopeSets!.push(scopes.length > 0 ? scopes.join(' ') : '<none>');
      }
      if (hasAuthorizationCodeParams && redirectUri && url.searchParams.get('state')) {
        observedAuthorizations.push({ redirectUri, state: url.searchParams.get('state')!,
          s256: Boolean(url.searchParams.get('code_challenge')) && url.searchParams.get('code_challenge_method') === 'S256'
            && url.searchParams.getAll('state').length === 1 && url.searchParams.getAll('redirect_uri').length === 1 });
      }
      if (request.method() === 'POST' && /^\/\.account\/(?:interaction\/[^/]+\/)?login\/password\/?$/u.test(url.pathname)) {
        trace.passwordRequestCount = (trace.passwordRequestCount ?? 0) + 1;
      }
      if (request.method() === 'POST' && /^\/\.account\/(?:interaction\/[^/]+\/)?oidc\/consent\/?$/u.test(url.pathname)) {
        trace.consentRequestCount = (trace.consentRequestCount ?? 0) + 1;
        try {
          const body = JSON.parse(request.postData() ?? '') as { remember?: unknown };
          if (typeof body.remember === 'boolean') trace.consentRememberPosted = body.remember;
        } catch { /* A non-JSON consent body carries no remember evidence. */ }
      }
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
    if (url.searchParams.get('code') && url.searchParams.get('state')) observedCallbacks.add(url.href);
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
      await page.goto(options.startUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 30_000) });
    }

    const deadline = Date.now() + timeoutMs;
    let submittedPassword = false;
    let productWebIdEntryClicked = false;
    let localSpaceClickedAt = 0;
    let passwordFormLeftAfterSubmit = false;
    let consentRememberApplied = false;
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
      const matchedCallback = options.requireCallbackEvidence && trace.callbackPathSeen ? correlateCallback({
        origin: baseOrigin, startedAt, baseline: initialCallbackIds, authorizations: observedAuthorizations,
        callbacks: [...observedCallbacks], lifecycle: await readCallbackLifecycle(page),
      }) : undefined;
      if (matchedCallback) trace.callbackTransaction = matchedCallback;
      const callbackReady = !options.requireCallbackEvidence
        || (trace.callbackPathSeen
          && trace.callbackHasCode
          && trace.callbackHasState
          && matchedCallback !== undefined);
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
      if (submittedPassword && (!emailVisible || !passwordVisible)) passwordFormLeftAfterSubmit = true;
      if (submittedPassword && passwordFormLeftAfterSubmit && emailVisible && passwordVisible) trace.secondPasswordFormSeen = true;
      if (emailVisible && passwordVisible && !submittedPassword) {
        await emailInput.fill(account.email, { timeout: 2_000 });
        await passwordInput.fill(account.password, { timeout: 2_000 });
        if (options.rememberAccount !== undefined) {
          const remember = page.getByRole('checkbox', { name: /^(?:记住账号|Remember account)$/iu });
          await remember.setChecked(options.rememberAccount, { timeout: 2_000 });
          if (await remember.isChecked() !== options.rememberAccount) throw new Error('Account remember choice did not match the scenario');
        }
        await passwordInput.press('Enter', { timeout: 2_000 });
        submittedPassword = true;
        trace.passwordSubmitted = true;
        trace.passwordSubmitCount = (trace.passwordSubmitCount ?? 0) + 1;
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

      // An explicit remember-client scenario must set and retain the real
      // Consent choice before approving; a missing or ignored choice fails the
      // scenario instead of silently defaulting to "do not remember".
      const consentSurface = page.locator('[data-pod-sign-in-state="consent"]');
      // Record the rendered Consent shape before driving it: exactly one live
      // binding is auto-consented and offers no chooser, so a caller proving
      // that exact binding needs this observed fact rather than a selection
      // that the product never asked for.
      if (!trace.consentSingleBindingOffered
        && await consentSurface.isVisible({ timeout: 100 }).catch(() => false)) {
        trace.consentSingleBindingOffered = consentOffersSingleBinding({
          surfaceVisible: true,
          webIdChooserVisible: await page.locator('#oidc-consent-webid').isVisible({ timeout: 100 }).catch(() => false),
          storageChooserVisible: await page.locator('#oidc-consent-storage').isVisible({ timeout: 100 }).catch(() => false),
          webIdRadioCount: await page.locator('input[type="radio"][name="webId"]').count(),
        });
      }
      if (options.rememberClient !== undefined && !consentRememberApplied
        && await consentSurface.isVisible({ timeout: 100 }).catch(() => false)) {
        const rememberClientChoice = page.getByRole('checkbox', { name: /^(?:以后不再询问|Do not ask again)$/u });
        if (!await rememberClientChoice.isVisible({ timeout: 250 }).catch(() => false)) {
          // The choice is folded into the collapsed request-details disclosure.
          const details = page.locator('summary', { hasText: /请求详情|Request details/u }).first();
          if (await details.isVisible({ timeout: 250 }).catch(() => false)) {
            await details.click({ timeout: 2_000, noWaitAfter: true }).catch(() => undefined);
          }
        }
        if (!await rememberClientChoice.isVisible({ timeout: 1_000 }).catch(() => false)) {
          throw new Error(`Consent did not offer the requested remember-client choice (requested=${options.rememberClient})`);
        }
        if (!await rememberClientChoice.isEnabled({ timeout: 250 }).catch(() => false)) {
          throw new Error('Consent remember-client choice is disabled and cannot be set before approval');
        }
        await rememberClientChoice.setChecked(options.rememberClient, { timeout: 2_000 });
        const observedRemember = await rememberClientChoice.isChecked();
        if (observedRemember !== options.rememberClient) {
          throw new Error('Consent did not retain the requested remember-client choice');
        }
        trace.rememberClientRequested = options.rememberClient;
        trace.rememberClientObserved = observedRemember;
        consentRememberApplied = true;
        await page.waitForTimeout(150);
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
        const selectedValue = chooseConsentBinding(availableOptions, currentOptionValue, account);
        const requestedOption = selectableOptions.find(option => option.value === selectedValue);
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
        const observedValue = await consentWebIdSelect.inputValue();
        if (observedValue !== requestedOption.value) throw new Error('Consent did not retain the selected storage binding');
        const separator = observedValue.indexOf('|');
        trace.storageBindingSelected = { webId: observedValue.slice(0, separator), podUrl: observedValue.slice(separator + 1) };
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
          trace.secondLoginActionSeen = true;
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
        // The requested intermediate surface can finish rendering while the
        // helper inspects its controls. Do not click past a newly ready
        // consent page that the caller needs to interact with itself.
        if (!options.requireCallbackEvidence && await options.ready?.(page)) return trace;
        if (!await clickNonPasswordOidcAction(candidate, options)) continue;
        recordDiagnostic(`automation-activated button ${safePath(page.url())}`);
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
        // Same-node checked activation for anchors too: refusal and click are
        // evaluated on the exact node that is activated.
        if (!await clickNonPasswordOidcAction(candidate, options)) continue;
        recordDiagnostic(`automation-activated link ${safePath(page.url())}`);
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
        if (await clickNonPasswordOidcAction(submitInput, options)) {
          recordDiagnostic(`automation-activated submit-input ${safePath(page.url())}`);
          await page.waitForTimeout(350);
          continue;
        }
      }

      await page.waitForTimeout(350);
    }

    // On the timeout path, compare Chromium's pending asset with an independent
    // HTTP client before fixture teardown removes the evidence. A pending asset
    // is a fact to compare, not proof of the cause of the timeout.
    try {
      const asset = new URL('/app/assets/main.js', options.baseUrl);
      const response = await fetch(asset, { signal: AbortSignal.timeout(3_000), cache: 'no-store' });
      const bytes = (await response.arrayBuffer()).byteLength;
      recordDiagnostic(`independent-asset-probe status=${response.status} bytes=${bytes}`);
    } catch (error) {
      recordDiagnostic(`independent-asset-probe failed=${error instanceof Error ? error.name : 'unknown'}`);
    }
    const visibleText = await page.locator('body').innerText({ timeout: 1_000 })
      .then((value) => value.replace(/\s+/gu, ' ').trim().slice(0, 240))
      .catch(() => '<unavailable>');
    // Read-only context for the timeout error: document identity plus the
    // resource paths the page actually attempted (paths only, no queries). On
    // its own it neither proves that the document committed nor that any
    // particular request stalled.
    type CallbackDebug = {
      params: string[]; storageKeys: string[]; completion: string[];
      readyState: string; visibility: string; resources: string[];
    };
    const callbackDebugFallback: CallbackDebug = {
      params: [], storageKeys: [], completion: [],
      readyState: '<unavailable>', visibility: '<unavailable>', resources: [],
    };
    const callbackDebug = await boundedProbe(page.evaluate((): CallbackDebug => {
      const resources = performance.getEntriesByType('resource').map((entry) => {
        const timing = entry as PerformanceResourceTiming & { responseStatus?: number };
        let target = timing.name;
        try {
          const url = new URL(timing.name);
          target = url.origin === window.location.origin ? url.pathname : url.origin;
        } catch {
          target = '<invalid>';
        }
        return `${timing.initiatorType}:${target}:${Math.round(timing.duration)}ms:${timing.transferSize ?? 0}B:${timing.responseStatus ?? '?'}`;
      });
      return {
        params: [...new URL(window.location.href).searchParams.keys()],
        storageKeys: Object.keys(window.sessionStorage).filter((key) => key.startsWith('xpod.auth.')),
        completion: Object.keys(window.sessionStorage)
          .filter((key) => key.startsWith('xpod.auth.callback.completed.'))
          .map((key) => window.sessionStorage.getItem(key) ?? ''),
        readyState: document.readyState,
        visibility: document.visibilityState,
        resources,
      };
    }).catch(() => callbackDebugFallback), 2_000, callbackDebugFallback);
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
      })}; params=${callbackDebug.params.join(',')}; storageKeys=${callbackDebug.storageKeys.join(',')}; completion=${callbackDebug.completion.join(',')}; readyState=${callbackDebug.readyState}; visibility=${callbackDebug.visibility}; resources=${callbackDebug.resources.map(entry => entry.replace(/\/\.account\/interaction\/[^/:]+/gu, '/.account')).slice(-24).join(' || ')}; browserErrors=${browserErrors.join(' | ')}; network=${networkDiagnostics.join(' || ')}; visibleText=${visibleText}`,
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

/** Normalize only assertions/diagnostics; real requests retain their interaction scope. */
export function normalizeAccountPath(pathname: string): string {
  return pathname.replace(/^\/\.account\/interaction\/[^/]+(?=\/)/u, '/.account');
}

function safePath(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${normalizeAccountPath(url.pathname)}${url.search ? '?…' : ''}`;
  } catch {
    return '<unknown>';
  }
}

function isDiagnosticPath(pathname: string): boolean {
  pathname = normalizeAccountPath(pathname);
  return pathname === '/.account/'
    || pathname.startsWith('/.account/oidc/')
    || pathname.includes('/account/bindings')
    || pathname === '/auth/callback'
    || pathname.endsWith('/authorize')
    || pathname.endsWith('/token');
}

function safeNetworkPath(url: URL): string {
  const keys = [...url.searchParams.keys()].sort();
  const normalized = normalizeAccountPath(url.pathname);
  const scope = normalized === url.pathname ? '' : '[interaction]';
  return `${normalized}${scope}${keys.length > 0 ? `?keys=${keys.join(',')}` : ''}`;
}

async function readActiveCallbackTransaction(page: Page): Promise<string | undefined> {
  return await page.evaluate(() => window.sessionStorage.getItem('xpod.auth.transaction.v1.active') ?? undefined)
    .catch(() => undefined);
}
