import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { startBrowserExternalRp } from './browserExternalRp';
import { completeOidcLogin, normalizeAccountPath, type BrowserSolidCredentials } from './browserSolidOidc';
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
