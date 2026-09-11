import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page, type Request, test } from '@playwright/test';
import { completeOidcLogin, type BrowserOidcTrace, type BrowserSolidAccount } from '../helpers/browserSolidOidc';

const screenshotDir = path.resolve('.test-data/acceptance/screenshots');
const fixtureModelId = 'fixture-gpt-acceptance';
const fixtureModelName = 'Fixture GPT Acceptance';
const fakeProviderApiKey = 'sk-xpod-acceptance-fixture-key';
const fakeSiblingApiKey = 'sk-xpod-acceptance-fixture-sibling';
const primaryCredentialLabel = maskedCredentialLabel(fakeProviderApiKey);
const siblingCredentialLabel = maskedCredentialLabel(fakeSiblingApiKey);
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
  private readonly readDiagnostics: () => string;
  readonly ready: FixtureHarnessReady;

  private constructor(child: ReturnType<typeof spawn>, ready: FixtureHarnessReady, readDiagnostics: () => string) {
    this.child = child;
    this.ready = ready;
    this.readDiagnostics = readDiagnostics;
  }

  static async start(): Promise<FixtureHarness> {
    const {
      REDIS_URL: _redisUrl,
      CSS_REDIS_CLIENT: _cssRedisClient,
      ...fixtureEnv
    } = process.env;
    const child = spawn('bun', [path.resolve('tests/helpers/xpodSettingsFixtureServer.ts')], {
      cwd: process.cwd(),
      env: {
        ...fixtureEnv,
        HOME: path.resolve('.test-data/xpod-settings/home'),
        CSS_REDIS_CLIENT: '',
        REDIS_URL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    child.stdout.on('data', (chunk: Buffer) => {
      diagnostics = `${diagnostics}${chunk.toString()}`.slice(-50_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostics = `${diagnostics}${chunk.toString()}`.slice(-50_000);
    });
    const ready = await new Promise<FixtureHarnessReady>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error(
        `Xpod fixture harness startup timed out\n${sanitizedFixtureDiagnostics(diagnostics)}`,
      )), 120_000);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        for (const line of output.split('\n')) {
          if (line.startsWith(fixtureFailurePrefix)) {
            clearTimeout(timeout);
            reject(new Error(
              `Xpod fixture harness reported startup failure\n${sanitizedFixtureDiagnostics(diagnostics)}`,
            ));
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
        reject(new Error(
          `Xpod fixture harness process failed to start\n${sanitizedFixtureDiagnostics(diagnostics)}`,
        ));
      });
      child.once('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(
            `Xpod fixture harness exited before ready\n${sanitizedFixtureDiagnostics(diagnostics)}`,
          ));
        }
      });
    });
    return new FixtureHarness(child, ready, () => sanitizedFixtureDiagnostics(diagnostics));
  }

  diagnostics(): string {
    return this.readDiagnostics();
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
    test.setTimeout(150_000);
    await mkdir(screenshotDir, { recursive: true });
    fixtureHarness = await FixtureHarness.start();
    alice = fixtureHarness.ready.accounts.alice;
    bob = fixtureHarness.ready.accounts.bob;
  });

  test.afterAll(async () => {
    await fixtureHarness?.stop();
  });

  test('creates only, copies an existing client credential after reload, and authorizes the Gateway', async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    let plaintext = '';
    let workflowFailed = false;

    try {
      const trace = await loginToSettings(page, alice);
      assertRealOidcTrace(trace);
      plaintext = await createAliceGatewayKeyThroughUi(page);
      await expect(page.getByRole('button', { name: `停用 ${aliceGatewayKeyName}` })).toHaveCount(0);
      const models = await page.request.get(
        new URL('/v1/models', fixtureHarness.ready.baseUrl).toString(),
        { headers: { authorization: `Bearer ${plaintext}` }, timeout: 30_000 },
      );
      expect(models.status()).toBe(200);
      expect((await models.json()).data).toEqual([]);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await openApiKeysSection(page);
      await expect(page.getByText(aliceGatewayKeyName, { exact: true })).toBeVisible({ timeout: 30_000 });
      await openGatewayClientMenu(page);
      const revealResponsePromise = page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && /^\/api\/ai\/gateway\/keys\/[^/]+\/reveal$/u.test(new URL(response.url()).pathname)
      ));
      await page.getByRole('button', { name: `复制 ${aliceGatewayKeyName} 的 Codex 配置` }).click();
      const revealResponse = await revealResponsePromise;
      expect(revealResponse.status()).toBe(200);
      const revealPayload = await revealResponse.json() as { key?: unknown };
      expect(revealPayload.key === plaintext).toBe(true);
      const keyRow = page.locator('[data-key-state]').filter({ has: page.getByText(aliceGatewayKeyName, { exact: true }) });
      await expect(keyRow.getByRole('status').filter({ hasText: '已复制' })).toHaveText('已复制');
      await page.screenshot({ path: path.join(screenshotDir, 'api-key-copy-menu.png'), fullPage: true, animations: 'disabled' });
      await expect(page.getByText('配置已复制。', { exact: true })).toHaveCount(0);
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied.includes(plaintext)).toBe(true);
      expect(copied).toContain('wire_api = "responses"');
      expect(copied).toContain(new URL('/v1', fixtureHarness.ready.baseUrl).toString());
      await expect(page.locator('body')).not.toContainText(plaintext);
      await expect(keyRow.getByText('已复制', { exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await applyAndWithdrawAliceGatewayKeyThroughUi(page, plaintext);
    } catch (error) {
      workflowFailed = true;
      await page.screenshot({ path: path.join(screenshotDir, 'api-key-layout-failure.png'), fullPage: true }).catch(() => undefined);
      throw error;
    } finally {
      await settleWithin(deleteAliceGatewayKeyThroughUi(page), 5_000);
      if (plaintext) {
        const revoked = await page.request.get(
          new URL('/v1/models', fixtureHarness.ready.baseUrl).toString(),
          { headers: { authorization: `Bearer ${plaintext}` } },
        ).catch(() => undefined);
        if (revoked && !workflowFailed) expect(revoked.status()).toBe(401);
      }
      await context.close().catch(() => undefined);
    }
  });

  test('saves Alice provider state through real OIDC, restores the secret, retains stale models, and isolates Bob', async ({ browser }) => {
    test.setTimeout(360_000);
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const alicePage = await aliceContext.newPage();
    const bobPage = await bobContext.newPage();
    const flowDiagnostics: string[] = [];
    alicePage.on('response', async (response) => {
      if (response.status() < 400) return;
      flowDiagnostics.push(redactFixtureSecrets(`${response.status()} ${new URL(response.url()).pathname} ${await response.text().catch(() => '')}`));
    });
    alicePage.on('pageerror', (error) => flowDiagnostics.push(redactFixtureSecrets(error.message)));

    try {
      const aliceTrace = await loginToSettings(alicePage, alice);
      assertRealOidcTrace(aliceTrace);
      await openModule(alicePage, '/ai-connections', 'AI Connections');
      await expect(alicePage.getByRole('option', { name: 'OpenAI' })).toBeVisible();

      const unauthenticatedDiscovery = await fetch(`${fixtureHarness.ready.fixtureBaseUrl}/models`);
      expect(unauthenticatedDiscovery.status).toBe(401);

      await completeApiKeyThroughUi(alicePage);
      await expect(alicePage.getByText(fixtureModelName, { exact: true }).first()).toBeVisible({ timeout: 45_000 });
      await expect.poll(async () => (await fixtureHarness.status()).requests).toContain('GET /v1/models');
      await expect.poll(async () => (await fixtureHarness.status()).authorizedDiscoveries).toContain('primary');

      const credential = await assertReversiblePodCredential(alice, fakeProviderApiKey);
      await completeApiKeyThroughUi(alicePage, fakeSiblingApiKey);
      await expect.poll(async () => (await fixtureHarness.status()).authorizedDiscoveries).toContain('sibling');
      await expect.poll(
        async () => (await runAiConnectionsPodProbe(alice, { provider: 'openai' })).providerCredentialCount,
        { timeout: 45_000 },
      ).toBe(2);
      const firstHandle = alicePage.getByRole('button', { name: `拖动排序 ${primaryCredentialLabel}` });
      const secondHandle = alicePage.getByRole('button', { name: `拖动排序 ${siblingCredentialLabel}` });
      await expect(secondHandle).toBeEnabled({ timeout: 30_000 });
      const from = await secondHandle.boundingBox();
      const to = await firstHandle.boundingBox();
      expect(from).not.toBeNull();
      expect(to).not.toBeNull();
      await alicePage.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
      await alicePage.mouse.down();
      await alicePage.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 8 });
      await alicePage.mouse.up();
      await expect(alicePage.locator('[data-sortable-credential]').first()).toContainText(siblingCredentialLabel, { timeout: 30_000 });
      await expect(secondHandle).toBeEnabled({ timeout: 30_000 });
      await alicePage.reload({ waitUntil: 'domcontentloaded' });
      await openModule(alicePage, '/ai-connections', 'AI Connections');
      await alicePage.getByRole('option', { name: 'OpenAI' }).click();
      await expect(alicePage.locator('[data-sortable-credential]').first()).toContainText(siblingCredentialLabel, { timeout: 30_000 });
      await alicePage.screenshot({ path: path.join(screenshotDir, 'provider-drag-persisted.png'), fullPage: true });
      await alicePage.getByRole('button', { name: `停用 ${siblingCredentialLabel}` }).click();
      await expect(alicePage.getByRole('button', { name: `启用 ${siblingCredentialLabel}` })).toBeVisible({ timeout: 30_000 });
      await alicePage.getByRole('button', { name: `启用 ${siblingCredentialLabel}` }).click();
      await expect(alicePage.getByRole('button', { name: `停用 ${siblingCredentialLabel}` })).toBeVisible();
      await alicePage.getByRole('button', { name: `删除 ${siblingCredentialLabel}` }).click();
      await expect(alicePage.getByText(siblingCredentialLabel, { exact: true })).toHaveCount(0);
      await expect(alicePage.getByText(primaryCredentialLabel, { exact: true })).toBeVisible();
      await expect.poll(
        async () => (await runAiConnectionsPodProbe(alice, { provider: 'openai' })).providerCredentialCount,
        { timeout: 45_000 },
      ).toBe(1);
      await chooseFixtureModel(alicePage);
      await expect.poll(
        async () => (await runAiConnectionsPodProbe(alice, { provider: 'openai' })).selectedModelCount,
        { timeout: 45_000 },
      ).toBe(1);
      await alicePage.reload({ waitUntil: 'domcontentloaded' });
      await openModule(alicePage, '/ai-connections', 'AI Connections');
      await alicePage.getByRole('option', { name: 'OpenAI' }).click();
      await expect(alicePage.getByText(fixtureModelName, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
      await expect(alicePage.getByRole('checkbox', { name: `取消选择 ${fixtureModelName}` }).first()).toHaveAttribute('aria-checked', 'true');

      const aliceGatewayKey = await createAliceGatewayKeyThroughUi(alicePage);
      await assertAliceGatewayModelAccess(alicePage, aliceGatewayKey);
      await assertAliceGatewayChatAccess(alicePage, aliceGatewayKey);
      await applyAndWithdrawAliceGatewayKeyThroughUi(alicePage, aliceGatewayKey);

      await fixtureHarness.setModels([]);
      await openModule(alicePage, '/ai-connections', 'AI Connections');
      await alicePage.getByRole('option', { name: 'OpenAI' }).click();
      await alicePage.getByRole('button', { name: /同步模型|刷新模型/u }).click();
      await expect.poll(
        async () => (await runAiConnectionsPodProbe(alice, { provider: 'openai' })).selectedUnavailableCount,
        { timeout: 45_000 },
      ).toBe(1);
      await expect(alicePage.getByText('已失效', { exact: true })).toBeVisible({ timeout: 45_000 });
      await expect(alicePage.getByText(fixtureModelName, { exact: true }).first()).toBeVisible();
      await expect(alicePage.getByRole('checkbox', { name: `取消选择 ${fixtureModelName}` }).first()).toHaveAttribute('aria-checked', 'true');

      const bobTrace = await loginToSettings(bobPage, bob);
      assertRealOidcTrace(bobTrace);
      await openModule(bobPage, '/ai-connections', 'AI Connections');
      await expect(bobPage.locator('body')).not.toContainText(primaryCredentialLabel);
      await expect(bobPage.locator('body')).not.toContainText(aliceGatewayKeyName);
      await expect(bobPage.locator('[data-credential-state]')).toHaveCount(0);
      await expect(bobPage.getByText(fixtureModelName, { exact: true })).toHaveCount(0);

      await openApiKeysSection(bobPage);
      await expect(bobPage.locator('body')).not.toContainText(aliceGatewayKeyName);

      const bobPod = await runAiConnectionsPodProbe(bob, { provider: 'openai' });
      expect(bobPod.providerCredentialCount).toBe(0);
      expect(bobPod.selectedModelCount).toBe(0);

      await deleteAliceGatewayKeyThroughUi(alicePage);
      const revokedGatewayResponse = await alicePage.request.get(
        new URL('/v1/models', fixtureHarness.ready.baseUrl).toString(),
        { headers: { authorization: `Bearer ${aliceGatewayKey}` } },
      );
      expect(revokedGatewayResponse.status()).toBe(401);

      // Keep a reference in the test body so the Pod proof cannot accidentally
      // become a UI-only assertion during future acceptance refactors.
      expect(credential.id).toBeTruthy();
    } catch (error) {
      await alicePage.screenshot({ path: path.join(screenshotDir, 'provider-flow-failure.png'), fullPage: true });
      throw new Error(`${String(error)}\n${redactFixtureSecrets(await alicePage.locator('body').innerText())}\n${flowDiagnostics.slice(-15).join('\n')}`);
    } finally {
      await settleWithin(deleteAliceFixtureCredentialThroughUi(alicePage), 5_000);
      await settleWithin(deleteAliceGatewayKeyThroughUi(alicePage), 5_000);
      await aliceContext.close();
      await bobContext.close();
    }
  });

  test('routes a real custom OpenAI-compatible Provider through the Pod and Gateway', async ({ browser }) => {
    const apiKey = process.env.XPOD_REAL_CUSTOM_API_KEY;
    const baseUrl = process.env.XPOD_REAL_CUSTOM_BASE_URL;
    const modelId = process.env.XPOD_REAL_CUSTOM_MODEL_ID ?? 'gpt-5.6-terra';
    const providerName = process.env.XPOD_REAL_CUSTOM_PROVIDER_NAME ?? 'timicc';
    test.skip(!apiKey || !baseUrl, 'Requires an explicitly supplied real custom Provider credential');
    test.setTimeout(240_000);
    const page = await browser.newPage();
    let customApiKeyInput = page.getByRole('textbox', { name: 'API Key' });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      const trace = await loginToSettings(page, alice);
      assertRealOidcTrace(trace);
      await openModule(page, '/ai-connections', 'AI Connections');

      await page.getByRole('button', { name: '添加 AI Connection' }).click();
      await page.getByLabel('Provider 名称').fill(providerName);
      await page.getByLabel('兼容协议').selectOption('auto');
      await page.getByLabel('Base URL').fill(baseUrl!);
      customApiKeyInput = page.getByRole('dialog', { name: '添加自定义 Provider' }).getByRole('textbox', { name: 'API Key' });
      await customApiKeyInput.fill(apiKey!);
      await page.getByRole('button', { name: '保存自定义 Provider' }).dispatchEvent('click');
      await expect(page.getByRole('dialog', { name: '添加自定义 Provider' })).toBeHidden({ timeout: 30_000 });
      await expect(page.locator('body')).not.toContainText(apiKey!);
      await expect(page.getByRole('option', { name: providerName })).toBeVisible({ timeout: 30_000 });

      await page.getByRole('button', { name: /同步模型|刷新模型/u }).click();
      await expect(page.getByText(modelId, { exact: true }).first()).toBeVisible({ timeout: 45_000 });
      const checkbox = page.getByRole('checkbox', { name: `选择 ${modelId}` }).first();
      await checkbox.click();
      await expect(page.getByRole('checkbox', { name: `取消选择 ${modelId}` }).first()).toHaveAttribute('aria-checked', 'true');
      const podState = await runAiConnectionsPodProbe(alice, {
        provider: 'custom',
        expectedSecret: apiKey,
      });
      expect(podState.providerCredentialCount).toBeGreaterThan(0);
      expect(podState.readSecretMatches).toBe(true);

      const gatewayKey = await createAliceGatewayKeyThroughUi(page);
      const modelsResponse = await page.request.get(
        new URL('/v1/models', fixtureHarness.ready.baseUrl).toString(),
        { headers: { authorization: `Bearer ${gatewayKey}` } },
      );
      const modelsText = await modelsResponse.text();
      expect(modelsResponse.status(), modelsText).toBe(200);
      const modelsPayload = JSON.parse(modelsText) as { data?: Array<{ id?: unknown }> };
      expect(modelsPayload.data?.map((model) => model.id)).toContain(modelId);

      const chatResponse = await page.request.post(
        new URL('/v1/chat/completions', fixtureHarness.ready.baseUrl).toString(),
        {
          headers: { authorization: `Bearer ${gatewayKey}` },
          data: {
            model: modelId,
            messages: [{ role: 'user', content: 'Reply only: XPOD_OK' }],
            max_tokens: 16,
          },
        },
      );
      expect(chatResponse.status()).toBe(200);
      const chatPayload = await chatResponse.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      expect(chatPayload.choices?.[0]?.message?.content).toContain('XPOD_OK');
    } finally {
      if (await customApiKeyInput.isVisible({ timeout: 250 }).catch(() => false)) {
        await customApiKeyInput.fill('').catch(() => undefined);
      }
      await page.context().close();
    }
  });

  test('persists a real DeepSeek credential and routes Gateway chat', async ({ browser }) => {
    const apiKey = process.env.XPOD_REAL_DEEPSEEK_API_KEY;
    const modelId = process.env.XPOD_REAL_DEEPSEEK_MODEL_ID ?? 'deepseek-v4-flash';
    test.skip(!apiKey, 'Requires an explicitly supplied real DeepSeek credential');
    test.setTimeout(240_000);
    const page = await browser.newPage();
    try {
      const trace = await loginToSettings(page, alice);
      assertRealOidcTrace(trace);
      await openModule(page, '/ai-connections', 'AI Connections');
      await page.getByRole('option', { name: 'DeepSeek' }).click();
      await openProviderKeyDialog(page);
      const secretInput = page.getByLabel('DeepSeek API Key 输入');
      await secretInput.fill(apiKey!);
      await page.getByRole('button', { name: '保存 DeepSeek API Key' }).click();
      await expect(page.locator('body')).not.toContainText(apiKey!);
      await page.getByRole('button', { name: /同步模型|刷新模型/u }).click();
      await expect(page.getByText(modelId, { exact: true }).first()).toBeVisible({ timeout: 45_000 });
      const checkbox = page.getByRole('checkbox', { name: `选择 ${modelId}` }).first();
      await checkbox.click();
      await expect(page.getByRole('checkbox', { name: `取消选择 ${modelId}` }).first()).toHaveAttribute('aria-checked', 'true');

      const podState = await runAiConnectionsPodProbe(alice, { provider: 'deepseek', expectedSecret: apiKey });
      expect(podState.providerCredentialCount).toBeGreaterThan(0);
      expect(podState.readSecretMatches).toBe(true);

      const gatewayKey = await createAliceGatewayKeyThroughUi(page);
      const modelsResponse = await page.request.get(new URL('/v1/models', fixtureHarness.ready.baseUrl).toString(), {
        headers: { authorization: `Bearer ${gatewayKey}` },
      });
      const modelsBody = await modelsResponse.text();
      expect(modelsResponse.status(), modelsBody).toBe(200);
      expect((JSON.parse(modelsBody) as { data?: Array<{ id?: string }> }).data?.map((model) => model.id)).toContain(modelId);

      const chatResponse = await page.request.post(new URL('/v1/chat/completions', fixtureHarness.ready.baseUrl).toString(), {
        headers: { authorization: `Bearer ${gatewayKey}` },
        data: {
          model: modelId,
          messages: [{ role: 'user', content: 'Reply only: XPOD_DEEPSEEK_OK' }],
          max_tokens: 128,
        },
        timeout: 60_000,
      });
      const chatBody = await chatResponse.text();
      expect(chatResponse.status(), chatBody).toBe(200);
      expect((JSON.parse(chatBody) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content)
        .toContain('XPOD_DEEPSEEK_OK');
    } finally {
      await page.context().close();
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
          { label: 'AI Connections', path: '/ai-connections', expected: /OpenAI|Anthropic|Kimi|百炼|DeepSeek|API KEYS/i },
          { label: 'Pod', path: '/settings/pod', expected: /WebID|Pod|Issuer|Storage|AI Connection/i },
          { label: 'Network', path: '/network', expected: /Network|endpoint|unsupported|supported|连接/i },
          { label: 'Status', path: '/status/overview', expected: /runtime|Solid Server|Gateway|API Server/i },
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
      await openModule(page, '/ai-connections', 'AI Connections');

      const search = page.locator('[data-workspace-list-header="true"] input[aria-label="搜索 Provider"]');
      await expect(search).toBeVisible();
      await search.focus();
      await expect(search).toBeFocused();

      const detailTrigger = page.getByRole('option', { name: 'OpenAI' }).first();
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
  try {
    return await completeOidcLogin(page, account, {
      baseUrl: fixtureHarness.ready.baseUrl,
      startUrl: new URL('/ai-connections', fixtureHarness.ready.baseUrl).toString(),
      ready: isXpodWorkspaceReady,
      requireCallbackEvidence: true,
      timeoutMs: 90_000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = fixtureHarness.diagnostics();
    throw new Error(diagnostics ? `${message}\n${diagnostics}` : message, { cause: error });
  }
}

async function isXpodWorkspaceReady(page: Page): Promise<boolean> {
  try {
    const url = new URL(page.url());
    const origin = new URL(fixtureHarness.ready.baseUrl).origin;
    if (url.origin !== origin) return false;
    if (url.pathname !== '/ai-connections' && !url.pathname.startsWith('/settings')) return false;
    const workspaceVisible = await page.locator('[data-workspace-layout]').first().isVisible({ timeout: 250 });
    if (!workspaceVisible) return false;
    return await page.locator('[data-testid="workspace-main-pane"] section[role="region"]').first().count() > 0;
  } catch {
    return false;
  }
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function redactFixtureSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"']+/giu, 'Bearer <redacted>')
    .replace(/sk-[A-Za-z0-9._+\/=-]+/gu, 'sk-<redacted>')
    .replace(/("(?:secret|apiKey|key|access_token|refresh_token|clientSecret)"\s*:\s*)"[^"]*"/giu, '$1"<redacted>"');
}

function sanitizedFixtureDiagnostics(value: string): string {
  return redactFixtureSecrets(value)
    .split(/\r?\n/u)
    .filter((line) => /Route handler error|\berror\b|unsupported|missing|required/iu.test(line))
    .slice(-30)
    .join('\n');
}

async function openModule(page: Page, route: string, _label: string): Promise<void> {
  const destination = new URL(route, fixtureHarness.ready.baseUrl);
  const current = new URL(page.url());
  if (`${current.pathname}${current.search}` !== `${destination.pathname}${destination.search}`) {
    await page.goto(destination.toString(), { waitUntil: 'domcontentloaded' });
  }
  const navigationHref = `${destination.pathname}${destination.search}`;
  await expect(page.locator(`a[href="${navigationHref}"]`).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-workspace-layout]')).toBeAttached({ timeout: 30_000 });
  await expect(page.locator('[data-testid="workspace-list-pane"]')).toBeAttached({ timeout: 30_000 });
  await expect(page.locator('[data-testid="workspace-main-pane"]')).toBeAttached({ timeout: 30_000 });
}

async function openProviderKeyDialog(page: Page, expectSubscriptionActions = false): Promise<void> {
  const section = page.getByRole('region', { name: '当前连接', exact: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  if (expectSubscriptionActions) {
    await expect(section.getByRole('button', { name: '浏览器登录', exact: true })).toBeVisible();
    await expect(section.getByRole('button', { name: '设备码登录', exact: true })).toBeVisible();
    await expect(section.getByRole('button', { name: '已有登录态', exact: true })).toBeVisible();
    await section.screenshot({ path: path.join(screenshotDir, 'provider-header-actions.png'), animations: 'disabled' });
  }
  await section.getByRole('button', { name: '新建 API Key 连接', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建连接' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-create-offering="api-platform"]')).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: '接入方式' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '浏览器登录', exact: true })).toHaveCount(0);
}

async function completeApiKeyThroughUi(
  page: Page,
  apiKey = fakeProviderApiKey,
): Promise<void> {
  await page.getByRole('option', { name: 'OpenAI' }).click();
  await openProviderKeyDialog(page, true);
  await page.getByLabel('OpenAI API Key 输入').fill(apiKey);
  await page.screenshot({ path: path.join(screenshotDir, 'provider-create-dialog.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '高级设置' }).click();
  await page.getByLabel('OpenAI Base URL 输入').fill(fixtureHarness.ready.fixtureBaseUrl);
  await page.getByRole('button', { name: '保存 OpenAI API Key' }).click();
  await expect(page.locator('body')).not.toContainText(apiKey);
  try {
    await expect(page.getByRole('dialog', { name: '新建连接' })).toHaveCount(0, { timeout: 30_000 });
  } catch (error) {
    await page.screenshot({ path: path.join(screenshotDir, 'provider-create-failure.png'), fullPage: true });
    throw new Error(`${String(error)}\n${redactFixtureSecrets(await page.getByRole('dialog', { name: '新建连接' }).innerText())}`);
  }
  await expect(page.getByText(maskedCredentialLabel(apiKey), { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: path.join(screenshotDir, 'provider-credential-list.png'), fullPage: true, animations: 'disabled' });
  const refreshResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/api/ai/gateway/providers/openai/models/refresh')
  ));
  await page.getByRole('button', { name: /同步模型|刷新模型/u }).click();
  const refreshResponse = await refreshResponsePromise;
  if (!refreshResponse.ok()) {
    throw new Error(
      `OpenAI model refresh failed with ${refreshResponse.status()}: ${(await refreshResponse.text()).slice(0, 500)}\n${fixtureHarness.diagnostics()}`,
    );
  }
}

async function chooseFixtureModel(page: Page): Promise<void> {
  const checkbox = page.getByRole('checkbox', { name: `选择 ${fixtureModelName}` }).first();
  await expect(checkbox).toBeVisible({ timeout: 30_000 });
  await checkbox.click();
  await expect(page.getByRole('checkbox', { name: `取消选择 ${fixtureModelName}` }).first()).toHaveAttribute('aria-checked', 'true');
}

async function createAliceGatewayKeyThroughUi(page: Page): Promise<string> {
  await openApiKeysSection(page);
  await expect(page.getByLabel('API Key 名称')).toHaveCount(0);
  await page.getByRole('button', { name: '新建 API Key' }).click();
  await expect(page.getByRole('dialog', { name: '新建 API Key' })).toBeVisible();
  await page.getByLabel('API Key 名称').fill(aliceGatewayKeyName);
  await page.screenshot({ path: path.join(screenshotDir, 'api-key-create-dialog.png'), fullPage: true, animations: 'disabled' });
  const creationRequests: string[] = [];
  const trackRequest = (request: Request) => {
    if (request.method() === 'POST') creationRequests.push(new URL(request.url()).pathname);
  };
  page.on('request', trackRequest);
  const accountResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname.startsWith('/.account/')
    && response.request().postDataJSON()?.name === aliceGatewayKeyName
    && response.request().postDataJSON()?.webId === alice.webId
  ));
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/ai/gateway/keys'
  ));
  try {
    await page.getByRole('button', { name: '创建 API Key' }).click();
    const [accountResponse, createResponse] = await Promise.all([accountResponsePromise, createResponsePromise]);
    expect(accountResponse.ok()).toBe(true);
    const credential = await accountResponse.json() as { id?: unknown; secret?: unknown; resource?: unknown };
    expect(typeof credential.id).toBe('string');
    expect(typeof credential.secret).toBe('string');
    expect(typeof credential.resource).toBe('string');
    const responseBody = await createResponse.text();
    const payload = JSON.parse(responseBody) as { key?: unknown; record?: { kind?: string; fingerprint?: string } };
    if (createResponse.status() !== 201 || typeof payload.key !== 'string' || !payload.key) {
      throw new Error(`Gateway key creation failed with ${createResponse.status()}: ${redactFixtureSecrets(responseBody).slice(0, 1500)}\n${fixtureHarness.diagnostics()}`);
    }
    const expectedKey = `sk-${Buffer.from(`${credential.id}:${credential.secret}`, 'utf8').toString('base64')}`;
    expect(payload.key === expectedKey).toBe(true);
    const stored = createResponse.request().postDataJSON() as { name?: string; apiKey?: string; credentialResource?: string };
    expect(stored.name).toBe(aliceGatewayKeyName);
    expect(stored.apiKey === expectedKey).toBe(true);
    expect(typeof stored.credentialResource).toBe('string');
    expect(new URL(stored.credentialResource!).pathname).toBe(new URL(credential.resource as string, fixtureHarness.ready.baseUrl).pathname);
    expect(payload.record?.kind).toBe('client-credentials');
    expect(payload.record?.fingerprint).toBeTruthy();
    await expect(page.getByText(aliceGatewayKeyName, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('API Key 已创建，可在列表中复制或应用配置。', { exact: true })).toBeVisible();
    await expect(page.getByLabel('API Key 名称')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(payload.key);
    expect(creationRequests.filter((pathname) => pathname === '/api/ai/gateway/keys')).toHaveLength(1);
    expect(creationRequests.some((pathname) => /\/(?:plan|apply|verify|reveal)$/u.test(pathname))).toBe(false);
    return payload.key;
  } finally {
    page.off('request', trackRequest);
  }
}

async function openGatewayClientMenu(page: Page): Promise<void> {
  const menu = page.getByRole('group', { name: `${aliceGatewayKeyName} 客户端选项` });
  const trigger = page.getByRole('button', { name: `${aliceGatewayKeyName} 客户端配置`, exact: true });
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  if (!await menu.isVisible()) await trigger.click();
  await expect(menu).toBeVisible();
}

async function applyAndWithdrawAliceGatewayKeyThroughUi(page: Page, apiKey: string): Promise<void> {
  await openApiKeysSection(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: `复制 ${aliceGatewayKeyName}`, exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())) === apiKey,
    { message: 'The key copy action should copy the complete API Key' }).toBe(true);
  await expect(page.locator('body')).not.toContainText(apiKey);
  await openGatewayClientMenu(page);
  const clientCheckbox = page.getByRole('checkbox', { name: `${aliceGatewayKeyName} 应用到 Codex`, exact: true });
  await expect(clientCheckbox).not.toBeChecked();
  const endpoint = '/api/ai/client-configuration/codex';
  const planResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && new URL(response.url()).pathname === `${endpoint}/plan`
  ));
  const applyResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && new URL(response.url()).pathname === `${endpoint}/apply`
  ));
  await clientCheckbox.click();
  const planResponse = await planResponsePromise;
  expect(planResponse.status()).toBe(200);
  expect(planResponse.request().postDataJSON().endpoint).toBe(fixtureHarness.ready.baseUrl.replace(/\/$/u, ''));
  const plan = await planResponse.json() as { confirmation?: { required?: boolean; token?: string; targetHash?: string } };
  await expect(page.getByRole('dialog', { name: '确认应用配置' })).toHaveCount(0);
  const applyResponse = await applyResponsePromise;
  expect(applyResponse.status()).toBe(200);
  expect(applyResponse.request().postDataJSON().apiKey === apiKey).toBe(true);
  if (plan.confirmation?.required) {
    expect(applyResponse.request().postDataJSON().confirmation).toEqual({
      token: plan.confirmation.token, targetHash: plan.confirmation.targetHash,
    });
  }
  await applyResponse.finished();
  await test.info().attach('client-configuration-timing', {
    body: JSON.stringify({ client: 'codex', planMs: planResponse.request().timing().responseEnd, applyMs: applyResponse.request().timing().responseEnd }),
    contentType: 'application/json',
  });
  await expect(page.getByText('Codex 配置已应用。', { exact: true })).toBeVisible();
  await expect(clientCheckbox).toBeChecked();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openApiKeysSection(page);
  await openGatewayClientMenu(page);
  await expect(clientCheckbox).toBeChecked({ timeout: 30_000 });
  const keyRow = page.locator('[data-key-state]').filter({ has: page.getByText(aliceGatewayKeyName, { exact: true }) });
  await expect(keyRow.getByText('已启用', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `应用 ${aliceGatewayKeyName} 配置` })).toHaveCount(0);
  for (const viewport of [{ width: 1054, height: 768 }, { width: 390, height: 844 }]) {
    await page.keyboard.press('Escape');
    await page.setViewportSize(viewport);
    if (viewport.width < 768) await page.getByRole('option', { name: 'API Keys', exact: true }).click();
    const trigger = page.getByRole('button', { name: `${aliceGatewayKeyName} 客户端配置`, exact: true });
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => {
      const nameBox = await keyRow.getByText(aliceGatewayKeyName, { exact: true }).boundingBox();
      const targetBox = await trigger.boundingBox();
      return Boolean(nameBox && targetBox && Math.abs((targetBox.y + targetBox.height / 2) - (nameBox.y + nameBox.height / 2)) < 4);
    }, { message: 'Key details and client controls should share one compact row after viewport resize' }).toBe(true);
    await expect(trigger).toHaveText('应用');
    await expect(keyRow.getByRole('button', { name: `复制 ${aliceGatewayKeyName}`, exact: true })).toBeVisible();
    await openGatewayClientMenu(page);
    await expect(clientCheckbox).toBeChecked({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      { message: 'API Keys and client menu should fit the viewport without horizontal scrolling' }).toBe(true);
    await page.screenshot({ path: path.join(screenshotDir, `api-key-client-menu-${viewport.width}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await openGatewayClientMenu(page);
  const restoreResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && new URL(response.url()).pathname === `${endpoint}/restore`
  ));
  await clientCheckbox.click();
  const restoreResponse = await restoreResponsePromise;
  expect(restoreResponse.status()).toBe(200);
  expect((await restoreResponse.json()).status).toBe('notConfigured');
  await expect(page.getByText('Codex 配置已撤回，API Key 已保留。', { exact: true })).toBeVisible();
  await expect(clientCheckbox).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByText(aliceGatewayKeyName, { exact: true })).toBeVisible();
  const modelsAfterRestore = await page.request.get(new URL('/v1/models', fixtureHarness.ready.baseUrl).toString(), {
    headers: { authorization: `Bearer ${apiKey}` }, timeout: 30_000,
  });
  expect(modelsAfterRestore.status()).toBe(200);
}

async function assertAliceGatewayModelAccess(page: Page, gatewayKey: string): Promise<void> {
  const response = await page.request.get(
    new URL('/v1/models', fixtureHarness.ready.baseUrl).toString(),
    {
      headers: { authorization: `Bearer ${gatewayKey}` },
      timeout: 30_000,
    },
  );
  if (response.status() !== 200) {
    throw new Error(
      `Created API Key model lookup failed with ${response.status()}: ${(await response.text()).slice(0, 500)}\n${fixtureHarness.diagnostics()}`,
    );
  }
  const payload = await response.json() as { data?: Array<{ id?: unknown }> };
  expect(payload.data?.map((model) => model.id)).toEqual([fixtureModelId]);
}

async function assertAliceGatewayChatAccess(page: Page, gatewayKey: string): Promise<void> {
  const response = await page.request.post(
    new URL('/v1/chat/completions', fixtureHarness.ready.baseUrl).toString(),
    {
      headers: { authorization: `Bearer ${gatewayKey}` },
      data: {
        model: fixtureModelId,
        messages: [{ role: 'user', content: 'Reply only: XPOD_OK' }],
        max_tokens: 16,
      },
      timeout: 30_000,
    },
  );
  const body = await response.text();
  const fixtureStatus = await fixtureHarness.status();
  expect(response.status(), `${body}\nRequests: ${fixtureStatus.requests.join(', ')}\n${fixtureHarness.diagnostics()}`).toBe(200);
  const payload = JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> };
  expect(payload.choices?.[0]?.message?.content).toContain('XPOD_OK');
}

async function openApiKeysSection(page: Page): Promise<void> {
  await openModule(page, '/ai-connections', 'AI Connections');
  await page.getByRole('option', { name: 'API Keys', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'API KEYS', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: '新建 API Key' })).toBeVisible({ timeout: 30_000 });
}

async function deleteAliceFixtureCredentialThroughUi(page: Page): Promise<void> {
  await openModule(page, '/ai-connections', 'AI Connections');
  await page.getByRole('option', { name: 'OpenAI' }).click();
  const remove = page.getByRole('button', { name: `删除 ${primaryCredentialLabel}` });
  if (await remove.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await remove.click();
    await expect(page.getByText(primaryCredentialLabel, { exact: true })).toHaveCount(0);
  }
}

async function deleteAliceGatewayKeyThroughUi(page: Page): Promise<void> {
  await openApiKeysSection(page);
  const deleteActions = page.getByRole('button', { name: `删除 ${aliceGatewayKeyName}` });
  const remove = deleteActions.first();
  await expect(remove).toBeVisible({ timeout: 30_000 });
  await expect(remove).toBeEnabled();
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'DELETE'
    && new URL(response.url()).pathname.startsWith('/api/ai/gateway/keys/')
  ));
  await remove.click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(page.getByText(aliceGatewayKeyName, { exact: true })).toHaveCount(0);
}

async function assertReversiblePodCredential(account: BrowserSolidAccount, plaintext: string): Promise<{ id: string }> {
  const result = await runAiConnectionsPodProbe(account, {
    provider: 'openai',
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

function maskedCredentialLabel(apiKey: string): string {
  const hint = apiKey.length <= 8
    ? `${apiKey.slice(0, 2)}…`
    : `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}`;
  return `API Key · ${hint}`;
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
    const listPane = document.querySelector('[data-testid="workspace-list-pane"]');
    return {
      overflow: root.scrollWidth - root.clientWidth,
      listHeader: rect(listHeader),
      mainHeader: rect(mainHeader),
      main: rect(main),
      listPane: rect(listPane),
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
  expect(metrics.listPane).toBeTruthy();
  expect(metrics.tokens.radius).not.toBe('');
  expect(metrics.tokens.background).not.toBe('');
  expect(metrics.tokens.foreground).not.toBe('');
  expect(metrics.tokens.border).not.toBe('');
  if (label === 'AI Connections') {
    expect(metrics.search).toBeTruthy();
  }
  if (requireSplitHeaders && metrics.listHeader && metrics.mainHeader) {
    expect(Math.abs(metrics.listHeader.y - metrics.mainHeader.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.listHeader.height - metrics.mainHeader.height)).toBeLessThanOrEqual(1);
  }
}
