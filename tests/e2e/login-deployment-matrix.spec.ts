import { armDelayedProviders, cleanupDelayedProviders, delayedProvidersState, releaseDelayedProviders } from '../helpers/browserDelayedProviders';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Frame, type Page, type Request, type TestInfo } from '@playwright/test';
import { boundedProbe, completeOidcLogin, normalizeAccountPath } from '../helpers/browserSolidOidc';
import { completeOfflineProductLogout, verifyOfflinePodRecovery } from '../helpers/browserLoginNetwork';
import { fetchBrowserXpodPod, readBrowserXpodAccount, readBrowserXpodRuntime } from '../helpers/browserXpodRuntime';

type Deployment = {
  mode: 'cloud' | 'managed-local' | 'standalone';
  runnerBunVersion?: string;
  baseUrl: string;
  issuer: string;
  account: { email: string; password: string; username: string };
};
const manifestPath = process.env.XPOD_E2E_LOGIN_MATRIX_MANIFEST;
const deployments = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) as Deployment[] : [];

// A whole-test timeout that fires during a navigation aborts the test before a
// post-timeout attachment can be written. Each navigation window therefore arms
// one bounded observation timer that takes a snapshot while the test is still
// live. Budgets stay below the 240 s test timeout so the snapshot can land once
// the earlier phases have completed normally. They only record facts; they do
// not change waitUntil, guards or any timeout.
const INITIAL_NAVIGATION_OBSERVATION_MS = 180_000;
const REFRESH_STALL_OBSERVATION_MS = 30_000;
const STATUS_NAVIGATION_OBSERVATION_MS = 120_000;

// Browser product evidence, not a claim of three-mode Electron lifecycle
// coverage. The runner owns the disposable deployments and their accounts.
if (!manifestPath) test('deployment matrix requires its isolated runner', () => {
  test.skip(true, 'Run bun --no-env-file tests/helpers/runLoginDeploymentMatrix.ts');
});

for (const deployment of deployments) {
  test.describe(`${deployment.mode} real product login`, () => {
    test.describe.configure({ mode: 'serial', timeout: 240_000 });
    let accountControl: string | undefined;
    for (const [index, route] of ['/ai-connections', '/ai-config/model-assignments'].entries()) {
      test(`${route}: identity, private Pod, refresh, network recovery, Status Account and offline logout`, async ({ page, context }, testInfo) => {
        const origin = new URL(deployment.baseUrl).origin;
        const original = `${origin}${route}?login-matrix=${deployment.mode}`;
        const expectedPod = `${origin}/${deployment.account.username}/`;
        const expectedWebId = `${expectedPod}profile/card#me`;
        const tokenStatuses: number[] = [];
        const issuerOrigins = new Set<string>();
        let provisionScopeSeen = false;
        let callbackHasCode = false;
        let callbackHasState = false;
        page.on('framenavigated', frame => {
          if (frame !== page.mainFrame()) return;
          const url = new URL(frame.url());
          if (url.origin === origin && url.pathname === '/auth/callback') {
            callbackHasCode ||= url.searchParams.has('code');
            callbackHasState ||= url.searchParams.has('state');
          }
        });
        page.on('request', request => {
          const url = new URL(request.url());
          if (url.searchParams.get('response_type') === 'code') {
            issuerOrigins.add(url.origin);
            provisionScopeSeen ||= url.searchParams.has('provisionCode');
          }
        });
        page.on('response', response => {
          if (response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/token')) tokenStatuses.push(response.status());
        });
        // Sanitized, bounded observation for the whole test. It is armed before
        // the first product navigation so the initial register/login window (runs
        // l and a) is covered too. Snapshots are pure events (exact Request
        // identity + observed main-frame navigations), so capturing them never
        // depends on a responsive renderer. `page.once('close')` plus the
        // `finally` below both detach, so neither a thrown assertion nor a
        // test timeout can leave listeners attached to the page.
        const diagnostics = createOriginNavigationCollector(page, origin);
        diagnostics.attach();
        page.once('close', () => diagnostics.detach());
        try {
          const diagnosticContext = (mark: number, startedAt: number, name: string): DiagnosticContext =>
            ({ page, testInfo, collector: diagnostics, mark, startedAt, mode: deployment.mode, route, name });
          const discovery = await page.request.get(new URL('/.well-known/openid-configuration', deployment.issuer).href);
          expect(discovery.ok()).toBe(true);
          expect(new URL((await discovery.json()).issuer).origin).toBe(new URL(deployment.issuer).origin);
          if (deployment.mode === 'managed-local') {
            expect(origin).not.toBe(new URL(deployment.issuer).origin);
            const provision = await page.request.get(`${origin}/provision/status`);
            expect(await provision.json()).toMatchObject({ managed: true, registered: true, oidcIssuer: deployment.issuer });
          }

          const initialStartedAt = Date.now();
          const initialMark = diagnostics.mark();
          const trace = await withNavigationObservation(
            diagnosticContext(initialMark, initialStartedAt, 'initial-navigation'),
            INITIAL_NAVIGATION_OBSERVATION_MS,
            async () => {
              if (index === 0) await registerFromProduct(page, deployment, original);
              return completeOidcLogin(page, { ...deployment.account, podUrl: expectedPod, webId: expectedWebId }, {
                baseUrl: origin,
                ...(index === 0 ? {} : { startUrl: original }),
                ready: productReady,
                requireCallbackEvidence: true,
                timeoutMs: 120_000,
              });
            },
          );
          expect(callbackHasCode && callbackHasState).toBe(true);
          expect(trace.callbackHasCode && trace.callbackHasState).toBe(true);
          expect(tokenStatuses).toContain(200);
          expect([...issuerOrigins]).toEqual([new URL(deployment.issuer).origin]);
          if (deployment.mode === 'managed-local') expect(provisionScopeSeen).toBe(true);
          await expect(page).toHaveURL(original);
          const binding = await runtimeProbe(page, { operation: 'identity' });
          expect(binding).toMatchObject({ webId: expectedWebId, podUrl: expectedPod, issuer: deployment.issuer });
          await assertProtectedAiConfigContent(page, route);

          const resource = new URL(`matrix-private-${randomUUID()}.txt`, expectedPod).href;
          const body = `private-matrix-${randomUUID()}`;
          const write = await runtimeProbe(page, { operation: 'write-read', url: resource, body });
          expect(write).toMatchObject({ writeStatus: 201, readStatus: 200, matches: true, anonymousDenied: true });
          await verifyOfflinePodRecovery(page, context, resource.slice(expectedPod.length), body);
          // Refresh window. The real reload guard below stays in force and
          // unchanged; the observation timer only records facts while it runs.
          const reloadStartedAt = Date.now();
          const reloadMark = diagnostics.mark();
          const refreshContext = diagnosticContext(reloadMark, reloadStartedAt, 'refresh');
          await withNavigationObservation(refreshContext, REFRESH_STALL_OBSERVATION_MS, () => page.reload());
          try {
            await expect.poll(() => productReady(page), { timeout: 60_000 }).toBe(true);
          } catch (error) {
            await attachDiagnostics(refreshContext, 'refresh-not-ready');
            throw error;
          }
          await expect(page).toHaveURL(original);
          expect(await runtimeProbe(page, { operation: 'read', url: resource, body })).toMatchObject({ readStatus: 200, matches: true, webId: expectedWebId, podUrl: expectedPod });
          await assertProtectedAiConfigContent(page, route);

          // The formal Status route additionally requires native Account controls.
          // Preserve the product's own router navigation when it is available.
          const statusStartedAt = Date.now();
          const statusMark = diagnostics.mark();
          const statusContext = diagnosticContext(statusMark, statusStartedAt, 'status-navigation');
          try {
            await withNavigationObservation(statusContext, STATUS_NAVIGATION_OBSERVATION_MS, () => page.goto(`${origin}/status/overview`, { waitUntil: 'domcontentloaded' }));
          } catch (error) {
            await attachDiagnostics(statusContext, 'status-navigation-stall');
            throw error;
          }
          await expect.poll(() => accountProbe(page, expectedWebId), { timeout: 45_000 }).toMatchObject({ authenticated: true, ownsWebId: true });
          const account = await accountProbe(page, expectedWebId);
          expect(new URL(account.authority!).origin).toBe(new URL(deployment.issuer).origin);
          if (accountControl) expect(account.webIdControl).toBe(accountControl);
          accountControl = account.webIdControl;
          expect(accountControl).toBeTruthy();
          const authenticatedWebIdControl = account.webIdControl!;

          await completeOfflineProductLogout(page, context);
          await expect.poll(async () => {
            const state = await accountProbe(page, expectedWebId);
            return state.anonymous === true && await page.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession') === null);
          }, { timeout: 45_000 }).toBe(true);
          const revokedAccountStatus = await page.evaluate(async url => {
            const response = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
            return response.status;
          }, authenticatedWebIdControl);
          expect([401, 403]).toContain(revokedAccountStatus);
          const anonymousRead = await page.request.get(resource);
          expect([401, 403]).toContain(anonymousRead.status());
          await testInfo.attach('deployment-evidence', {
            contentType: 'application/json',
            body: JSON.stringify({ mode: deployment.mode, runnerBunVersion: deployment.runnerBunVersion, entry: route, origin, issuer: deployment.issuer,
              topology: { productHostname: new URL(origin).hostname, issuerHostname: new URL(deployment.issuer).hostname, distinctOrigin: origin !== new URL(deployment.issuer).origin },
              selected: binding, tokenStatuses, accountControl, privateWriteRead: true, refreshRead: true, offlineRecovery: true, offlineLogoutRetry: true, revokedAccountStatus, signedOut: true }),
          });
        } finally {
          diagnostics.detach();
        }
      });
    }
    test('delayed real Pod providers cannot continue Gateway reads after product logout', async ({ page }, testInfo) => {
      const origin = new URL(deployment.baseUrl).origin;
      const expectedPod = `${origin}/${deployment.account.username}/`;
      const calls: Array<{ origin: string; phase: string }> = [];
      let phase = 'login';
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/api/ai/connections/authorization-methods') calls.push({ origin: url.origin, phase });
      });
      try {
        await completeOidcLogin(page, { ...deployment.account, podUrl: expectedPod, webId: `${expectedPod}profile/card#me` }, {
          baseUrl: origin, startUrl: `${origin}/ai-connections`, ready: productReady, requireCallbackEvidence: true,
        });
        phase = 'positive';
        await armDelayedProviders(page);
        phase = 'positive-release';
        await releaseDelayedProviders(page);
        expect(await delayedProvidersState(page)).toMatchObject({ resultReady: true, statusAtRelease: 'authenticated', settled: true, rejected: false });
        expect(calls.filter(call => call.phase === 'positive-release').length).toBeGreaterThan(0);
        expect(calls.filter(call => call.phase === 'positive-release').every(call => call.origin === origin)).toBe(true);
        await cleanupDelayedProviders(page);

        phase = 'delayed';
        await armDelayedProviders(page);
        const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
        if (!await signOut.isVisible()) await page.getByTestId('xpod-user-card-trigger').click();
        await signOut.click();
        await expect(page.getByTestId('xpod-user-card-trigger')).toHaveCount(0);
        await expect(page.getByText('退出未完成', { exact: true })).toHaveCount(0);
        await expect.poll(async () => (await readBrowserXpodAccount(page)).isAnonymous, { timeout: 30_000 }).toBe(true);
        expect(await page.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession'))).toBeNull();
        expect(await delayedProvidersState(page)).toMatchObject({ resultReady: true, released: false, settled: false });
        phase = 'after-logout';
        await releaseDelayedProviders(page);
        const operation = await delayedProvidersState(page);
        await testInfo.attach('delayed-provider-logout', { contentType: 'application/json',
          body: JSON.stringify({ mode: deployment.mode, calls, operation }) });
        expect(operation).toMatchObject({ statusAtRelease: 'anonymous', settled: true, rejected: true });
        expect(calls.filter(call => call.phase === 'after-logout')).toEqual([]);
      } finally {
        try {
          await cleanupDelayedProviders(page);
        } catch (error) {
          await testInfo.attach('delayed-provider-cleanup-failed', { contentType: 'application/json',
            body: JSON.stringify({ mode: deployment.mode, cleanupFailed: true }) });
          throw error;
        }
      }
    });
  });
}

type OriginNavigationSnapshot = {
  elapsedMs: number;
  /**
   * Observed main-frame navigations in this window. This is evidence that
   * Chromium committed a main-frame navigation — it is NOT proof that the
   * document, its module scripts or its data requests finished loading and
   * executing, and it must not be derived from a DOMContentLoaded wait.
   */
  observedMainFrameNavigation: boolean;
  mainFrameNavigations: string[];
  finishedCount: number;
  failed: string[];
  pending: Array<{ request: string; resourceType: string; pendingMs: number }>;
};

/**
 * One small, sanitized, bounded same-origin request/navigation collector shared
 * by every observation window (initial navigation, refresh, Status navigation).
 * Requests are keyed by Playwright Request identity so two concurrent requests
 * to the same METHOD + pathname stay independently pending. It exposes only
 * origin + normalized pathname — no queries, headers, bodies or cookies.
 */
function createOriginNavigationCollector(page: Page, origin: string) {
  // Large enough that the earliest window's events survive later activity, still
  // a hard bound on retained facts.
  const MAX_EVENTS = 512;
  const pending = new Map<Request, { resourceType: string; at: number; key: string }>();
  const events: Array<{ at: number; kind: 'finished' | 'failed' | 'navigation'; detail: string }> = [];
  const describe = (request: Request): string | undefined => {
    try {
      const url = new URL(request.url());
      if (url.origin !== origin) return undefined;
      return `${request.method()} ${url.origin}${normalizeAccountPath(url.pathname)}`;
    } catch {
      return undefined;
    }
  };
  const record = (kind: 'finished' | 'failed' | 'navigation', detail: string) => {
    events.push({ at: Date.now(), kind, detail });
    if (events.length > MAX_EVENTS) events.shift();
  };
  const onRequest = (request: Request) => {
    const key = describe(request);
    if (!key) return;
    pending.set(request, { resourceType: request.resourceType(), at: Date.now(), key });
  };
  const onFinished = (request: Request) => {
    const entry = pending.get(request);
    if (!entry) return;
    pending.delete(request);
    record('finished', entry.key);
  };
  const onFailed = (request: Request) => {
    const entry = pending.get(request);
    if (!entry) return;
    pending.delete(request);
    record('failed', `${entry.key} :: ${request.failure()?.errorText ?? 'failed'}`);
  };
  const onNavigated = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    let url: URL;
    try {
      url = new URL(frame.url());
    } catch {
      return;
    }
    if (url.origin !== origin) return;
    record('navigation', `${url.origin}${normalizeAccountPath(url.pathname)}`);
  };
  return {
    attach(): void {
      page.on('request', onRequest);
      page.on('requestfinished', onFinished);
      page.on('requestfailed', onFailed);
      page.on('framenavigated', onNavigated);
    },
    detach(): void {
      page.off('request', onRequest);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
      page.off('framenavigated', onNavigated);
    },
    mark(): number {
      return Date.now();
    },
    snapshot(mark: number, startedAt: number): OriginNavigationSnapshot {
      const since = events.filter(event => event.at >= mark);
      const navigations = since.filter(event => event.kind === 'navigation').map(event => event.detail);
      return {
        elapsedMs: Date.now() - startedAt,
        observedMainFrameNavigation: navigations.length > 0,
        mainFrameNavigations: navigations,
        finishedCount: since.filter(event => event.kind === 'finished').length,
        failed: since.filter(event => event.kind === 'failed').map(event => event.detail),
        pending: [...pending.values()].map(({ key, resourceType, at }) => ({ request: key, resourceType, pendingMs: Date.now() - at })),
      };
    },
  };
}

type OriginNavigationCollector = ReturnType<typeof createOriginNavigationCollector>;

type DiagnosticContext = {
  page: Page;
  testInfo: TestInfo;
  collector: OriginNavigationCollector;
  mark: number;
  startedAt: number;
  mode: string;
  route: string;
  /** Attachment name prefix; a stall is reported as `${name}-stall`. */
  name: string;
};

/** Bounded window around a navigation with no internal timeout. One timer
 * implementation, always cleared, that cannot fire after `stop()`. */
function armNavigationObservation(context: DiagnosticContext, budgetMs: number): { stop(): void } {
  let stopped = false;
  const timer = setTimeout(() => {
    if (stopped) return;
    // Attach from the live test: an attachment attempted only after the 240 s
    // test deadline may never be written.
    void attachDiagnostics(context, `${context.name}-stall`).catch(() => undefined);
  }, budgetMs);
  return {
    stop(): void {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

async function withNavigationObservation<T>(context: DiagnosticContext, budgetMs: number, work: () => Promise<T>): Promise<T> {
  const observation = armNavigationObservation(context, budgetMs);
  try {
    return await work();
  } finally {
    observation.stop();
  }
}

async function collectBoundedDiagnostics(context: DiagnosticContext): Promise<Record<string, unknown>> {
  const { page, collector, mark, startedAt, mode, route, name } = context;
  // Pure event facts first and synchronously: they must survive an unresponsive
  // renderer, so the snapshot never depends on page.evaluate resolving.
  const events = collector.snapshot(mark, startedAt);
  const probes = await boundedProbe((async () => ({
    readyState: await page.evaluate(() => document.readyState).catch(() => 'unavailable'),
    visibility: await page.evaluate(() => document.visibilityState).catch(() => 'unavailable'),
    productReady: await productReady(page).catch(() => false),
    identity: await readBrowserXpodRuntime(page)
      .then(value => ({ status: value.status, podUrl: value.podUrl, webId: value.webId }))
      .catch(() => null),
    resources: await page.evaluate(() => performance.getEntriesByType('resource').map(entry => {
      const timing = entry as PerformanceResourceTiming;
      const url = new URL(timing.name);
      return `${timing.initiatorType}:${url.origin === location.origin ? url.pathname : url.origin}:${Math.round(timing.duration)}ms:${timing.transferSize ?? 0}B`;
    }).slice(-24)).catch(() => [] as string[]),
  }))(), 2_500, { '<probe-timeout>': true } as Record<string, unknown>);
  return { name, mode, route, ...events, probes };
}

/** Attach bounded facts; a hung page can neither block the attachment nor the test. */
async function attachDiagnostics(context: DiagnosticContext, name: string): Promise<void> {
  const facts = await boundedProbe(
    collectBoundedDiagnostics(context).catch(() => ({ error: 'diagnostics-unavailable' })),
    8_000,
    { error: 'diagnostics-timeout' },
  );
  await boundedProbe(
    context.testInfo.attach(name, { contentType: 'application/json', body: JSON.stringify(facts, null, 2) })
      .then(() => true).catch(() => false),
    5_000,
    false,
  );
}

async function productReady(page: Page): Promise<boolean> {
  return page.locator('[data-testid="xpod-user-card-trigger"][data-pod-ready="true"]').isVisible().catch(() => false);
}

/**
 * Protected-content acceptance for the AI Config route. `productReady` only
 * proves the signed-in user card mounted; on `/ai-config/model-assignments` the
 * route must additionally render its six model-assignment controls with no
 * load error. This proves the protected route actually read Pod data, and is a
 * no-op for entries without an equivalent protected-content contract.
 */
async function assertProtectedAiConfigContent(page: Page, route: string): Promise<void> {
  if (!route.startsWith('/ai-config')) return;
  const rows = page.locator('[data-testid="model-assignment-row"]');
  const loadError = page.getByText('AI configuration could not be loaded', { exact: true });
  await expect.poll(() => rows.count(), { timeout: 60_000 }).toBe(6);
  await expect(loadError).toHaveCount(0);
  expect(new URL(page.url()).pathname.startsWith('/ai-config')).toBe(true);
}

async function registerFromProduct(page: Page, deployment: Deployment, startUrl: string): Promise<void> {
  const issuerOrigin = new URL(deployment.issuer).origin;
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(url => url.origin === issuerOrigin && url.pathname.startsWith('/.account/'), { timeout: 60_000 });
  // The sign-in footer opens registration through its own "注册账号" text action.
  // That entry is a different control from the register form's "创建账号" submit;
  // binding them to one label is exactly what the product stopped doing.
  await page.getByRole('button', { name: '注册账号', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(deployment.account.email);
  await page.getByLabel('密码', { exact: true }).fill(deployment.account.password);
  await page.getByRole('button', { name: '创建账号', exact: true }).click();

  // Registration creates the Account only. With a pending authorization the
  // product hands over to the *original* Consent, which now only guides: it
  // carries no WebID/Pod name form and never creates from the authorization page.
  await page.waitForURL(url => url.origin === issuerOrigin && url.pathname.includes('/oidc/consent/'), { timeout: 120_000, waitUntil: 'domcontentloaded' });
  const consentUrl = new URL(page.url());
  const consentOrigin = consentUrl.origin;
  const consentPath = consentUrl.pathname;
  expect(consentOrigin).toBe(issuerOrigin);
  const interactionScope = /^\/\.account\/interaction\/[^/]+/u.exec(consentPath)?.[0];
  if (!interactionScope) throw new Error(`Consent URL is not scoped to an interaction: ${consentPath}`);
  const quickCreatePath = `${interactionScope}/create-pod/`;
  await expect(page.getByRole('heading', { name: '还没有 WebID', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('first-pod-quick-create')).toHaveCount(0);
  await expect(page.locator('input[name="podName"]')).toHaveCount(0);
  await expect(page.locator('input[name="webIdName"]')).toHaveCount(0);

  // The missing-Pod primary action hands the one-time task to the same-UID
  // lightweight quick-create page; it must keep the Consent's origin and the
  // exact same interaction scope path.
  const enterQuickCreate = async (): Promise<void> => {
    await page.getByRole('button', { name: '创建并继续', exact: true }).click();
    await page.waitForURL(url => url.origin === consentOrigin && url.pathname === quickCreatePath, { timeout: 60_000, waitUntil: 'domcontentloaded' });
    expect(new URL(page.url()).origin).toBe(consentOrigin);
    expect(new URL(page.url()).pathname).toBe(quickCreatePath);
  };
  await enterQuickCreate();

  // "使用自己的部署" is the explicit detour into heavy Pod management. It must be
  // reachable on the same origin and hand back to this very Consent; it only
  // navigates (no creation, no network deployment, no Account-gate bypass).
  await page.getByTestId('first-pod-quick-create').waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: '使用自己的部署', exact: true }).click();
  await page.waitForURL(url => url.origin === consentOrigin && url.pathname === '/settings/pod', { timeout: 60_000, waitUntil: 'domcontentloaded' });
  expect(new URL(page.url()).origin).toBe(consentOrigin);
  expect(new URL(page.url()).pathname).toBe('/settings/pod');
  await expect(page.getByTestId('consent-resume-banner')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: '回到授权', exact: true }).click();
  await page.waitForURL(url => url.origin === consentOrigin && url.pathname === consentPath, { timeout: 60_000, waitUntil: 'domcontentloaded' });
  expect(new URL(page.url()).origin).toBe(consentOrigin);
  expect(new URL(page.url()).pathname).toBe(consentPath);

  // Back on the same Consent, re-enter the same-UID quick-create page, then the
  // user names the Pod and explicitly submits before anything is created.
  await enterQuickCreate();
  const quickCreate = page.getByTestId('first-pod-quick-create');
  await quickCreate.waitFor({ timeout: 120_000 });
  await quickCreate.getByLabel('Pod 名称').fill(deployment.account.username);
  await quickCreate.getByRole('button', { name: '创建 Pod 并继续授权', exact: true }).click();

  // Creation returns to the very same Consent: same origin, interaction UID and target.
  await page.waitForURL(url => url.origin === consentOrigin && url.pathname === consentPath, { timeout: 120_000, waitUntil: 'domcontentloaded' });
  expect(new URL(page.url()).origin).toBe(consentOrigin);
  expect(new URL(page.url()).pathname).toBe(consentPath);
}

type ProbeRequest = { operation: 'identity' | 'write-read' | 'read'; url?: string; body?: string };
async function runtimeProbe(page: Page, request: ProbeRequest): Promise<Record<string, unknown>> {
  const identity = await readBrowserXpodRuntime(page);
  if (request.operation === 'identity') return { ...identity };
  if (!identity.podUrl || !request.url?.startsWith(identity.podUrl)) {
    throw new Error('Probe resource must be inside the selected Pod');
  }
  const resourcePath = request.url.slice(identity.podUrl.length);
  const write = request.operation === 'write-read'
    ? await fetchBrowserXpodPod(page, resourcePath, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: request.body })
    : undefined;
  const read = await fetchBrowserXpodPod(page, resourcePath);
  const anonymousStatus = await page.evaluate(async url => (await fetch(url, { credentials: 'omit' })).status, request.url);
  return { ...identity, writeStatus: write?.status, readStatus: read.status, matches: read.body === request.body,
    anonymousDenied: [401, 403].includes(anonymousStatus) };
}

async function accountProbe(page: Page, expectedWebId: string): Promise<{
  authenticated?: boolean; anonymous?: boolean; authority?: string; webIdControl?: string; ownsWebId?: boolean;
}> {
  try {
    const account = await readBrowserXpodAccount(page);
    const webIdControl = account.controls.account?.webId;
    const ownsWebId = account.status === 'authenticated' && Boolean(webIdControl) && await page.evaluate(async ({ url, webId }) => {
      const response = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      return response.ok && Object.prototype.hasOwnProperty.call((await response.json()).webIdLinks ?? {}, webId);
    }, { url: webIdControl!, webId: expectedWebId });
    return { authenticated: account.status === 'authenticated', anonymous: account.isAnonymous,
      authority: account.authority, webIdControl, ownsWebId };
  } catch {
    return {};
  }
}
