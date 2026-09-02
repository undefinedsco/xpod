import { spawn } from 'node:child_process';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Page, test } from '@playwright/test';
import {
  completeOidcLogin,
  type BrowserSolidAccount,
} from '../helpers/browserSolidOidc';

const readyPrefix = 'XPOD_SETTINGS_FIXTURE_READY ';
const failurePrefix = 'XPOD_SETTINGS_FIXTURE_ERROR ';

type FixtureReady = {
  type: 'ready';
  baseUrl: string;
  controlUrl: string;
  accounts: { alice: BrowserSolidAccount };
};

class FeatureMatrixHarness {
  private constructor(
    private readonly child: ReturnType<typeof spawn>,
    readonly ready: FixtureReady,
  ) {}

  static async start(): Promise<FeatureMatrixHarness> {
    const child = spawn('bun', [path.resolve('tests/helpers/xpodSettingsFixtureServer.ts')], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    const ready = await new Promise<FixtureReady>((resolve, reject) => {
      let output = '';
      let settled = false;
      const timeout = setTimeout(() => fail(new Error('Xpod feature fixture startup timed out')), 120_000);
      const cleanup = () => {
        child.stdout.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
        child.stdout.resume();
      };
      const succeed = (value: FixtureReady) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        resolve(value);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        reject(error);
      };
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        for (const line of output.split('\n')) {
          if (line.startsWith(failurePrefix)) {
            fail(new Error('Xpod feature fixture reported startup failure'));
            return;
          }
          if (!line.startsWith(readyPrefix)) continue;
          try {
            succeed(JSON.parse(line.slice(readyPrefix.length)) as FixtureReady);
          } catch {
            fail(new Error('Xpod feature fixture returned invalid ready JSON'));
          }
          return;
        }
        output = output.slice(output.lastIndexOf('\n') + 1);
      };
      const onError = () => fail(new Error('Xpod feature fixture process failed to start'));
      const onExit = (code: number | null) => {
        if (code !== null && code !== 0) fail(new Error('Xpod feature fixture exited before ready'));
      };
      child.stdout.on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
    });
    return new FeatureMatrixHarness(child, ready);
  }

  async stop(): Promise<void> {
    try {
      await fetch(new URL('/control/shutdown', this.ready.controlUrl), {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // The fixture may already have stopped after a failed scenario.
    }
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) {
        resolve();
        return;
      }
      const termTimer = setTimeout(() => {
        this.child.kill('SIGTERM');
        setTimeout(() => {
          if (this.child.exitCode === null) this.child.kill('SIGKILL');
          resolve();
        }, 5_000);
      }, 10_000);
      this.child.once('exit', () => {
        clearTimeout(termTimer);
        resolve();
      });
    });
  }
}

type MatrixRoute = {
  path: string;
  header: RegExp;
  content: RegExp;
};

const statusRoutes: MatrixRoute[] = [
  { path: '/status/overview', header: /Status · Overview/u, content: /Xpod runtime/u },
  { path: '/status/services/gateway', header: /Status · Gateway/u, content: /Gateway/u },
  { path: '/status/services/solid-server', header: /Status · Solid Server/u, content: /Solid Server/u },
  { path: '/status/services/api-server', header: /Status · API Server/u, content: /API Server/u },
  { path: '/status/logs', header: /Status · Logs/u, content: /Diagnostics|日志|runtime log/i },
  { path: '/status/index', header: /Status · Index Overview/u, content: /Derived index overview|Index Overview/i },
  { path: '/status/index/rdf', header: /Status · RDF/u, content: /RDF/i },
  { path: '/status/index/fts', header: /Status · FTS/u, content: /Full-text|FTS/i },
  { path: '/status/index/vector', header: /Status · Vector/u, content: /Vector/i },
  { path: '/status/index/retrieval-points', header: /Status · Retrieval Points/u, content: /Retrieval Points/i },
  { path: '/status/index/cache', header: /Status · Cache/u, content: /Cache/i },
  { path: '/status/index/slow-queries', header: /Status · Slow Queries/u, content: /Slow Queries/i },
  { path: '/status/index/benchmark', header: /Status · Benchmark/u, content: /Benchmark/i },
  { path: '/status/usage', header: /Status · Usage Overview/u, content: /Usage|用量/i },
  { path: '/status/usage/storage', header: /Status · Storage/u, content: /Storage/i },
  { path: '/status/usage/bandwidth', header: /Status · Bandwidth/u, content: /Bandwidth/i },
  { path: '/status/usage/ai', header: /Status · AI Usage/u, content: /AI Usage|tokens|compute/i },
  { path: '/status/usage/index-storage', header: /Status · Index Storage/u, content: /Index Storage|Derived/i },
];

const networkRoutes: MatrixRoute[] = [
  { path: '/network', header: /Network · Overview/u, content: /Recommended access path/u },
  { path: '/network/endpoints', header: /Network · Endpoints/u, content: /接入点|Canonical URL/u },
  { path: '/network/addresses', header: /Network · Addresses/u, content: /网络地址|Loopback|LAN/u },
  { path: '/network/domain-dns', header: /Network · Domain & DNS/u, content: /Observed DNS|Domain & DNS/u },
  { path: '/network/https', header: /Network · HTTPS/u, content: /Observed HTTPS|HTTPS/u },
  { path: '/network/tunnel-profiles', header: /Network · Tunnel Profiles/u, content: /Observed tunnel|Tunnel Profiles/u },
  { path: '/network/p2p', header: /Network · P2P/u, content: /P2P/u },
  { path: '/network/diagnostics', header: /Network · Diagnostics/u, content: /操作|diagnostics|连通性/u },
];

const aiConfigRoutes: MatrixRoute[] = [
  { path: '/ai-config/model-assignments', header: /AI Config · Model Assignments/u, content: /General \/ Chat|OCR|Embedding/u },
  { path: '/ai-config/document-processing', header: /AI Config · Document Processing/u, content: /OCR|Document Reader|Table recognition/u },
  { path: '/ai-config/search-indexing', header: /AI Config · Search & Indexing/u, content: /Full-text Search|Vector Search/u },
  { path: '/ai-config/index-lifecycle', header: /AI Config · Index Lifecycle/u, content: /automatic maintenance|Automatic indexing|Index Lifecycle/i },
];

const settingsRoutes: MatrixRoute[] = [
  { path: '/ai-connections', header: /Models|AI Connections/i, content: /OpenAI|Anthropic|Kimi|DeepSeek/i },
  { path: '/settings/pod', header: /Settings · Pod/u, content: /Current Pod identity|Pod/u },
  { path: '/settings/identity-access', header: /Settings · Identity & Access/u, content: /Session|WebID|Account/i },
  { path: '/settings/storage', header: /Settings · Storage/u, content: /Storage|backend|limits/i },
  { path: '/settings/runtime', header: /Settings · Runtime/u, content: /Runtime|configuration/i },
  { path: '/settings/advanced', header: /Settings · Advanced/u, content: /Advanced|Expert|compatibility/i },
];

let harness: FeatureMatrixHarness;
let context: BrowserContext;
let page: Page;

test.describe.configure({ timeout: 240_000 });

test.describe('Xpod desktop feature matrix acceptance', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    harness = await FeatureMatrixHarness.start();
    ({ context, page } = await createLoggedInMatrixPage(browser));
  });

  test.afterAll(async () => {
    await context?.close();
    await harness?.stop();
  });

  test('mounts every declared product route without showing login or generic failures', async () => {
    const failures: string[] = [];
    for (const [group, routes] of [
      ['Status', statusRoutes],
      ['Network', networkRoutes],
      ['AI Config', aiConfigRoutes],
      ['Settings', settingsRoutes],
    ] as const) {
      const groupFailures = await collectRouteFailures(routes);
      failures.push(...groupFailures.map((failure) => `${group}: ${failure}`));
    }
    expect(failures).toEqual([]);
  });

  test('shows six model assignment rows on the AI Config assignment route', async () => {
    const failures: string[] = [];
    for (const route of aiConfigRoutes.filter((item) => item.path.endsWith('/model-assignments'))) {
      const failure = await captureRouteFailure(route, async () => {
        await assertRouteHealthy(route);
        await expect(page.locator('[data-testid="model-assignment-row"]')).toHaveCount(6);
      });
      if (failure) failures.push(failure);
    }
    expect(failures).toEqual([]);
  });
});

async function createLoggedInMatrixPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nextContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const nextPage = await nextContext.newPage();
    try {
      await loginToPodBackedSurface(nextPage);
      return { context: nextContext, page: nextPage };
    } catch (error) {
      lastError = error;
      await nextContext.close().catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function loginToPodBackedSurface(target: Page): Promise<void> {
  const trace = await completeOidcLogin(target, harness.ready.accounts.alice, {
    baseUrl: harness.ready.baseUrl,
    startUrl: new URL('/ai-connections', harness.ready.baseUrl).href,
    ready: isPodBackedWorkspaceReady,
    requireCallbackEvidence: true,
    timeoutMs: 90_000,
  });
  expect(trace.authorizationRequestSeen).toBe(true);
  expect(trace.authCodeChallengeSeen).toBe(true);
  expect(trace.authCodeChallengeMethodS256).toBe(true);
  expect(trace.redirectCodeSeen).toBe(true);
  expect(trace.tokenAuthorizationCodeGrantSeen).toBe(true);
  expect(trace.tokenCodeVerifierSeen).toBe(true);
}

async function isPodBackedWorkspaceReady(target: Page): Promise<boolean> {
  if (!await target.locator('[data-testid="xpod-user-card-trigger"][data-pod-ready="true"]').isVisible({ timeout: 250 }).catch(() => false)) return false;
  if (!await target.locator('[data-workspace-layout]').first().isVisible({ timeout: 250 }).catch(() => false)) return false;
  return await target.locator('[data-testid="workspace-main-pane"]').first().isVisible({ timeout: 250 }).catch(() => false);
}

async function assertRouteHealthy(route: MatrixRoute): Promise<void> {
  await openRoute(route.path);
  const earlyBody = await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '');
  if (/^\s*\{"error":/u.test(earlyBody)) {
    throw new Error(`server returned JSON error instead of product shell: ${earlyBody}`);
  }
  await expect(page.locator('[data-workspace-layout]'), `${route.path} workspace shell`).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('xpod-user-card-trigger'), `${route.path} account card`).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(route.header).first(), `${route.path} header`).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('body'), `${route.path} content`).toContainText(route.content, { timeout: 30_000 });
  await assertNoAuthOrGenericError(route.path);
}

async function collectRouteFailures(routes: MatrixRoute[]): Promise<string[]> {
  const failures: string[] = [];
  for (const route of routes) {
    const failure = await captureRouteFailure(route, () => assertRouteHealthy(route));
    if (failure) failures.push(failure);
  }
  return failures;
}

async function captureRouteFailure(route: MatrixRoute, assertion: () => Promise<void>): Promise<string | null> {
  try {
    await assertion();
    return null;
  } catch (error) {
    return `${route.path}: ${error instanceof Error ? error.message : String(error)}; ${await pageSnapshot()}`;
  }
}

async function openRoute(routePath: string): Promise<void> {
  const destination = new URL(routePath, harness.ready.baseUrl).href;
  await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await expect.poll(() => new URL(page.url()).pathname, {
    timeout: 15_000,
    message: `${routePath} did not settle on a product route`,
  }).toBe(new URL(routePath, harness.ready.baseUrl).pathname);
}

async function assertNoAuthOrGenericError(routePath: string): Promise<void> {
  await expect(page.getByTestId('auth-surface-page'), `${routePath} must not show full-page login`).toHaveCount(0);
  await expect(page.getByTestId('auth-surface-modal'), `${routePath} must not show login modal`).toHaveCount(0);
  const bodyText = await page.locator('body').innerText({ timeout: 5_000 });
  expect(bodyText, `${routePath} body must not contain generic auth/runtime errors`).not.toMatch(
    /Failed to (?:load|read|fetch)|Unable to complete Xpod sign-in|Account unavailable|Could not connect to Xpod|Not logged in|This resource is only accessible by logged in agents/i,
  );
}

async function pageSnapshot(): Promise<string> {
  const url = page.url();
  const body = await page.locator('body').innerText({ timeout: 1_000 })
    .then((value) => value.replace(/\s+/gu, ' ').trim().slice(0, 300))
    .catch(() => '<body unavailable>');
  return `url=${url}; body=${body}`;
}
