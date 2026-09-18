import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { completeOidcLogin, type BrowserSolidCredentials } from '../helpers/browserSolidOidc';
import { fetchBrowserXpodPod, readBrowserXpodRuntime } from '../helpers/browserXpodRuntime';

type Ready = { baseUrl: string; account: BrowserSolidCredentials & { webId: string; podUrl: string }; accessTokenTtl: number; refreshTokenTtl: number };
type TokenEvidence = { grant: string; status: number; receivedAt: number; expiresIn?: number; error?: string; refreshIssued: boolean };

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 8_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
async function start(mode: 'renew' | 'expire'): Promise<{ child: ChildProcess; ready: Ready }> {
  const child = spawn('bun', [path.resolve('tests/helpers/browserRefreshFixtureServer.ts'), mode], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr!.on('data', (chunk) => { diagnostics = (diagnostics + String(chunk)).slice(-12_000); });
  try {
    const ready = await new Promise<Ready>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      const timeout = setTimeout(() => reject(new Error(`Refresh fixture startup timed out: ${diagnostics}`)), 120_000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Refresh fixture exited ${code}: ${diagnostics}`)); });
      lines.on('line', (line) => {
        if (line.startsWith('XPOD_REFRESH_READY ')) {
          clearTimeout(timeout);
          resolve(JSON.parse(line.slice('XPOD_REFRESH_READY '.length)));
        }
      }); // Keep draining both child pipes for the fixture's entire lifetime.
    });
    return { child, ready };
  } catch (error) { await stop(child); throw error; }
}
async function ready(page: Page): Promise<boolean> {
  if (new URL(page.url()).pathname !== '/ai-connections') return false;
  return page.locator('[data-testid="xpod-user-card-trigger"][data-pod-ready="true"]').isVisible().catch(() => false);
}

for (const mode of ['renew', 'expire'] as const) {
  test(`real browser SDK ${mode === 'renew' ? 'automatically renews before private Pod read' : 'recovers through full login after refresh expiry'}`, async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    const fixture = await start(mode);
    const context = await browser.newContext().catch(async (error) => { await stop(fixture.child); throw error; });
    const page = await context.newPage().catch(async (error) => {
      try { await context.close(); } finally { await stop(fixture.child); }
      throw error;
    });
    const tokens: TokenEvidence[] = [];
    const pending = new Set<Promise<void>>();
    page.on('response', (response) => {
      const request = response.request();
      const grant = new URLSearchParams(request.postData() ?? '').get('grant_type');
      if (request.method() !== 'POST' || !['authorization_code', 'refresh_token'].includes(grant ?? '')) return;
      const task = response.json().then((body) => {
        tokens.push({ grant: grant!, status: response.status(), receivedAt: Date.now(),
          expiresIn: body.expires_in, error: body.error, refreshIssued: typeof body.refresh_token === 'string' });
      }).catch(() => undefined);
      pending.add(task); void task.finally(() => pending.delete(task));
    });
    const resource = 'browser-refresh-private.txt';
    const payload = 'Private Pod data survives real SDK renewal and reauthentication.';
    const evidence = { initialPrivateRead: false, anonymousDenied: false, pastInitialAccessExpiry: false, recoveredByLogin: false, finalPrivateRead: false };
    try {
      const login = await completeOidcLogin(page, fixture.ready.account, {
        baseUrl: fixture.ready.baseUrl, startUrl: new URL('/ai-connections', fixture.ready.baseUrl).href,
        ready, requireCallbackEvidence: true, timeoutMs: 90_000,
      });
      expect(login.tokenAuthorizationCodeGrantSeen).toBe(true);
      await expect.poll(() => tokens.filter((entry) => entry.grant === 'authorization_code').length).toBe(1);
      const initial = tokens.find((entry) => entry.grant === 'authorization_code')!;
      expect(initial.expiresIn).toBe(fixture.ready.accessTokenTtl);
      expect(initial.refreshIssued).toBe(true);
      expect((await fetchBrowserXpodPod(page, resource, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: payload })).status).toBe(201);
      const acl = `@prefix acl: <http://www.w3.org/ns/auth/acl#>. <#owner> a acl:Authorization; acl:accessTo <${resource}>; acl:agent <${fixture.ready.account.webId}>; acl:mode acl:Read, acl:Write, acl:Control.`;
      expect([200, 201, 205]).toContain((await fetchBrowserXpodPod(page, `${resource}.acl`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: acl })).status);
      expect(await fetchBrowserXpodPod(page, resource)).toEqual({ status: 200, body: payload });
      evidence.initialPrivateRead = true;
      const anonymous = await fetch(new URL(resource, fixture.ready.account.podUrl));
      expect([401, 403]).toContain(anonymous.status);
      await anonymous.arrayBuffer();
      evidence.anonymousDenied = true;

      if (mode === 'renew') {
        await expect.poll(() => tokens.some((entry) => entry.grant === 'refresh_token' && entry.status === 200), { timeout: 45_000 }).toBe(true);
        // Wall-clock wait beyond the original access token's complete lifetime.
        await expect.poll(() => Date.now() > initial.receivedAt + initial.expiresIn! * 1000 + 1000, { timeout: 45_000 }).toBe(true);
        evidence.pastInitialAccessExpiry = true;
        expect((await readBrowserXpodRuntime(page)).status).toBe('authenticated');
        expect(tokens.filter((entry) => entry.grant === 'authorization_code')).toHaveLength(1);
      } else {
        await expect.poll(() => tokens.some((entry) => entry.grant === 'refresh_token' && entry.status >= 400 && entry.error === 'invalid_grant'), { timeout: 45_000 }).toBe(true);
        expect(Date.now() - initial.receivedAt).toBeGreaterThan(fixture.ready.refreshTokenTtl * 1000);
        await expect(page.getByTestId('auth-surface-page').getByText(/^(?:Session expired|登录状态已失效|会话已过期)$/i)).toBeVisible();
        const recovered = await completeOidcLogin(page, fixture.ready.account, {
          baseUrl: fixture.ready.baseUrl, ready, requireCallbackEvidence: true, timeoutMs: 90_000,
        });
        expect(recovered.tokenAuthorizationCodeGrantSeen).toBe(true);
        evidence.recoveredByLogin = true;
        await expect.poll(() => tokens.filter((entry) => entry.grant === 'authorization_code').length).toBe(2);
      }
      expect(await fetchBrowserXpodPod(page, resource)).toEqual({ status: 200, body: payload });
      evidence.finalPrivateRead = true;
    } finally {
      try {
        await Promise.allSettled([...pending]);
        const evidencePath = testInfo.outputPath('token-lifecycle-evidence.json');
        await writeFile(evidencePath, JSON.stringify({ mode, accessTtl: fixture.ready.accessTokenTtl, refreshTtl: fixture.ready.refreshTokenTtl, tokens, evidence }, null, 2));
        await testInfo.attach('token-lifecycle-evidence', { path: evidencePath, contentType: 'application/json' });
      } finally {
        try { await context.close(); } finally { await stop(fixture.child); }
      }
    }
  });
}
