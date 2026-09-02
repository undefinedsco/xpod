import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, type Browser, type BrowserContext, type Page, test } from '@playwright/test';

const repositoryRoot = path.resolve(__dirname, '../..');
const testDataRoot = path.join(repositoryRoot, '.test-data');
const seedEmail = 'local-seeded@example.test';
const seedPassword = 'LocalSeed123456!';
const seedPodName = 'seeded';

interface LocalSeedRuntime {
  baseUrl: string;
  seedWebId: string;
  seedPodUrl: string;
  root: string;
  startupLogPath: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

test.describe('Local product seed consent acceptance', () => {
  let runtime: LocalSeedRuntime;
  let browser: Browser;
  let context: BrowserContext;

  test.beforeAll(async ({ browser: testBrowser }) => {
    test.setTimeout(180_000);
    runtime = await startLocalSeedRuntime();
    browser = testBrowser;
    context = await browser.newContext();
  });

  test.afterAll(async () => {
    await context?.close().catch(() => undefined);
    await runtime?.stop();
  });

  test('serves seeded local identity and keeps its WebID on the real Settings consent flow', async ({}, testInfo) => {
    test.setTimeout(180_000);

    const status = await fetch(`${runtime.baseUrl}service/status`);
    expect(status.status).toBe(200);
    const services = await status.json() as Array<{ name?: string; status?: string }>;
    expect(services).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'css', status: 'running' }),
      expect.objectContaining({ name: 'api', status: 'running' }),
    ]));

    const login = await fetch(`${runtime.baseUrl}.account/login/password/`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ email: seedEmail, password: seedPassword }),
    });
    expect(login.status).toBe(200);
    const loginBody = await login.json() as { authorization?: string };
    expect(loginBody.authorization).toEqual(expect.any(String));

    const account = await fetch(`${runtime.baseUrl}.account/`, {
      headers: {
        accept: 'application/json',
        authorization: `CSS-Account-Token ${loginBody.authorization}`,
      },
    });
    expect(account.status).toBe(200);
    const accountBody = await account.json() as {
      controls?: { account?: { pod?: string; webId?: string } };
    };
    const podEndpoint = accountBody.controls?.account?.pod;
    const webIdEndpoint = accountBody.controls?.account?.webId;
    expect(podEndpoint).toEqual(expect.any(String));
    expect(webIdEndpoint).toEqual(expect.any(String));

    const accountHeaders = {
      accept: 'application/json',
      authorization: `CSS-Account-Token ${loginBody.authorization}`,
    };
    const pods = await fetch(podEndpoint!, { headers: accountHeaders });
    expect(pods.status).toBe(200);
    const podBody = await pods.json() as { pods?: Record<string, string> };
    const podLinks = podBody.pods ?? podBody;
    expect(podLinks).toEqual(expect.objectContaining({ [runtime.seedPodUrl]: expect.any(String) }));

    const webIds = await fetch(webIdEndpoint!, { headers: accountHeaders });
    expect(webIds.status).toBe(200);
    const webIdBody = await webIds.json() as { webIdLinks?: Record<string, string>; webIds?: Record<string, string> };
    const links = webIdBody.webIdLinks ?? webIdBody.webIds ?? {};
    expect(links).toEqual(expect.objectContaining({ [runtime.seedWebId]: expect.any(String) }));

    const page = await context.newPage();
    try {
      await gotoSettingsWithRetry(page, runtime.baseUrl, runtime.child);
      await expect(page.getByRole('region', { name: /connect xpod settings/i })).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: /登录|sign in/i }).click();

      await completeAccountLogin(page);
      await expect(page).toHaveURL(/\/\.account\/oidc\/consent\//u, { timeout: 60_000 });
      await expect(page.getByRole('heading', { name: '授权', exact: true })).toBeVisible();
      const radios = page.locator('input[type="radio"][name="webId"]');
      await expect(radios).toHaveCount(1);
      await expect(radios.first()).toHaveValue(runtime.seedWebId);
      await expect(page.locator('body')).not.toContainText(/创建第一个存储空间|Create your first storage/i);
      await testInfo.attach('local-seeded-consent', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });

      await page.getByRole('button', { name: '批准', exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 60_000 }).toMatch(/^\/settings\/(?:auth\/callback|models(?:\/.*)?)$/u);
      // The route-level WebIdAuthBoundary renders its unauthenticated surface
      // as `[data-auth-surface-mode="page"]`; after the consent round-trip the
      // session is authenticated, so that surface must be gone.
      await expect(page.locator('[data-auth-surface-mode="page"]')).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByRole('heading', { name: 'OpenAI', exact: true }).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('body')).not.toContainText(/Solid login failed|Please reconnect your Pod/i);
    } finally {
      await page.close();
    }

    const startupLog = await readFile(runtime.startupLogPath, 'utf8');
    expect(startupLog).not.toMatch(/postgres(?:ql)?:\/\//iu);
    expect(startupLog).not.toMatch(/postgres(?:ql)?\s+pool/iu);
    expect(startupLog).not.toMatch(/migration(?:s)?\s+(?:run|start|complete|failed)/iu);
    expect(startupLog).not.toMatch(/connection\s+(?:attempt|refused|error|failed)/iu);
  });
});

async function startLocalSeedRuntime(): Promise<LocalSeedRuntime> {
  await mkdir(testDataRoot, { recursive: true });
  await removeStaleLocalSeedRuntimes();
  const root = await mkdtemp(path.join(testDataRoot, 'local-seeded-consent-'));
  const seedConfigPath = path.join(root, 'seed.json');
  const identityDbPath = path.join(root, 'identity.sqlite');
  const seedPodUrl = `http://127.0.0.1:PORT/${seedPodName}/`;
  const seedWebId = `${seedPodUrl}profile/card#me`;
  await writeFile(seedConfigPath, JSON.stringify([
    { email: seedEmail, password: seedPassword, pods: [{ name: seedPodName }] },
  ], null, 2));

  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const resolvedSeedWebId = seedWebId.replace(':PORT', `:${port}`);
  const resolvedSeedPodUrl = seedPodUrl.replace(':PORT', `:${port}`);
  const startupLogPath = path.join(root, 'startup.log');
  const startupLog = createWriteStream(startupLogPath, { flags: 'a' });
  const child = spawn('bun', [
    'src/main.ts',
    '--mode', 'local',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--seedConfig', seedConfigPath,
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CSS_BASE_URL: baseUrl,
      CSS_IDENTITY_DB_URL: identityDbPath,
      DATABASE_URL: identityDbPath,
      CSS_ROOT_FILE_PATH: path.join(root, 'data'),
      CSS_SPARQL_ENDPOINT: path.join(root, 'quadstore.sqlite'),
      CSS_RDF_INDEX_PATH: path.join(root, 'rdf-index.sqlite'),
      CSS_LOGGING_LEVEL: 'info',
      CSS_REDIS_CLIENT: undefined,
      REDIS_URL: undefined,
      CSS_REDIS_USERNAME: undefined,
      CSS_REDIS_PASSWORD: undefined,
      CSS_MINIO_ACCESS_KEY: undefined,
      CSS_MINIO_SECRET_KEY: undefined,
      CSS_MINIO_ENDPOINT: undefined,
      CSS_MINIO_BUCKET_NAME: undefined,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(startupLog);
  child.stderr?.pipe(startupLog);

  try {
    await waitForStatus(baseUrl, child);
  } catch (error) {
    const startupFailure = error instanceof Error ? error.message : String(error);
    let cleanupError: unknown;
    let startupLogContents = '';
    try {
      try {
        await stopChild(child);
      } catch (stopFailure) {
        cleanupError = stopFailure;
      }
      try {
        child.stdout?.unpipe(startupLog);
        child.stderr?.unpipe(startupLog);
        await finishLogStream(startupLog);
      } catch (logFailure) {
        cleanupError ??= logFailure;
      }
      startupLogContents = await readFile(startupLogPath, 'utf8').catch(() => '');
    } catch (cleanupFailure) {
      cleanupError ??= cleanupFailure;
    } finally {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (removeFailure) {
        cleanupError ??= removeFailure;
      }
    }
    const cleanupMessage = cleanupError
      ? `\nCleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
      : '';
    throw new Error(`${startupFailure}${cleanupMessage}\n${startupLogContents}`, { cause: error });
  }

  return {
    baseUrl,
    seedWebId: resolvedSeedWebId,
    seedPodUrl: resolvedSeedPodUrl,
    root,
    startupLogPath,
    child,
    stop: async () => {
      let cleanupError: unknown;
      try {
        try {
          await stopChild(child);
        } catch (stopFailure) {
          cleanupError = stopFailure;
        }
        try {
          child.stdout?.unpipe(startupLog);
          child.stderr?.unpipe(startupLog);
          await finishLogStream(startupLog);
        } catch (logFailure) {
          cleanupError ??= logFailure;
        }
      } finally {
        try {
          await rm(root, { recursive: true, force: true });
        } catch (removeFailure) {
          cleanupError ??= removeFailure;
        }
      }
      if (cleanupError) throw cleanupError;
    },
  };
}

async function removeStaleLocalSeedRuntimes(): Promise<void> {
  let entries;
  try {
    entries = await readdir(testDataRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('local-seeded-consent-'))
    .map((entry) => rm(path.join(testDataRoot, entry.name), { recursive: true, force: true })));
}

async function finishLogStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  if (stream.closed || stream.writableEnded || stream.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    stream.end((error?: Error) => error ? reject(error) : resolve());
  });
}

async function completeAccountLogin(page: Page): Promise<void> {
  const email = page.locator('input[name="email"]');
  const password = page.locator('input[name="password"]');
  await expect(email).toBeVisible({ timeout: 60_000 });
  await email.fill(seedEmail);
  await password.fill(seedPassword);
  await page.getByRole('button', { name: /sign in/i }).click();
}

async function gotoSettingsWithRetry(page: Page, baseUrl: string, child: ChildProcess): Promise<void> {
  const url = `${baseUrl}settings/models`;
  const deadline = Date.now() + 60_000;
  let lastStatus = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      lastStatus = response ? String(response.status()) : 'no response';
      if (response?.ok()) return;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await waitForStatus(baseUrl, child);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Settings route did not become available (${lastStatus})`);
}

async function waitForStatus(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Local seed runtime exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}service/status`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const services = await response.json().catch(() => []) as Array<{ name?: string; status?: string }>;
        const running = new Set(services.filter((service) => service.status === 'running').map((service) => service.name));
        if (running.has('css') && running.has('api')) return;
      }
    } catch {
      // Child processes need a few seconds to initialize CSS components.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${baseUrl}service/status`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit').then(() => undefined),
    new Promise<void>((resolve) => setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 10_000)),
  ]);
}

async function findFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('Unable to allocate a free local port');
  return port;
}
