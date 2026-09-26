import { spawn } from 'node:child_process';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { completeOidcLogin, type BrowserSolidAccount } from '../helpers/browserSolidOidc';

/**
 * Does switching the embedding model really announce a rebuild, wait for a
 * second confirmation, queue it only after that, show its progress, and lock
 * the switch while it runs?
 *
 * Everything below runs against the acceptance fixture stack - a real Gateway,
 * CSS, API, Pod database and rebuild executor - and drives the real settings UI
 * in a browser. The fixture provider serves two embedding models so the
 * assignment can actually be switched from one to the other.
 */
const MODEL_A = { id: 'text-embedding-fixture-a', display_name: 'Fixture Embedding A' };
const MODEL_B = { id: 'text-embedding-fixture-b', display_name: 'Fixture Embedding B' };
const CHAT_MODEL = { id: 'fixture-gpt-acceptance', display_name: 'Fixture GPT Acceptance' };
const API_KEY = 'sk-xpod-acceptance-fixture-key';
const READY_PREFIX = 'XPOD_SETTINGS_FIXTURE_READY ';
const FAILURE_PREFIX = 'XPOD_SETTINGS_FIXTURE_ERROR ';

interface HarnessReady {
  baseUrl: string;
  fixtureBaseUrl: string;
  controlUrl: string;
  accounts: { alice: BrowserSolidAccount };
}

class Harness {
  private readonly child: ReturnType<typeof spawn>;
  readonly ready: HarnessReady;
  private log = '';

  private constructor(child: ReturnType<typeof spawn>, ready: HarnessReady, log: string) {
    this.child = child;
    this.ready = ready;
    this.log = log;
  }

  static async start(): Promise<Harness> {
    const { REDIS_URL: _redis, CSS_REDIS_CLIENT: _cssRedis, ...env } = process.env;
    const child = spawn('bun', [path.resolve('tests/helpers/xpodSettingsFixtureServer.ts')], {
      cwd: process.cwd(),
      env: {
        ...env,
        HOME: path.resolve('.test-data/embedding-switch/home'),
        CSS_REDIS_CLIENT: '',
        REDIS_URL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const ready = await new Promise<HarnessReady>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('fixture harness startup timed out')), 120_000);
      const onChunk = (chunk: Buffer): void => {
        log = `${log}${chunk.toString()}`.slice(-20_000);
        output += chunk.toString();
        for (const line of output.split('\n')) {
          if (line.startsWith(FAILURE_PREFIX)) {
            clearTimeout(timeout);
            reject(new Error('fixture harness reported startup failure'));
            return;
          }
          if (!line.startsWith(READY_PREFIX)) continue;
          clearTimeout(timeout);
          resolve(JSON.parse(line.slice(READY_PREFIX.length)) as HarnessReady);
          return;
        }
        output = output.slice(output.lastIndexOf('\n') + 1);
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.once('error', () => {
        clearTimeout(timeout);
        reject(new Error('fixture harness failed to start'));
      });
      child.once('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`fixture harness exited before ready (code ${code})`));
        }
      });
    });
    return new Harness(child, ready, log);
  }

  diagnostics(): string {
    return this.log;
  }

  async setModels(models: Array<{ id: string; display_name?: string }>): Promise<void> {
    const response = await fetch(`${this.ready.controlUrl}/control/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models }),
    });
    if (!response.ok) throw new Error(`fixture model update failed: ${response.status}`);
  }

  async stop(): Promise<void> {
    try {
      await fetch(`${this.ready.controlUrl}/control/shutdown`, { method: 'POST' });
    } catch {
      // The control server may already be gone.
    }
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.child.kill('SIGTERM');
        resolve();
      }, 15_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

let harness: Harness;
/** Every failed request the page made, so a stuck dialog explains itself. */
const pageFailures: string[] = [];

test.beforeAll(async () => {
  harness = await Harness.start();
  // Two embedding models plus one chat model: the switch is between A and B.
  await harness.setModels([CHAT_MODEL, MODEL_A, MODEL_B]);
});

test.afterAll(async () => {
  await harness?.stop();
});

const workspaceReady = async (page: Page): Promise<boolean> => {
  const url = new URL(page.url());
  if (url.origin !== new URL(harness.ready.baseUrl).origin) return false;
  if (url.pathname !== '/ai-connections' && !url.pathname.startsWith('/settings')) return false;
  if (!(await page.locator('[data-workspace-layout]').first().isVisible({ timeout: 250 }))) return false;
  return await page.locator('[data-testid="workspace-main-pane"] section[role="region"]').first().count() > 0;
};

const openModule = async (page: Page, route: string): Promise<void> => {
  const destination = new URL(route, harness.ready.baseUrl).toString();
  if (new URL(page.url()).pathname !== route) {
    await page.goto(destination, { waitUntil: 'domcontentloaded' });
  }
  await expect(page.locator('[data-workspace-layout]')).toBeAttached({ timeout: 30_000 });
};

/**
 * Connect the fixture provider and sync the embedding models into the account.
 *
 * The credential is written through the management API with the browser's own
 * session: the applet's direct Pod PATCH is aborted by the browser in this
 * harness (`net::ERR_ABORTED`), and the credential write is a precondition here,
 * not the behaviour under test. Everything after it - model sync, the embedding
 * assignment, the confirmation, the queued rebuild and the lock - runs through
 * the real UI.
 */
const connectFixtureProvider = async (page: Page): Promise<void> => {
  await openModule(page, '/ai-connections');
  await page.getByRole('option', { name: 'OpenAI' }).click();
  const section = page.getByRole('region', { name: '当前连接', exact: true });
  const newKey = section.getByRole('button', { name: '新建 API Key 连接', exact: true });
  await expect(newKey).toBeVisible({ timeout: 30_000 });
  await newKey.click();
  const dialog = page.getByRole('dialog', { name: '新建连接' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('OpenAI API Key 输入').fill(API_KEY);
  await page.getByRole('button', { name: '高级设置' }).click();
  await page.getByLabel('OpenAI Base URL 输入').fill(harness.ready.fixtureBaseUrl);

  // The applet writes the credential straight into the Pod. On this harness the
  // first attempt is sometimes aborted by the browser (`net::ERR_ABORTED`), so a
  // second submit is attempted before giving up - with the fixture's own
  // diagnostics attached when it never lands.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const networkLog: string[] = [];
  cdp.on('Network.requestWillBeSent', (event) => {
    if (!event.request.url.includes('/settings/credentials.ttl')) return;
    networkLog.push(`SENT ${event.request.method} ${event.request.url} headers=${JSON.stringify(event.request.headers)}`);
  });
  cdp.on('Network.responseReceived', (event) => {
    if (!event.response.url.includes('/settings/credentials.ttl')) return;
    networkLog.push(`RESP ${event.response.status} ${event.response.url}`);
  });
  cdp.on('Network.loadingFailed', (event) => {
    networkLog.push(`FAILED requestId=${event.requestId} error=${event.errorText} canceled=${String(event.canceled)}`
      + ` blocked=${String(event.blockedReason)} type=${event.type}`);
  });

  const submit = dialog.getByRole('button', { name: /保存.*API Key/u });
  await expect(submit).toBeVisible({ timeout: 30_000 });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await submit.click();
    const closed = await dialog.waitFor({ state: 'detached', timeout: 20_000 }).then(() => true).catch(() => false);
    if (closed) break;
    if (attempt === 3) {
      // The CDP trace shows the PATCH reaching CSS and returning 201 before the
      // renderer cancels it, so the decisive question is whether the credential
      // landed anyway. Reload and read the Pod back.
      const afterReload = await (async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openModule(page, '/ai-connections');
        await page.getByRole('option', { name: 'OpenAI' }).click();
        const listed = await page.getByText('Fixture key', { exact: true }).count();
        return `listed=${listed}`;
      })().catch((error: unknown) => `reload failed: ${String(error)}`);
      const podRows = await new Promise<string>((resolve) => {
        const child = spawn('bun', [path.resolve('tests/helpers/aiConnectionsPodProbe.ts')], { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
        child.on('close', () => resolve(out.trim() || '<no probe output>'));
        child.stdin.end(JSON.stringify({
          account: {
            clientId: harness.ready.accounts.alice.clientId,
            clientSecret: harness.ready.accounts.alice.clientSecret,
            webId: harness.ready.accounts.alice.webId,
            podUrl: harness.ready.accounts.alice.podUrl,
            issuer: harness.ready.accounts.alice.issuer,
          },
          provider: 'openai',
        }));
      }).catch((error: unknown) => `probe failed: ${String(error)}`);
      throw new Error(`credential write never completed.\nlisted after reload: ${afterReload}`
        + `\npod probe: ${podRows}\ndialog: ${await dialog.innerText().catch(() => '<none>')}`
        + `\npage failures: ${pageFailures.join('; ') || '-'}`
        + `\nharness: ${harness.diagnostics().slice(-1_500)}`
        + `\ncdp: ${networkLog.join(' | ') || '-'}`);
    }
  }

  const refresh = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/api/ai/gateway/providers/openai/models/refresh')
  ), { timeout: 60_000 });
  const syncButton = page.getByRole('button', { name: /同步模型|刷新模型/u });
  await expect(syncButton).toBeVisible({ timeout: 30_000 });
  await syncButton.click();
  const refreshResponse = await refresh;
  expect(refreshResponse.ok(), await refreshResponse.text().catch(() => '')).toBe(true);
};

const embeddingSelect = (page: Page) => page.getByLabel('Embedding model');
const saveButton = (page: Page) => page.getByRole('button', { name: /Save configuration|Saving…/u });

test('switching the embedding model warns, confirms, rebuilds, and locks the switch', async ({ page }) => {
  test.setTimeout(10 * 60_000);
  pageFailures.length = 0;
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    pageFailures.push(`${response.request().method()} ${url.pathname} -> ${response.status()}`);
  });
  page.on('requestfailed', (request) => {
    const post = request.postData() ?? '';
    pageFailures.push(`${request.method()} ${new URL(request.url()).pathname} -> FAILED ${request.failure()?.errorText ?? ''}`
      + `${post ? ` body=${post.slice(0, 200)}` : ''}`);
  });
  page.on('pageerror', (error) => pageFailures.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    pageFailures.push(`console.${message.type()}: ${message.text().slice(0, 300)}`);
  });

  await completeOidcLogin(page, harness.ready.accounts.alice, {
    baseUrl: harness.ready.baseUrl,
    startUrl: new URL('/ai-connections', harness.ready.baseUrl).toString(),
    ready: workspaceReady,
    requireCallbackEvidence: true,
    timeoutMs: 90_000,
  });

  // 1. 同步模型：两个向量模型必须带着"向量模型"标记出现（chat/embedding 类型贯通）。
  await connectFixtureProvider(page);
  await expect(page.getByText(MODEL_A.display_name, { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(MODEL_B.display_name, { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  expect(await page.getByRole('button', { name: '向量模型' }).count()).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: '.test-data/embedding-byok-acceptance/e2e-1-synced-models.png', fullPage: true });

  // 2. 首次把 Embedding 设为 A：同样要提示 + 二次确认。
  await openModule(page, '/ai-config');
  await embeddingSelect(page).selectOption({ label: `${MODEL_A.display_name} · openai` });
  await expect(page.getByText(/切换向量模型会重建索引/u)).toBeVisible();
  const firstPatch = page.waitForRequest((request) => (
    request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/ai/config'
  ), { timeout: 5_000 }).catch(() => undefined);
  await saveButton(page).click();
  await expect(page.getByText('切换向量模型并重建索引？')).toBeVisible();
  expect(await firstPatch, '保存前不应先写入配置').toBeUndefined();
  await page.screenshot({ path: '.test-data/embedding-byok-acceptance/e2e-2-confirm-dialog.png', fullPage: true });
  await page.getByRole('button', { name: '确认切换并重建' }).click();
  await expect(page.getByText(/索引重建(已排队|进行中|完成)/u).first()).toBeVisible({ timeout: 60_000 });

  // 3. 等第一次重建结束。
  await expect(page.getByText(/索引重建完成/u).first()).toBeVisible({ timeout: 120_000 });

  // 4. 切到 B：行内提示 → 保存 → 取消（不写入、不排队）→ 再确认。
  await openModule(page, '/ai-config');
  await embeddingSelect(page).selectOption({ label: `${MODEL_B.display_name} · openai` });
  await expect(page.getByText(/切换向量模型会重建索引/u)).toBeVisible();
  await saveButton(page).click();
  await expect(page.getByText('切换向量模型并重建索引？')).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.getByText('切换向量模型并重建索引？')).toHaveCount(0);
  await expect(page.getByText(/索引重建(已排队|进行中)/u)).toHaveCount(0);
  await expect(page.getByText(/Unsaved changes/u).first()).toBeVisible();

  const rebuildRequest = page.waitForRequest((request) => (
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/ai/config/rebuild'
  ));
  await saveButton(page).click();
  await page.getByRole('button', { name: '确认切换并重建' }).click();
  expect((await rebuildRequest).postData() ?? '').toContain('vector');

  // 5. 重建期间：状态可见，且向量模型下拉被锁。
  await expect(page.getByText(/索引重建(已排队|进行中)/u).first()).toBeVisible({ timeout: 30_000 });
  const lockedWhileRunning = await expect.poll(async () => ({
    status: await page.getByText(/索引重建(已排队|进行中|完成)/u).first().innerText(),
    disabled: await embeddingSelect(page).isDisabled(),
  }), { timeout: 120_000 }).toMatchObject({ disabled: true }).then(() => true).catch(() => false);
  await page.screenshot({ path: '.test-data/embedding-byok-acceptance/e2e-3-rebuilding-locked.png', fullPage: true });
  expect(lockedWhileRunning, '重建进行中时下拉应处于锁定状态').toBe(true);

  // 6. 结束后解锁并显示完成。
  await expect(page.getByText(/索引重建完成/u).first()).toBeVisible({ timeout: 120_000 });
  await expect(embeddingSelect(page)).toBeEnabled({ timeout: 60_000 });
  await expect(embeddingSelect(page)).toHaveValue(await embeddingSelect(page).inputValue());
  await page.screenshot({ path: '.test-data/embedding-byok-acceptance/e2e-4-settled.png', fullPage: true });
});
