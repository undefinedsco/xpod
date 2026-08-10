import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { completeOidcLogin, type BrowserOidcTrace, type BrowserSolidAccount } from '../helpers/browserSolidOidc';

const screenshotDir = path.resolve('.test-data/acceptance/screenshots');
const fixtureModelId = 'fixture-gpt-acceptance';
const fixtureModelName = 'Fixture GPT Acceptance';
const fakeProviderApiKey = 'sk-xpod-acceptance-fixture-key';
const aliceGatewayKeyName = 'Alice acceptance Gateway';
const fixtureFailurePrefix = 'XPOD_SETTINGS_FIXTURE_ERROR ';

type FixtureHarnessReady = {
  type: 'ready';
  baseUrl: string;
  fixtureBaseUrl: string;
  controlUrl: string;
  accounts: { alice: BrowserSolidAccount; bob: BrowserSolidAccount };
};

type FixtureHarnessStatus = {
  requests: string[];
  modelCount: number;
  authorizedDiscoveries: string[];
};

class FixtureHarness {
  private readonly child: ReturnType<typeof spawn>;
  readonly ready: FixtureHarnessReady;

  private constructor(child: ReturnType<typeof spawn>, ready: FixtureHarnessReady) {
    this.child = child;
    this.ready = ready;
  }

  static async start(): Promise<FixtureHarness> {
    const child = spawn('bun', [path.resolve('tests/helpers/xpodSettingsFixtureServer.ts')], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await new Promise<FixtureHarnessReady>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Xpod fixture harness startup timed out')), 120_000);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        for (const line of output.split('\n')) {
          if (line.startsWith(fixtureFailurePrefix)) {
            clearTimeout(timeout);
            reject(new Error('Xpod fixture harness reported startup failure'));
            return;
          }
          if (!line.startsWith('XPOD_SETTINGS_FIXTURE_READY ')) continue;
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(line.slice('XPOD_SETTINGS_FIXTURE_READY '.length)) as FixtureHarnessReady);
          } catch {
            reject(new Error('Xpod fixture harness returned invalid ready JSON'));
          }
          return;
        }
        output = output.slice(output.lastIndexOf('\n') + 1);
      });
      child.once('error', () => {
        clearTimeout(timeout);
        reject(new Error('Xpod fixture harness process failed to start'));
      });
      child.once('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error('Xpod fixture harness exited before ready'));
        }
      });
    });
    return new FixtureHarness(child, ready);
  }

  async status(): Promise<FixtureHarnessStatus> {
    const response = await fetch(`${this.ready.controlUrl}/control/status`);
    if (!response.ok) throw new Error(`Fixture status failed: ${response.status}`);
    return await response.json() as FixtureHarnessStatus;
  }

  async setModels(models: Array<{ id: string; display_name?: string }>): Promise<void> {
    const response = await fetch(`${this.ready.controlUrl}/control/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models }),
    });
    if (!response.ok) throw new Error(`Fixture model update failed: ${response.status}`);
  }

  async stop(): Promise<void> {
    try {
      await fetch(`${this.ready.controlUrl}/control/shutdown`, { method: 'POST' });
    } catch {
      // Fall through to process termination when the control server is already gone.
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

let fixtureHarness: FixtureHarness;
let alice: BrowserSolidAccount;
let bob: BrowserSolidAccount;

test.describe.configure({ mode: 'serial' });

test.describe('Xpod settings product acceptance', () => {
  test.beforeAll(async () => {
    await mkdir(screenshotDir, { recursive: true });
    fixtureHarness = await FixtureHarness.start();
    alice = fixtureHarness.ready.accounts.alice;
    bob = fixtureHarness.ready.accounts.bob;
  });

  test.afterAll(async () => {
    await fixtureHarness?.stop();
  });

  test('saves Alice provider state through real OIDC, restores the secret, retains stale models, and isolates Bob', async ({ browser }) => {
    test.setTimeout(240_000);
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const alicePage = await aliceContext.newPage();
    const bobPage = await bobContext.newPage();

    try {
      const aliceTrace = await loginToSettings(alicePage, alice);
      assertRealOidcTrace(aliceTrace);
      await openModule(alicePage, '/settings/models', 'Models');
      await expect(alicePage.getByRole('option', { name: 'OpenAI' })).toBeVisible();

      const unauthenticatedDiscovery = await fetch(`${fixtureHarness.ready.fixtureBaseUrl}/models`);
      expect(unauthenticatedDiscovery.status).toBe(401);

      await completeApiKeyThroughUi(alicePage);
      await expect(alicePage.getByText(fixtureModelName, { exact: true }).first()).toBeVisible({ timeout: 45_000 });
      await expect.poll(async () => (await fixtureHarness.status()).requests).toContain('GET /v1/models');
      await expect.poll(async () => (await fixtureHarness.status()).authorizedDiscoveries).toContain('primary');

      const credential = await assertReversiblePodCredential(alice, fakeProviderApiKey);
      await completeApiKeyThroughUi(
        alicePage,
        'Alice fixture sibling',
        'sk-xpod-acceptance-fixture-sibling',
      );
      await expect.poll(async () => (await fixtureHarness.status()).authorizedDiscoveries).toContain('sibling');
      await expect.poll(
        async () => (await runAiConnectionsPodProbe(alice, { provider: 'openai' })).providerCredentialCount,
        { timeout: 45_000 },
      ).toBe(2);
      await alicePage.getByRole('button', { name: '停用 Alice fixture sibling' }).click();
      await expect(alicePage.getByRole('button', { name: '启用 Alice fixture sibling' })).toBeVisible();
      await alicePage.getByRole('button', { name: '启用 Alice fixture sibling' }).click();
      await expect(alicePage.getByRole('button', { name: '停用 Alice fixture sibling' })).toBeVisible();
      await alicePage.getByRole('button', { name: '删除 Alice fixture sibling' }).click();
      await expect(alicePage.getByText('Alice fixture sibling', { exact: true })).toHaveCount(0);
      await expect(alicePage.getByText('Alice fixture key', { exact: true })).toBeVisible();
      await expect.poll(
        async () => (await runAiConnectionsPodProbe(alice, {
          provider: 'openai',
          credentialLabel: 'Alice fixture key',
        })).providerCredentialCount,
        { timeout: 45_000 },
      ).toBe(1);
      await chooseFixtureModel(alicePage);
      await expect.poll(
        async () => (await runAiConnectionsPodProbe(alice, { provider: 'openai' })).selectedModelCount,
        { timeout: 45_000 },
      ).toBe(1);
      await alicePage.reload({ waitUntil: 'networkidle' });
      await openModule(alicePage, '/settings/models', 'Models');
      await alicePage.getByRole('option', { name: 'OpenAI' }).click();
      await expect(alicePage.getByText(fixtureModelName, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
      await expect(alicePage.getByRole('checkbox', { name: `取消选择 ${fixtureModelName}` }).first()).toHaveAttribute('aria-checked', 'true');

      const aliceGatewayKey = await createAliceGatewayKeyThroughUi(alicePage);
      await assertAliceGatewayModelAccess(alicePage, aliceGatewayKey);

      await fixtureHarness.setModels([]);
      await alicePage.getByRole('button', { name: '刷新模型' }).click();
      await expect.poll(
        async () => (await runAiConnectionsPodProbe(alice, { provider: 'openai' })).selectedUnavailableCount,
        { timeout: 45_000 },
      ).toBe(1);
      await expect(alicePage.getByText('已失效', { exact: true })).toBeVisible({ timeout: 45_000 });
      await expect(alicePage.getByText(fixtureModelName, { exact: true }).first()).toBeVisible();
      await expect(alicePage.getByRole('checkbox', { name: `取消选择 ${fixtureModelName}` }).first()).toHaveAttribute('aria-checked', 'true');

      const bobTrace = await loginToSettings(bobPage, bob);
      assertRealOidcTrace(bobTrace);
      await openModule(bobPage, '/settings/models', 'Models');
      await expect(bobPage.locator('body')).not.toContainText('Alice fixture key');
      await expect(bobPage.locator('body')).not.toContainText(aliceGatewayKeyName);
      await expect(bobPage.locator('[data-credential-state]')).toHaveCount(0);
      await expect(bobPage.getByText(fixtureModelName, { exact: true })).toHaveCount(0);

      await openClientCredentialsSection(bobPage);
      await expect(bobPage.locator('body')).not.toContainText(aliceGatewayKeyName);

      const bobPod = await runAiConnectionsPodProbe(bob, { provider: 'openai' });
      expect(bobPod.providerCredentialCount).toBe(0);
      expect(bobPod.selectedModelCount).toBe(0);

      await revokeAliceGatewayKeyThroughUi(alicePage);
      const revokedGatewayResponse = await alicePage.request.get(
        new URL('/v1/models', fixtureHarness.ready.baseUrl).toString(),
        { headers: { authorization: `Bearer ${aliceGatewayKey}` } },
      );
      expect(revokedGatewayResponse.status()).toBe(401);

      // Keep a reference in the test body so the Pod proof cannot accidentally
      // become a UI-only assertion during future acceptance refactors.
      expect(credential.id).toBeTruthy();
    } finally {
      await deleteAliceFixtureCredentialThroughUi(alicePage).catch(() => undefined);
      await revokeAliceGatewayKeyThroughUi(alicePage).catch(() => undefined);
      await aliceContext.close();
      await bobContext.close();
    }
  });

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    test(`keeps Models, Pod, Network and Services usable at ${viewport.name} width`, async ({ browser }) => {
      test.setTimeout(240_000);
      const page = await browser.newPage();
      try {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const trace = await loginToSettings(page, alice);
        assertRealOidcTrace(trace);

        for (const module of [
          { label: 'Models', path: '/settings/models', expected: /OpenAI|Anthropic|Kimi|Bailian|DeepSeek|模型/i },
          { label: 'Pod', path: '/settings/pod', expected: /WebID|Pod|Issuer|Storage|AI Connection/i },
          { label: 'Network', path: '/settings/network', expected: /Network|endpoint|unsupported|supported|连接/i },
          { label: 'Services', path: '/settings/services', expected: /Services|runtime|solid|gateway|storage|RDF/i },
        ]) {
          await openModule(page, module.path, module.label);
          await expect(page.locator('main')).toHaveCount(1);
          await expect(page.locator('body')).toContainText(module.expected);
          await assertSdkGeometryContract(page, module.label, viewport.name === 'desktop');
          await page.screenshot({
            path: path.join(screenshotDir, `${viewport.name}-${module.label.toLowerCase()}.png`),
            fullPage: true,
          });
        }
      } finally {
        await page.context().close();
      }
    });
  }

  test('keeps narrow Models stack detail, focus, and back navigation accessible', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      const trace = await loginToSettings(page, alice);
      assertRealOidcTrace(trace);
      await openModule(page, '/settings/models', 'Models');

      const search = page.locator('[data-workspace-list-header="true"] input[aria-label="搜索 Provider"]');
      await expect(search).toBeVisible();
      await search.focus();
      await expect(search).toBeFocused();

      const detailTrigger = page.locator('[data-testid="workspace-list-pane"] [role="option"]').first();
      await expect(detailTrigger).toBeVisible();
      await detailTrigger.focus();
      await expect(detailTrigger).toBeFocused();
      await detailTrigger.press('Enter');
      await expect(page.locator('[data-testid="workspace-list-pane"]')).toBeHidden();
      await expect(page.locator('[data-testid="workspace-main-pane"]')).toBeVisible();
      await expect(page.locator('[data-testid="workspace-main-pane"]')).toBeFocused();
      const modelHeaderGeometry = await page.evaluate(() => {
        const header = document.querySelector('[data-testid="provider-models-header"]');
        const heading = header?.querySelector('h3');
        const actions = document.querySelector('[data-testid="provider-models-actions"]');
        const search = actions?.querySelector('input[placeholder="搜索模型..."]');
        const rect = (element: Element | null | undefined) => {
          const box = element?.getBoundingClientRect();
          return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
        };
        return {
          heading: rect(heading),
          actions: rect(actions),
          search: rect(search),
        };
      });
      expect(modelHeaderGeometry.heading?.width).toBeGreaterThan(50);
      expect(modelHeaderGeometry.heading?.height).toBeLessThanOrEqual(24);
      expect(modelHeaderGeometry.actions?.y).toBeGreaterThan(
        (modelHeaderGeometry.heading?.y ?? 0) + (modelHeaderGeometry.heading?.height ?? 0),
      );
      expect(modelHeaderGeometry.search?.width).toBeGreaterThan(200);
      await page.screenshot({ path: path.join(screenshotDir, 'mobile-models-detail.png'), fullPage: true });

      await page.getByRole('button', { name: '返回列表' }).click();
      await expect(page.locator('[data-testid="workspace-list-pane"]')).toBeVisible();
      await expect(page.locator('[data-testid="workspace-main-pane"]')).toBeHidden();
      await expect(search).toBeVisible();
      await expect(page.locator('[data-testid="workspace-list-pane"]')).toBeFocused();
    } finally {
      await page.context().close();
    }
  });
});

async function loginToSettings(page: Page, account: BrowserSolidAccount): Promise<BrowserOidcTrace> {
  return await completeOidcLogin(page, account, {
    baseUrl: fixtureHarness.ready.baseUrl,
    startUrl: new URL('/settings/models', fixtureHarness.ready.baseUrl).toString(),
    timeoutMs: 90_000,
  });
}

async function openModule(page: Page, route: string, label: string): Promise<void> {
  await page.goto(new URL(route, fixtureHarness.ready.baseUrl).toString(), { waitUntil: 'networkidle' });
  await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible({ timeout: 30_000 });
}

async function completeApiKeyThroughUi(
  page: Page,
  label = 'Alice fixture key',
  apiKey = fakeProviderApiKey,
): Promise<void> {
  await page.getByRole('option', { name: 'OpenAI' }).click();
  await page.getByRole('button', { name: '添加 API Key' }).first().click();
  await page.getByLabel('OpenAI API Key 标签').fill(label);
  await page.getByLabel('OpenAI API Key 输入').fill(apiKey);
  await page.getByLabel('OpenAI Base URL 输入').fill(fixtureHarness.ready.fixtureBaseUrl);
  await page.getByRole('button', { name: '保存 OpenAI API Key' }).click();
  await expect(page.locator('body')).not.toContainText(apiKey);
  await expect(page.getByText(label, { exact: true })).toBeVisible({ timeout: 30_000 });
}

async function chooseFixtureModel(page: Page): Promise<void> {
  const checkbox = page.getByRole('checkbox', { name: `选择 ${fixtureModelName}` }).first();
  await expect(checkbox).toBeVisible({ timeout: 30_000 });
  await checkbox.click();
  await expect(page.getByRole('checkbox', { name: `取消选择 ${fixtureModelName}` }).first()).toHaveAttribute('aria-checked', 'true');
}

async function createAliceGatewayKeyThroughUi(page: Page): Promise<string> {
  await openClientCredentialsSection(page);
  await page.getByLabel('客户端凭证名称').fill(aliceGatewayKeyName);
  await page.getByRole('button', { name: '创建客户端凭证' }).click();
  await expect(page.getByText(aliceGatewayKeyName, { exact: true })).toBeVisible({ timeout: 30_000 });
  const oneTimeKeyNotice = page.getByText('请立即保存；关闭后无法再次查看。', { exact: true }).locator('..');
  const plaintext = await oneTimeKeyNotice.locator('code').textContent();
  if (!plaintext?.trim()) throw new Error('Gateway key was not rendered');
  await page.getByRole('button', { name: '我已保存，隐藏密钥' }).click();
  return plaintext.trim();
}

async function assertAliceGatewayModelAccess(page: Page, gatewayKey: string): Promise<void> {
  const response = await page.request.get(
    new URL('/v1/models', fixtureHarness.ready.baseUrl).toString(),
    { headers: { authorization: `Bearer ${gatewayKey}` } },
  );
  expect(response.status()).toBe(200);
  const payload = await response.json() as { data?: Array<{ id?: unknown }> };
  expect(payload.data?.map((model) => model.id)).toEqual([fixtureModelId]);
}

async function openClientCredentialsSection(page: Page): Promise<void> {
  const clientAccess = page.getByText('客户端接入', { exact: true }).first();
  if (await clientAccess.evaluate((element) => (element.parentElement as HTMLDetailsElement | null)?.open).catch(() => false)) {
    // Already expanded.
  } else {
    await clientAccess.click();
  }
  const advanced = page.getByText('高级：客户端凭证管理', { exact: true });
  if (await advanced.evaluate((element) => (element.parentElement as HTMLDetailsElement | null)?.open).catch(() => false)) {
    return;
  }
  await advanced.click();
}

async function deleteAliceFixtureCredentialThroughUi(page: Page): Promise<void> {
  await openModule(page, '/settings/models', 'Models');
  await page.getByRole('option', { name: 'OpenAI' }).click();
  const remove = page.getByRole('button', { name: '删除 Alice fixture key' });
  if (await remove.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await remove.click();
    await expect(page.getByText('Alice fixture key', { exact: true })).toHaveCount(0);
  }
}

async function revokeAliceGatewayKeyThroughUi(page: Page): Promise<void> {
  await openClientCredentialsSection(page);
  const revoke = page.getByRole('button', { name: `撤销 ${aliceGatewayKeyName}` });
  if (await revoke.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await revoke.click();
  }
}

async function assertReversiblePodCredential(account: BrowserSolidAccount, plaintext: string): Promise<{ id: string }> {
  const result = await runAiConnectionsPodProbe(account, {
    provider: 'openai',
    credentialLabel: 'Alice fixture key',
    expectedSecret: plaintext,
  });
  expect(result.credentialId).toBeTruthy();
  expect(result.algorithm).toBe('PLAINTEXT');
  expect(result.encoding).toBe('base64');
  expect(result.readSecretMatches).toBe(true);
  expect(result.rawContainsPlaintext).toBe(false);
  expect(result.rawContainsEnvelope).toBe(true);
  expect(result.providerCredentialCount).toBeGreaterThan(0);
  return { id: result.credentialId! };
}

type AiConnectionsPodProbeResult = {
  ok: true;
  provider: string;
  credentialId?: string;
  algorithm?: string;
  encoding?: string;
  readSecretMatches: boolean;
  rawContainsPlaintext: boolean;
  rawContainsEnvelope: boolean;
  providerCredentialCount: number;
  modelCount: number;
  selectedModelCount: number;
  unavailableModelCount: number;
  selectedUnavailableCount: number;
};

async function runAiConnectionsPodProbe(
  account: BrowserSolidAccount,
  options: { provider: string; credentialLabel?: string; expectedSecret?: string },
): Promise<AiConnectionsPodProbeResult> {
  const probePath = path.resolve('tests/helpers/aiConnectionsPodProbe.ts');
  const child = spawn('bun', [probePath], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stdin.end(JSON.stringify({
    account: {
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      webId: account.webId,
      podUrl: account.podUrl,
      issuer: account.issuer,
    },
    ...options,
  }));
  const [exitCode] = await new Promise<[number | null]>((resolve) => {
    child.once('close', (code) => resolve([code]));
    child.once('error', () => resolve([1]));
  });
  let result: unknown;
  try {
    const jsonLine = stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith('{') && line.endsWith('}'));
    if (!jsonLine) throw new Error('missing JSON');
    result = JSON.parse(jsonLine);
  } catch {
    throw new Error('Hermetic Pod probe returned invalid JSON');
  }
  if (exitCode !== 0) {
    const message = typeof (result as { message?: unknown }).message === 'string'
      ? (result as { message: string }).message
      : 'unknown probe failure';
    const stackTop = typeof (result as { stackTop?: unknown }).stackTop === 'string'
      ? `\n${(result as { stackTop: string }).stackTop}`
      : '';
    throw new Error(`Hermetic Pod probe failed: ${message}${stackTop}`);
  }
  if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true) {
    throw new Error('Hermetic Pod probe did not complete');
  }
  return result as AiConnectionsPodProbeResult;
}

function assertRealOidcTrace(trace: BrowserOidcTrace): void {
  expect(trace.authorizationRequestSeen).toBe(true);
  expect(trace.authCodeChallengeSeen).toBe(true);
  expect(trace.authCodeChallengeMethodS256).toBe(true);
  expect(trace.redirectCodeSeen).toBe(true);
  expect(trace.tokenAuthorizationCodeGrantSeen).toBe(true);
  expect(trace.tokenCodeVerifierSeen).toBe(true);
}

async function assertSdkGeometryContract(page: Page, label: string, requireSplitHeaders: boolean): Promise<void> {
  const metrics = await page.evaluate(() => {
    const root = document.documentElement;
    const rect = (element: Element | null) => {
      const box = element?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    };
    const listHeader = document.querySelector('[data-workspace-list-header="true"]');
    const mainHeader = document.querySelector('[data-workspace-main-header="true"]');
    const main = document.querySelector('main');
    const nav = document.querySelector('nav, aside');
    return {
      overflow: root.scrollWidth - root.clientWidth,
      listHeader: rect(listHeader),
      mainHeader: rect(mainHeader),
      main: rect(main),
      nav: rect(nav),
      search: rect(document.querySelector('[data-workspace-list-header="true"] input[aria-label="搜索 Provider"]')),
      tokens: {
        radius: getComputedStyle(root).getPropertyValue('--radius').trim(),
        background: getComputedStyle(root).getPropertyValue('--background').trim(),
        foreground: getComputedStyle(root).getPropertyValue('--foreground').trim(),
        border: getComputedStyle(root).getPropertyValue('--border').trim(),
      },
    };
  });

  expect(metrics.overflow).toBeLessThanOrEqual(1);
  expect(metrics.main).toBeTruthy();
  expect(metrics.nav).toBeTruthy();
  expect(metrics.tokens.radius).not.toBe('');
  expect(metrics.tokens.background).not.toBe('');
  expect(metrics.tokens.foreground).not.toBe('');
  expect(metrics.tokens.border).not.toBe('');
  if (label === 'Models') {
    expect(metrics.search).toBeTruthy();
  }
  if (requireSplitHeaders && metrics.listHeader && metrics.mainHeader) {
    expect(Math.abs(metrics.listHeader.y - metrics.mainHeader.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.listHeader.height - metrics.mainHeader.height)).toBeLessThanOrEqual(1);
  }
}
