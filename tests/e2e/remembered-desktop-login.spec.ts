import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, type BrowserContext, type Page, test } from '@playwright/test';

const repositoryRoot = path.resolve(__dirname, '../..');
const testDataRoot = path.join(repositoryRoot, '.test-data');
const seedEmail = 'remembered-desktop@example.test';
const seedPassword = 'LocalSeed123456!';
const seedPodName = 'remembered';
const clientId = 'https://id.undefineds.co/app/xpod-desktop-client.json';

interface LocalSeedRuntime {
  baseUrl: string;
  seedWebId: string;
  seedPodUrl: string;
  root: string;
  startupLogPath: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

test('remembered desktop grants resume with only the Account cookie, while explicit consent still asks', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const runtime = await startLocalSeedRuntime();
  let context: BrowserContext | undefined;
  let callback: Server | undefined;
  let activePage: Page | undefined;
  try {
    callback = createServer((request, response) => {
      response.writeHead(request.url?.startsWith('/auth/callback?') ? 200 : 404, { 'content-type': 'text/plain' });
      response.end('Desktop authorization callback received');
    });
    await new Promise<void>((resolve) => callback!.listen(0, '127.0.0.1', resolve));
    const address = callback.address();
    if (!address || typeof address === 'string') throw new Error('Missing callback port');
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const discovery = await fetch(`${runtime.baseUrl}.well-known/openid-configuration`);
    expect(discovery.ok).toBe(true);
    const metadata = await discovery.json() as { authorization_endpoint: string; token_endpoint: string };
    context = await browser.newContext();
    const page = await context.newPage();
    activePage = page;
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
    });

    const authorize = async (prompt?: string) => {
      const verifier = randomBytes(32).toString('base64url');
      const state = randomBytes(16).toString('hex');
      const url = new URL(metadata.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: 'openid webid offline_access', state, nonce: randomBytes(16).toString('hex'),
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256', ...(prompt ? { prompt } : {}),
      }).toString();
      await page.goto(url.href);
      return { verifier, state };
    };
    const verifyCallback = async ({ verifier, state }: { verifier: string; state: string }) => {
      await expect(page).toHaveURL((url) => url.origin === new URL(redirectUri).origin && url.pathname === '/auth/callback', { timeout: 45_000 });
      const params = new URL(page.url()).searchParams;
      expect(params.get('error')).toBeNull();
      expect(params.get('state')).toBe(state);
      expect(params.get('code')).toBeTruthy();
      const token = await fetch(metadata.token_endpoint, {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
          redirect_uri: redirectUri, code: params.get('code')!, code_verifier: verifier }),
      });
      expect(token.status).toBe(200);
      const body = await token.json() as { access_token?: string; id_token?: string };
      expect(body.access_token).toBeTruthy();
      expect(body.id_token).toBeTruthy();
      const claims = JSON.parse(Buffer.from(body.id_token!.split('.')[1]!, 'base64url').toString()) as { webid?: string; sub?: string };
      expect(claims.webid ?? claims.sub).toBe(runtime.seedWebId);
    };

    const first = await authorize();
    await completeAccountLogin(page);
    await expect(page.getByRole('button', { name: '批准', exact: true })).toBeVisible({ timeout: 45_000 });
    await page.getByRole('checkbox', { name: '记住这个应用', exact: true }).check();
    await page.getByRole('button', { name: '批准', exact: true }).click();
    await verifyCallback(first);
    expect(posts.filter((url) => url === '/.account/oidc/consent/')).toHaveLength(1);

    const accountCookies = (await context.cookies(runtime.baseUrl)).filter((cookie) => cookie.name === 'css-account');
    expect(accountCookies).toHaveLength(1);
    // Expire only the provider session, retaining the actual browser Account
    // cookie. Clearing browser storage prevents localStorage tokens hiding a
    // regression in Account-cookie restoration.
    const sessionCookies = (await context.cookies(runtime.baseUrl)).filter((cookie) => /^_session(?:\.|$)/u.test(cookie.name));
    expect(sessionCookies.length).toBeGreaterThan(0);
    for (const cookie of sessionCookies) await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
    await page.goto(`${runtime.baseUrl}.account/`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    expect((await context.cookies(runtime.baseUrl)).filter((cookie) => cookie.name === 'css-account')).toEqual(accountCookies);
    posts.length = 0;
    const silent = await authorize('none');
    await expect(page).toHaveURL((url) => url.origin === new URL(redirectUri).origin && url.pathname === '/auth/callback', { timeout: 30_000 });
    const silentParams = new URL(page.url()).searchParams;
    expect(silentParams.get('state')).toBe(silent.state);
    expect(silentParams.get('error')).toBe('login_required');
    expect(silentParams.get('code')).toBeNull();
    expect(posts).toHaveLength(0);
    const resumed = await authorize();
    await verifyCallback(resumed);
    expect(posts.filter((url) => url === '/.account/oidc/pick-webid/')).toHaveLength(1);
    expect(posts.filter((url) => url === '/.account/oidc/consent/')).toHaveLength(0);
    expect(posts.filter((url) => url === '/.account/login/password/')).toHaveLength(0);

    posts.length = 0;
    const explicit = await authorize('consent');
    await expect(page.getByRole('button', { name: '批准', exact: true })).toBeVisible({ timeout: 30_000 });
    expect(posts.filter((url) => url === '/.account/oidc/consent/')).toHaveLength(0);
    await testInfo.attach('explicit-consent', { body: await page.screenshot(), contentType: 'image/png' });
    await page.getByRole('button', { name: '批准', exact: true }).click();
    await verifyCallback(explicit);
    expect(posts.filter((url) => url === '/.account/oidc/consent/')).toHaveLength(1);
  } catch (error) {
    await testInfo.attach('startup-log', { body: await readFile(runtime.startupLogPath), contentType: 'text/plain' });
    if (activePage) {
      await activePage.screenshot({ fullPage: true }).then((body) => testInfo.attach('failed-page', { body, contentType: 'image/png' })).catch(() => undefined);
      await testInfo.attach('failed-page-url', { body: activePage.url(), contentType: 'text/plain' });
    }
    throw error;
  } finally {
    await context?.close();
    if (callback) await new Promise<void>((resolve, reject) => callback!.close((error) => error ? reject(error) : resolve()));
    await runtime.stop();
  }
});

async function startLocalSeedRuntime(): Promise<LocalSeedRuntime> {
  await mkdir(testDataRoot, { recursive: true });

  const root = await mkdtemp(path.join(testDataRoot, 'remembered-desktop-login-'));
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
  await page.getByRole('button', { name: /^(?:登录|sign in)$/i }).click({ timeout: 15_000 });
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
