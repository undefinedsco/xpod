import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { startBrowserExternalRp } from './browserExternalRp';
import { boundedProbe, completeOidcLogin, normalizeAccountPath, type BrowserSolidCredentials } from './browserSolidOidc';
import { fetchProfileStorageUrls } from '../../ui/src/utils/provision-scope';
import { resolveAuthoritativeAccountId } from '../../ui/src/utils/safe-continuation';

export type RcIdentity = { accountId: string; webId: string; storageUrl: string };
export type RcAccountBindings = { accountId: string; bindings: Array<{ webId: string; storageUrl: string }> };
export type RcRp = Awaited<ReturnType<typeof startBrowserExternalRp>>;
export type RcSession = { identity: RcIdentity; authenticatedFetch: typeof fetch };

class RcEvidenceError extends Error {}

function requireEvidence(value: unknown, message: string): asserts value {
  if (!value) throw new RcEvidenceError(message);
}

function canonicalHttpsUrl(value: string, storage = false): string {
  const url = new URL(value);
  requireEvidence(url.protocol === 'https:' && !url.username && !url.password && !url.search
    && !/^(?:localhost|.*\.localhost|127\..*|0\.0\.0\.0|\[::1\])$/iu.test(url.hostname)
    && (!storage || (!url.hash && url.pathname.endsWith('/'))), 'RC identity requires a canonical HTTPS URL outside loopback');
  requireEvidence(url.href === value, 'RC identity URL is not canonical');
  return url.href;
}

/** Cookie-authenticated Account controls, never remembered UI hints or fabricated URL pairs. */
export async function readRcAccountBindings(page: Page, baseUrl: string): Promise<RcAccountBindings> {
  try { return await readCookieAccountBindings(page, baseUrl); }
  catch (error) {
    if (error instanceof RcEvidenceError) throw error;
    throw new Error('RC Account binding transport failed');
  }
}

async function readCookieAccountBindings(page: Page, baseUrl: string): Promise<RcAccountBindings> {
  const origin = new URL(baseUrl).origin;
  const response = await page.context().request.get(new URL('/.account/', baseUrl).href, {
    headers: { Accept: 'application/json' }, timeout: 20_000,
  });
  requireEvidence(response.status() === 200, `RC Account controls HTTP ${response.status()}`);
  const { controls } = await response.json() as { controls?: {
    account?: { id?: string; logout?: string; bindings?: string; clientCredentials?: string; pod?: string };
  } };
  const accountId = resolveAuthoritativeAccountId(controls);
  requireEvidence(accountId && controls?.account?.logout && controls.account.bindings, 'RC Account Cookie did not restore an owned Account');
  const target = new URL(controls.account.bindings, origin);
  requireEvidence(target.origin === origin && target.pathname.startsWith('/.account/') && !target.search
    && !target.hash && !target.username && !target.password, 'RC Account binding control crossed its authority');
  const bindingsResponse = await page.context().request.get(target.href, { headers: { Accept: 'application/json' }, timeout: 20_000 });
  requireEvidence(bindingsResponse.status() === 200, `RC Account bindings HTTP ${bindingsResponse.status()}`);
  const payload = await bindingsResponse.json() as { bindings?: RcAccountBindings['bindings'] };
  requireEvidence(Array.isArray(payload.bindings) && payload.bindings.length > 0, 'RC Account has no owned storage binding');
  requireEvidence(payload.bindings.every(row => row && typeof row.webId === 'string' && typeof row.storageUrl === 'string'),
    'RC Account returned malformed storage bindings');
  return { accountId, bindings: payload.bindings };
}

/** The deployed lightweight Account document, independent of the desktop scoped alias. */
export const RC_ACCOUNT_DOCUMENT_PATH = '/.account/account/';

/**
 * Closed vocabulary for what the deployed Account document actually painted. Only
 * these fixed tokens may reach a failure message or a public acceptance artifact;
 * the observation carries no page text, URL query or credential material.
 */
export type RcAccountSurfaceKind =
  | 'account-dashboard'
  | 'bootstrap-loading'
  | 'bootstrap-error'
  | 'login'
  | 'oidc-consent'
  | 'unrecognized';

export interface RcAccountSurfaceReading { kind: RcAccountSurfaceKind; pathname: string }

export interface RcAccountSurfaceObservation extends RcAccountSurfaceReading {
  /** Total time from the start of the settle to this returned observation. Timing only. */
  elapsedMs: number;
}

/**
 * Shape read out of the live document. Classification needs the painted heading text, so this
 * internal shape does carry page copy; it never carries credential material and it is never
 * returned, published or logged — only the closed kind/pathname observation leaves the helper.
 */
export interface PaintedRcAccountSurface {
  pathname: string;
  headingText: string;
  hasPasswordInput: boolean;
  hasBootstrapStatus: boolean;
  hasAlert: boolean;
}

/** The Account dashboard heading the lightweight Web surface must render. */
export const RC_ACCOUNT_DASHBOARD_HEADING = /账号总览|Account (?:overview|dashboard)/iu;

/** A bounce to the login route is not the Account dashboard, whatever painted there. */
export function classifyRcAccountSurface(painted: PaintedRcAccountSurface,
  expectedPathname: string = RC_ACCOUNT_DOCUMENT_PATH): RcAccountSurfaceKind {
  if (painted.pathname !== expectedPathname) {
    if (/^\/\.account\/login\//u.test(painted.pathname)) return 'login';
    if (/^\/\.account\/oidc\/consent\//u.test(painted.pathname)) return 'oidc-consent';
    return 'unrecognized';
  }
  if (RC_ACCOUNT_DASHBOARD_HEADING.test(painted.headingText)) return 'account-dashboard';
  if (painted.hasAlert) return 'bootstrap-error';
  if (painted.hasBootstrapStatus) return 'bootstrap-loading';
  return 'unrecognized';
}

/** Read only the painted landmarks; never account copy, bindings or credential values. */
export async function observeRcAccountSurface(page: Page,
  expectedPathname: string = RC_ACCOUNT_DOCUMENT_PATH): Promise<RcAccountSurfaceReading | undefined> {
  const painted = await page.evaluate(() => {
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden'
        && style.display !== 'none' && style.opacity !== '0';
    };
    const paintedText = (selector: string): string => Array.from(document.querySelectorAll(selector))
      .filter(visible).map(element => (element.textContent ?? '').trim()).join(' ').slice(0, 512);
    return {
      pathname: window.location.pathname,
      headingText: paintedText('h1, h2, h3, [role="heading"]'),
      hasPasswordInput: Array.from(document.querySelectorAll('input[type="password"]')).some(visible),
      hasBootstrapStatus: Array.from(document.querySelectorAll('[role="status"][aria-live="polite"]')).some(visible),
      hasAlert: Array.from(document.querySelectorAll('[role="alert"]')).some(visible),
    };
  }).catch(() => undefined);
  if (!painted) return undefined;
  return { kind: classifyRcAccountSurface(painted, expectedPathname), pathname: painted.pathname };
}

/**
 * Budget for the client-rendered Account dashboard to paint on a cold RC pod. The document
 * returns 200 immediately, but the dashboard only exists after the SPA resolves its Account
 * index and fetches the Cookie-authenticated controls, so a single frame after
 * `domcontentloaded` races that boot. Only the dashboard settles early; every other surface
 * keeps being observed until this budget expires and is then reported as-is. The budget also
 * bounds each document read, so a renderer that never answers is reported as-is instead of
 * hanging past the budget or passing.
 */
export const RC_ACCOUNT_SURFACE_SETTLE_MS = 20_000;

export async function settleRcAccountSurface(page: Page, expectedPathname: string = RC_ACCOUNT_DOCUMENT_PATH,
  timeoutMs = RC_ACCOUNT_SURFACE_SETTLE_MS): Promise<RcAccountSurfaceObservation> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let last: RcAccountSurfaceReading = { kind: 'unrecognized', pathname: expectedPathname };
  for (;;) {
    // A renderer blocked inside the read must not outlive the budget, so each read is raced against
    // the remaining budget. A bounded-out read keeps the previous surface and is never a dashboard.
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      const observed = await boundedProbe(observeRcAccountSurface(page, expectedPathname), remaining, undefined);
      if (observed) last = observed;
    }
    const elapsedMs = Date.now() - startedAt;
    if (last.kind === 'account-dashboard' || elapsedMs >= timeoutMs) return { ...last, elapsedMs };
    await page.waitForTimeout(Math.max(1, Math.min(250, deadline - Date.now())));
  }
}

/**
 * Fixed-token description of a failed surface observation. The observed kind is already
 * closed vocabulary, so nothing the page painted can reach the message or a published
 * artifact through it. An expired budget keeps whatever painted last, never a pass.
 */
export function describeRcAccountSurface(observation: RcAccountSurfaceObservation): string {
  return `RC Account surface did not reach the dashboard (observed=${observation.kind})`;
}

export async function verifyRcIdentity(baseUrl: string, account: RcAccountBindings,
  session: { webId: string; issuer: string }, publicFetch: typeof fetch = fetch): Promise<RcIdentity> {
  requireEvidence(new URL(session.issuer).href === new URL(baseUrl).href, 'RC token came from a different issuer');
  const webId = canonicalHttpsUrl(session.webId);
  const bindings = account.bindings.filter(binding => binding.webId === webId);
  requireEvidence(bindings.length === 1, 'RC token WebID does not identify exactly one Account storage binding');
  const storageUrl = canonicalHttpsUrl(bindings[0].storageUrl, true);
  const advertised = await fetchProfileStorageUrls((input, init) => publicFetch(input, {
    ...init, signal: AbortSignal.timeout(20_000),
  }), webId);
  requireEvidence(advertised.includes(storageUrl), 'RC public Profile does not advertise the exact Account storage binding');
  return { accountId: account.accountId, webId, storageUrl };
}

/** Real RC IdP + PKCE/DPoP token exchange through a test RP. No renderer bridge or injected token. */
export async function authorizeRcSession(page: Page, rp: RcRp, baseUrl: string,
  credentials?: BrowserSolidCredentials): Promise<RcSession> {
  const authorization = rp.authorization();
  let passwordPosts = 0;
  let stage: 'authorization' | 'password-count' | 'token' | 'account-binding' | 'profile' = 'authorization';
  const observe = (request: import('playwright').Request) => {
    if (request.method() === 'POST' && normalizeAccountPath(new URL(request.url()).pathname) === '/.account/login/password/') passwordPosts++;
  };
  page.on('request', observe);
  try {
    const trace = await completeOidcLogin(page, credentials ?? { email: '', password: '' }, {
      baseUrl: new URL(rp.callbackUrl).origin, startUrl: authorization.url,
      ready: current => current.url().startsWith(`${rp.callbackUrl}?`),
      requireCallbackEvidence: false, rememberAccount: true, timeoutMs: 90_000,
      failure: async current => {
        if (!credentials && await current.locator('input[type="password"]').isVisible().catch(() => false)) {
          throw new Error('RC Account Cookie reuse requested another password');
        }
        return false;
      },
    });
    requireEvidence(trace.authorizationRequestSeen && trace.authCodeChallengeMethodS256
      && trace.callbackHasCode && trace.callbackHasState, 'RC browser did not complete the real PKCE authorization redirect');
    stage = 'password-count';
    requireEvidence(credentials ? passwordPosts === 1 : passwordPosts === 0, 'RC browser password submission count was unexpected');
    stage = 'token';
    const token = await authorization.exchange(new URL(page.url()));
    requireEvidence(authorization.tokenRequests === 1 && token.tokenStatus === 200, 'RC authorization code was not exchanged exactly once');
    stage = 'account-binding';
    const account = await readRcAccountBindings(page, baseUrl);
    stage = 'profile';
    const identity = await verifyRcIdentity(baseUrl, account, token);
    return { identity, authenticatedFetch: token.authenticatedFetch };
  } catch {
    // Shared browser diagnostics may contain upstream bodies. Never publish them from this release gate.
    throw new Error(`RC ${credentials ? 'seeded' : 'reused'} OIDC failed at ${stage}`);
  } finally {
    page.off('request', observe);
  }
}

/** Exact private data proof for each owner; neither different URLs nor public Profile reads suffice. */
export async function verifyRcPrivateIsolation(sessions: RcSession[], anonymousFetch: typeof fetch = fetch): Promise<void> {
  requireEvidence(sessions.length === 2 && sessions[0].identity.accountId !== sessions[1].identity.accountId
    && sessions[0].identity.webId !== sessions[1].identity.webId
    && sessions[0].identity.storageUrl !== sessions[1].identity.storageUrl, 'RC isolation requires two distinct authoritative owners');
  const created: Array<{ url: string; fetch: typeof fetch }> = [];
  try {
    for (const [index, owner] of sessions.entries()) {
      const url = new URL(`rc-private-${randomUUID()}.txt`, owner.identity.storageUrl).href;
      const body = `private-rc-${randomUUID()}`;
      // An interrupted PUT may have committed; retain its unique target for cleanup.
      created.push({ url, fetch: owner.authenticatedFetch });
      const write = await owner.authenticatedFetch(url, { method: 'PUT', signal: AbortSignal.timeout(20_000), headers: {
        'Content-Type': 'text/plain', 'If-None-Match': '*',
      }, body });
      if (write.status === 412) created.pop(); // Never delete an unexpected pre-existing resource.
      requireEvidence(write.status === 201, `RC owner private PUT HTTP ${write.status}`);
      const read = await owner.authenticatedFetch(url, { signal: AbortSignal.timeout(20_000) });
      requireEvidence(read.status === 200 && await read.text() === body, 'RC owner private GET did not return the exact content');
      for (const otherFetch of [sessions[1 - index].authenticatedFetch, anonymousFetch]) {
        for (const method of ['GET', 'PUT']) {
          const response = await otherFetch(url, { method, signal: AbortSignal.timeout(20_000), ...(method === 'PUT' ? {
            headers: { 'Content-Type': 'text/plain' }, body: 'unauthorized-overwrite',
          } : {}) });
          requireEvidence([401, 403].includes(response.status), `RC non-owner private ${method} was not denied`);
        }
      }
      const unchanged = await owner.authenticatedFetch(url, { signal: AbortSignal.timeout(20_000) });
      requireEvidence(unchanged.status === 200 && await unchanged.text() === body, 'RC private content changed after denied writes');
    }
  } catch (error) {
    if (error instanceof RcEvidenceError) throw error;
    throw new Error('RC private isolation transport failed');
  } finally {
    let cleanupFailed = false;
    for (const resource of created) {
      try {
        const response = await resource.fetch(resource.url, { method: 'DELETE', signal: AbortSignal.timeout(20_000) });
        if (![200, 204, 205, 404].includes(response.status)) cleanupFailed = true;
        const absent = await resource.fetch(resource.url, { signal: AbortSignal.timeout(20_000) });
        if (![404, 410].includes(absent.status)) cleanupFailed = true;
      } catch { cleanupFailed = true; }
    }
    requireEvidence(!cleanupFailed, 'RC private isolation cleanup failed');
  }
}
