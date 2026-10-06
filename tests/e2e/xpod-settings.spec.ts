import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Locator, type Page, type Request, test } from '@playwright/test';
import { completeOidcLogin, type BrowserOidcTrace, type BrowserSolidAccount } from '../helpers/browserSolidOidc';
import { openNavigationDrawer } from '../helpers/navigationDrawer';

const screenshotDir = path.resolve('.test-data/acceptance/screenshots');
const fixtureModelId = 'fixture-gpt-acceptance';
const fixtureModelName = 'Fixture GPT Acceptance';
const fakeProviderApiKey = 'sk-xpod-acceptance-fixture-key';
const fakeSiblingApiKey = 'sk-xpod-acceptance-fixture-sibling';
const primaryCredentialHint = credentialHint(fakeProviderApiKey);
const siblingCredentialHint = credentialHint(fakeSiblingApiKey);
/**
 * PROOF BOUNDARY (re-authored 2026-10-07, phase22): the Xpod key flows here are
 * driven through the living applet surface — nav option `Xpod`, dialog
 * `新建 Xpod 密钥` / `Xpod 密钥 已签发`, and the Account client-credentials
 * capability (the wrapper is only ever visible in the creating session).
 *
 * The heavy workspace is declared by the desktop preload bridge, never by
 * viewport or hostname, so a browser fixture must select that surface the same
 * way `account-web-layout.spec.ts` does (`useDesktopSurface`). The marker only
 * picks the renderer: no session, cookie, token, callback or authority is
 * injected, and the real OIDC login and real Xpod key UI still run. This is
 * browser-fixture evidence against a locally spawned stack for the desktop
 * SURFACE, NOT evidence about the immutable released ZIP, a real Electron
 * preload, or a formal RC run; those need their own exact-artifact proof.
 *
 * REPAIRED CONTRACT (2026-10-07, phase23): destroying an Xpod key removes the
 * Account credential and the gateway must refuse the `sk-` wrapper on the very
 * next request. The gateway admits through `SolidSessionFactory.admit()`, which
 * proves the presented wrapper to its issuer on every inbound request; the
 * session cache only stops the same request from exchanging twice. The last test
 * asserts that 401, so a cache-first regression fails here instead of passing.
 */
const aliceGatewayKeyName = 'Alice acceptance Xpod key';
/** The Account credential id (the CSS label) of the key this run created. */
let aliceIssuedKeyId = '';
/** The client-configuration bridge surface the Xpod apply/verify flow drives. */
const codexClientConfigurationPath = '/api/ai/client-configuration/codex';
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

  test('creates an Account-backed Xpod key, authenticates /v1/models with it, and reports the wrapper as unrecoverable after reload', async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    let plaintext = '';
    let workflowFailed = false;

    try {
      const trace = await loginToSettings(page, alice);
      assertRealOidcTrace(trace);
      plaintext = await createAliceGatewayKeyThroughUi(page);
      // An Account-backed Xpod key is not a toggleable Gateway key record.
      await expect(page.getByRole('button', { name: `停用 ${aliceGatewayKeyName}` })).toHaveCount(0);
      await expect(aliceGatewayKeyRow(page)).toHaveCount(1);
      const models = await page.request.get(
        new URL('/v1/models', fixtureHarness.ready.baseUrl).toString(),
        { headers: { authorization: `Bearer ${plaintext}` }, timeout: 30_000 },
      );
      expect(models.status()).toBe(200);
      expect((await models.json()).data).toEqual([]);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await reenterAuthenticatedWorkspace(page, alice);
      await openApiKeysSection(page);
      // A fresh session reads the Account again, so the row is identified by its
      // stored credential id rather than the wrapper-request display name.
      await expect(aliceGatewayKeyRow(page)).toBeVisible({ timeout: 30_000 });
      // The Account does not own the wrapper, so a reload cannot recover it:
      // the row states that plainly, no reveal request is made, and the fresh
      // session has no observed digest so it cannot honestly offer a verify.
      const keyRow = aliceGatewayKeyRow(page);
      await expect(keyRow).toHaveCount(1);
      // Scope the unrecoverable-secret note to this row: a fresh session shows
      // it for every Account credential whose wrapper it never observed, so a
      // page-wide match would also catch unrelated fixture credentials.
      await expect(keyRow.getByText('密钥原文没有保存，不能再显示', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(keyRow.getByRole('button', { name: '测试一次', exact: true })).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(plaintext);
      await page.screenshot({ path: path.join(screenshotDir, 'xpod-key-unrecoverable-row.png'), fullPage: true, animations: 'disabled' });
    } catch (error) {
      workflowFailed = true;
      await page.screenshot({ path: path.join(screenshotDir, 'xpod-key-layout-failure.png'), fullPage: true }).catch(() => undefined);
      throw error;
    } finally {
      // Destroying the key is acceptance evidence, not best-effort cleanup: the
      // helper asserts the Account DELETE returns 200 and the row disappears.
      // Whether the wrapper stops authenticating straight away is a separate
      // requirement, covered by its own test at the end of this file.
      if (!workflowFailed) {
        const destroyed = await settleWithin(deleteAliceGatewayKeyThroughUi(page), 90_000);
        expect(destroyed, 'destroying the Xpod key should complete within the budget').toBe(true);
      } else {
        await settleWithin(deleteAliceGatewayKeyThroughUi(page), 90_000);
      }
      if (plaintext) await expect(page.locator('body')).not.toContainText(plaintext).catch(() => undefined);
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
      const firstHandle = providerCredentialRow(alicePage, primaryCredentialHint)
        .getByRole('button', { name: /^拖动排序 /u });
      const secondHandle = providerCredentialRow(alicePage, siblingCredentialHint)
        .getByRole('button', { name: /^拖动排序 /u });
      await expect(secondHandle).toBeEnabled({ timeout: 30_000 });
      const from = await secondHandle.boundingBox();
      const to = await firstHandle.boundingBox();
      expect(from).not.toBeNull();
      expect(to).not.toBeNull();
      await alicePage.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
      await alicePage.mouse.down();
      await alicePage.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 8 });
      await alicePage.mouse.up();
      await expect(alicePage.locator('[data-sortable-credential]').first()).toContainText(siblingCredentialHint, { timeout: 30_000 });
      await expect(secondHandle).toBeEnabled({ timeout: 30_000 });
      await alicePage.reload({ waitUntil: 'domcontentloaded' });
      await reenterAuthenticatedWorkspace(alicePage, alice);
      await openModule(alicePage, '/ai-connections', 'AI Connections');
      await alicePage.getByRole('option', { name: 'OpenAI' }).click();
      await expect(alicePage.locator('[data-sortable-credential]').first()).toContainText(siblingCredentialHint, { timeout: 30_000 });
      await alicePage.screenshot({ path: path.join(screenshotDir, 'provider-drag-persisted.png'), fullPage: true });
      const siblingRow = providerCredentialRow(alicePage, siblingCredentialHint);
      await siblingRow.getByRole('button', { name: /^停用 /u }).click();
      await expect(siblingRow.getByRole('button', { name: /^启用 /u })).toBeVisible({ timeout: 30_000 });
      await siblingRow.getByRole('button', { name: /^启用 /u }).click();
      await expect(siblingRow.getByRole('button', { name: /^停用 /u })).toBeVisible();
      await siblingRow.getByRole('button', { name: /^删除 /u }).click();
      await expect(alicePage.getByText(siblingCredentialHint, { exact: true })).toHaveCount(0);
      await expect(providerCredentialRow(alicePage, primaryCredentialHint)).toBeVisible();
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
      await reenterAuthenticatedWorkspace(alicePage, alice);
      await openModule(alicePage, '/ai-connections', 'AI Connections');
      await alicePage.getByRole('option', { name: 'OpenAI' }).click();
      await expect(alicePage.getByText(fixtureModelName, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
      await expect(alicePage.getByRole('button', { name: `停用 ${fixtureModelName}` }).first()).toBeVisible({ timeout: 30_000 });

      const aliceGatewayKey = await createAliceGatewayKeyThroughUi(alicePage, { purpose: 'codex', apply: true });
      await assertAliceGatewayModelAccess(alicePage, aliceGatewayKey);
      await assertAliceGatewayChatAccess(alicePage, aliceGatewayKey);
      await verifyAliceGatewayKeyThroughUi(alicePage, aliceGatewayKey);
      await assertAliceGatewayKeyRowWorkspace(alicePage);

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
      await expect(alicePage.getByRole('button', { name: `停用 ${fixtureModelName}` }).first()).toBeVisible({ timeout: 30_000 });

      const bobTrace = await loginToSettings(bobPage, bob);
      assertRealOidcTrace(bobTrace);
      await openModule(bobPage, '/ai-connections', 'AI Connections');
      await expect(bobPage.locator('body')).not.toContainText(primaryCredentialHint);
      await expect(bobPage.locator('body')).not.toContainText(aliceGatewayKeyName);
      await expect(bobPage.locator('[data-credential-state]')).toHaveCount(0);
      await expect(bobPage.getByText(fixtureModelName, { exact: true })).toHaveCount(0);

      await openApiKeysSection(bobPage);
      await expect(bobPage.locator('body')).not.toContainText(aliceGatewayKeyName);
      await expect(bobPage.locator('body')).not.toContainText(aliceGatewayKey);
      // Alice's credential is owned by Alice's WebID: Bob's selected identity
      // must never list it as his own row.
      await expect(aliceGatewayKeyRow(bobPage)).toHaveCount(0);

      const bobPod = await runAiConnectionsPodProbe(bob, { provider: 'openai' });
      expect(bobPod.providerCredentialCount).toBe(0);
      expect(bobPod.selectedModelCount).toBe(0);

      // Destroying the key removes the Account credential (the helper asserts
      // the DELETE and the vanished row). Whether the destroyed wrapper stops
      // authenticating immediately is a separate, currently unmet requirement
      // with its own test at the end of this file.
      await deleteAliceGatewayKeyThroughUi(alicePage);
      await expect(aliceGatewayKeyRow(alicePage)).toHaveCount(0);

      // Keep a reference in the test body so the Pod proof cannot accidentally
      // become a UI-only assertion during future acceptance refactors.
      expect(credential.id).toBeTruthy();
    } catch (error) {
      await alicePage.screenshot({ path: path.join(screenshotDir, 'provider-flow-failure.png'), fullPage: true });
      throw new Error(`${String(error)}\n${redactFixtureSecrets(await alicePage.locator('body').innerText())}\n${flowDiagnostics.slice(-15).join('\n')}`);
    } finally {
      await settleWithin(deleteAliceFixtureCredentialThroughUi(alicePage), 90_000);
      await settleWithin(deleteAliceGatewayKeyThroughUi(alicePage), 90_000);
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
      await enableModelThroughUi(page, modelId);
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
      await enableModelThroughUi(page, modelId);

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
        const trace = await loginToSettings(page, alice, { rememberClient: true });
        assertRealOidcTrace(trace);
        assertRememberedDesktopClient(trace);

        for (const module of [
          { label: 'AI Connections', path: '/ai-connections', expected: /OpenAI|Anthropic|Kimi|百炼|DeepSeek|Xpod/i },
          { label: 'Pod', path: '/pod/models', expected: /模型设置|检索与索引|授权应用|数据管理|Pod/i },
          { label: 'Network', path: '/device/network', expected: /网络访问|服务状态|运行设置|查看日志|隧道/i },
          { label: 'Status', path: '/device/services', expected: /服务状态|核心服务|入口网关|Solid 服务|API 服务/i },
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

  test('keeps the desktop rail controls inside the 64px strip at 200% root text', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const trace = await loginToSettings(page, alice, { rememberClient: true });
      assertRealOidcTrace(trace);
      assertRememberedDesktopClient(trace);
      await openModule(page, '/device/network', 'Network');

      // Real root-relative text enlargement: `html { font-size: 200% }` grows rem
      // units, which is exactly what pushed the rem-based rail hit-boxes past the
      // fixed 64px strip (design §10.2 / desktop-shell.css).
      await page.addStyleTag({ content: 'html { font-size: 200%; }' });

      const geometry = await page.evaluate(() => {
        const rect = (element: Element | null | undefined) => {
          const box = element?.getBoundingClientRect();
          return box ? { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right } : null;
        };
        const shell = document.querySelector('.xpod-desktop-shell');
        return {
          rail: rect(document.querySelector('.xpod-rail')),
          items: [...document.querySelectorAll('.xpod-rail nav a')].map((item) => rect(item)),
          scrollWidth: shell?.scrollWidth ?? 0,
          clientWidth: shell?.clientWidth ?? 0,
          rootFontPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        };
      });

      // The enlargement really happened (200% of the 16px default root).
      expect(geometry.rootFontPx).toBeGreaterThanOrEqual(30);
      expect(geometry.rail?.width).toBe(64);
      expect(geometry.items.length).toBeGreaterThan(0);
      for (const item of geometry.items) {
        // Physical 40px hit-box: it must not grow with the root font.
        expect(item?.width).toBeCloseTo(40, 0);
        expect(item?.height).toBeCloseTo(40, 0);
        // The control stays fully inside the rail strip instead of being clipped.
        expect(item?.right ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((geometry.rail?.right ?? 0) + 0.5);
      }
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
      await page.screenshot({ path: path.join(screenshotDir, 'desktop-rail-200pct.png'), fullPage: false });
    } finally {
      await page.context().close();
    }
  });

  test('keeps narrow Models stack detail, focus, and drawer navigation accessible', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      const trace = await loginToSettings(page, alice, { rememberClient: true });
      assertRealOidcTrace(trace);
      assertRememberedDesktopClient(trace);
      await openModule(page, '/ai-connections', 'AI Connections');

      // At 390 the host keeps only the content column and owns the workspace list
      // through its navigation drawer (design §2.7).
      await expect(page.locator('[data-testid="workspace-list-pane"]')).toBeHidden();
      await expect(page.locator('[data-testid="workspace-main-pane"]')).toBeVisible();

      const navigationToggle = await openNavigationDrawer(page);
      const search = page.getByRole('searchbox', { name: '搜索服务商', exact: true });
      await expect(search).toBeVisible();
      await search.focus();
      await expect(search).toBeFocused();

      const detailTrigger = page.getByRole('option', { name: 'OpenAI' }).first();
      await expect(detailTrigger).toBeVisible();
      await detailTrigger.focus();
      await expect(detailTrigger).toBeFocused();
      await detailTrigger.press('Enter');
      // Selecting a Provider switches to the detail and closes the drawer; the
      // host restores focus to the navigation toggle that opened it.
      await expect(page.locator('[data-testid="workspace-list-pane"]')).toBeHidden();
      await expect(page.locator('[data-testid="workspace-main-pane"]')).toBeVisible();
      await expect(navigationToggle).toBeFocused();
      const modelHeaderGeometry = await page.evaluate(() => {
        const header = document.querySelector('[data-testid="provider-models-header"]');
        const heading = header?.querySelector('h3');
        const actions = document.querySelector('[data-testid="provider-models-actions"]');
        const search = actions?.querySelector('input[aria-label="搜索模型"]');
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

      // No standalone back button exists while a host drawer owns the workspace
      // list; the list is reopened through the same navigation toggle.
      await openNavigationDrawer(page);
      await expect(page.locator('[data-testid="workspace-list-pane"]')).toBeVisible();
      await expect(search).toBeVisible();
      await search.focus();
      await expect(search).toBeFocused();
    } finally {
      await page.context().close();
    }
  });

  /**
   * Destroying an Xpod key removes the Account client credential, and the gateway
   * has to stop admitting the `sk-` wrapper on the very next request — not
   * whenever the token some earlier request obtained happens to expire.
   *
   * The gateway admits through `SolidSessionFactory.admit()`, which proves the
   * presented wrapper to its issuer on every inbound request; the session cache
   * only keeps the same request's outbound Pod access from exchanging twice. The
   * run below uses the real CSS Account credential and the real gateway route, so
   * a cache-first regression fails here instead of shipping as a pass.
   */
  test('refuses a destroyed Xpod key immediately', async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    let plaintext = '';
    try {
      const trace = await loginToSettings(page, alice);
      assertRealOidcTrace(trace);
      plaintext = await createAliceGatewayKeyThroughUi(page);
      const before = await page.request.get(
        new URL('/v1/models', fixtureHarness.ready.baseUrl).toString(),
        { headers: { authorization: `Bearer ${plaintext}` }, timeout: 30_000 },
      );
      expect(before.status()).toBe(200);
      await deleteAliceGatewayKeyThroughUi(page);
      const after = await page.request.get(
        new URL('/v1/models', fixtureHarness.ready.baseUrl).toString(),
        { headers: { authorization: `Bearer ${plaintext}` }, timeout: 30_000 },
      );
      expect(after.status(), 'a destroyed Xpod key must stop authenticating').toBe(401);
    } finally {
      await settleWithin(deleteAliceGatewayKeyThroughUi(page), 90_000);
      await context.close().catch(() => undefined);
    }
  });
});

/**
 * A bounded desktop-surface marker: enough for the app to choose the desktop
 * renderer so the real OIDC login and the real Xpod key UI can run in Chromium.
 * It injects no credential material and no auth result.
 */
async function useDesktopSurface(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.assign(window, {
      xpodDesktop: {
        setIdentity: () => undefined,
        setWindowMode: () => undefined,
      },
    });
  });
}

/**
 * Real OIDC login for the desktop surface. `rememberClient` drives the actual
 * Consent "以后不再询问" checkbox when the scenario needs the desktop client to
 * survive a later document load: the bundled client declares
 * `application_type: "native"`, and the IdP's `native_client_prompt` policy
 * answers a `prompt=none` restoration with `interaction_required` until a
 * remembered grant exists. That grant is a real user choice on the Consent
 * screen, not an injected authority; callers that navigate the document after
 * login must select it or the restore will (correctly) be refused.
 */
async function loginToSettings(
  page: Page,
  account: BrowserSolidAccount,
  options: { rememberClient?: boolean } = {},
): Promise<BrowserOidcTrace> {
  await useDesktopSurface(page);
  try {
    return await completeOidcLogin(page, account, {
      baseUrl: fixtureHarness.ready.baseUrl,
      startUrl: new URL('/ai-connections', fixtureHarness.ready.baseUrl).toString(),
      ready: isXpodWorkspaceReady,
      requireCallbackEvidence: true,
      timeoutMs: 90_000,
      ...(options.rememberClient === undefined ? {} : { rememberClient: options.rememberClient }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = fixtureHarness.diagnostics();
    throw new Error(diagnostics ? `${message}\n${diagnostics}` : message, { cause: error });
  }
}

/**
 * A browser fixture has no native session store, so a reload returns to the
 * product's own sign-in surface instead of the workspace — persisted session
 * reuse is an Electron capability (see `browser-session-refresh.spec.ts`).
 * Re-enter through the product's own affordance and complete the real OIDC
 * login again, so post-reload coverage still runs in a genuinely fresh
 * authenticated session instead of being dropped.
 */
async function reenterAuthenticatedWorkspace(page: Page, account: BrowserSolidAccount): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await isXpodWorkspaceReady(page)) return;
    await page.waitForTimeout(300);
  }
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  const retry = page.getByRole('button', { name: '重新登录', exact: true });
  if (await retry.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await retry.click().catch(() => undefined);
    // The product's own retry starts its navigation. Let it settle before the
    // OIDC login navigates again, otherwise the second navigation supersedes
    // the first and fails as ERR_ABORTED.
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  }
  await page.waitForTimeout(500);
  const trace = await loginToSettings(page, account);
  assertRealOidcTrace(trace);
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

/**
 * Wait for a cleanup action with a hard budget. Returns whether the action
 * actually finished, so a caller that treats the action as evidence can fail
 * on a timeout instead of letting a swallowed error read as success.
 */
async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const completed = await Promise.race([
    promise.then(() => true).catch(() => false),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  return completed;
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
  const routeLink = page.locator(`a[href="${navigationHref}"]`).first();
  // The desktop rail exposes the active module link; at 390 the host keeps it in
  // the closed navigation drawer, so it exists without being visible.
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await expect(routeLink).toBeVisible({ timeout: 30_000 });
  } else {
    await expect(routeLink).toBeAttached({ timeout: 30_000 });
  }
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
  await expect(providerCredentialRow(page, credentialHint(apiKey))).toBeVisible({ timeout: 30_000 });
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

/**
 * Turn a model row on through the living catalog toggle and prove the state
 * flipped. The catalog exposes `启用 <name>` / `停用 <name>` row actions; it no
 * longer renders a selection checkbox.
 */
async function enableModelThroughUi(page: Page, modelName: string): Promise<void> {
  const enable = page.getByRole('button', { name: `启用 ${modelName}` }).first();
  await expect(enable).toBeVisible({ timeout: 30_000 });
  await enable.click();
  await expect(page.getByRole('button', { name: `停用 ${modelName}` }).first()).toBeVisible({ timeout: 30_000 });
}

async function chooseFixtureModel(page: Page): Promise<void> {
  await enableModelThroughUi(page, fixtureModelName);
}

type AliceKeyPurpose = '' | 'codex';

/**
 * Drive the living Xpod key flow: the section issues an Account client
 * credential through the host capability, the wrapper is only ever visible in
 * the session that created it, and the copy action must hand back the complete
 * credential. When `apply` is set the issued dialog's `写入 Codex` writes the
 * wrapper into the task-owned local client config through the real
 * local-filesystem bridge, and `purpose` must then be `codex` because the
 * living surface only offers apply for the declared client.
 */
async function createAliceGatewayKeyThroughUi(
  page: Page,
  options: { purpose?: AliceKeyPurpose; apply?: boolean } = {},
): Promise<string> {
  await openApiKeysSection(page);
  await expect(page.getByLabel('Xpod 密钥 名称')).toHaveCount(0);
  await page.getByRole('button', { name: '新建 Xpod 密钥' }).click();
  const formDialog = page.getByRole('dialog', { name: '新建 Xpod 密钥' });
  await expect(formDialog).toBeVisible();
  await page.getByLabel('Xpod 密钥 名称').fill(aliceGatewayKeyName);
  if (options.purpose) {
    await page.getByLabel('Xpod 密钥 用途').selectOption(options.purpose);
  }
  await page.screenshot({ path: path.join(screenshotDir, 'xpod-key-create-dialog.png'), fullPage: true, animations: 'disabled' });
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
  try {
    await page.getByRole('button', { name: '创建 Xpod 密钥' }).click();
    const accountResponse = await accountResponsePromise;
    expect(accountResponse.ok()).toBe(true);
    const credential = await accountResponse.json() as { id?: unknown; secret?: unknown; resource?: unknown };
    expect(typeof credential.id).toBe('string');
    expect(typeof credential.secret).toBe('string');
    expect(typeof credential.resource).toBe('string');
    // The Account owns the credential id (the CSS label). It is the stable row
    // identity before and after a reload, unlike the display name the creating
    // session happens to remember.
    aliceIssuedKeyId = credential.id as string;
    // An Xpod key is an Account client credential: the page wraps the pair it
    // just received and never posts a second record to a Gateway key route.
    const wrapper = `sk-${Buffer.from(`${credential.id}:${credential.secret}`, 'utf8').toString('base64')}`;
    const issuedDialog = page.getByRole('dialog', { name: 'Xpod 密钥 已签发' });
    await expect(issuedDialog).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Xpod 密钥 已创建，请复制或应用到客户端。', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('body')).not.toContainText(wrapper);
    expect(creationRequests.filter((pathname) => pathname === '/api/ai/gateway/keys')).toHaveLength(0);
    expect(creationRequests.some((pathname) => /\/api\/ai\/gateway\/keys\//u.test(pathname))).toBe(false);

    // The copy action must return the complete wrapper while the page itself
    // never echoes it back into the DOM.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await issuedDialog.getByRole('button', { name: '复制 Xpod 密钥', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())) === wrapper,
      { message: 'The key copy action should copy the complete Xpod key' }).toBe(true);
    await expect(page.locator('body')).not.toContainText(wrapper);

    if (options.apply) {
      await applyIssuedAliceGatewayKeyThroughUi(page, issuedDialog, wrapper);
    }

    await issuedDialog.getByRole('button', { name: '完成' }).click();
    await expect(issuedDialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText(aliceGatewayKeyName, { exact: true })).toBeVisible({ timeout: 30_000 });
    return wrapper;
  } finally {
    page.off('request', trackRequest);
  }
}

async function applyIssuedAliceGatewayKeyThroughUi(page: Page, issuedDialog: Locator, wrapper: string): Promise<void> {
  const planResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${codexClientConfigurationPath}/plan`
  ));
  const applyResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${codexClientConfigurationPath}/apply`
  ));
  await issuedDialog.getByRole('button', { name: '写入 Codex', exact: true }).click();
  const planResponse = await planResponsePromise;
  expect(planResponse.status()).toBe(200);
  expect(planResponse.request().postDataJSON().endpoint).toBe(new URL(fixtureHarness.ready.baseUrl).origin);
  const plan = await planResponse.json() as { confirmation?: { required?: boolean; token?: string; targetHash?: string } };
  const applyResponse = await applyResponsePromise;
  expect(applyResponse.status()).toBe(200);
  // The bridge writes the session's own wrapper; it never mints or re-fetches a
  // different credential, and it carries the plan's confirmation when required.
  expect(applyResponse.request().postDataJSON().apiKey).toBe(wrapper);
  if (plan.confirmation?.required) {
    expect(applyResponse.request().postDataJSON().confirmation).toEqual({
      token: plan.confirmation.token, targetHash: plan.confirmation.targetHash,
    });
  }
  await applyResponse.finished();
  await expect(issuedDialog.getByText('已应用到 Codex', { exact: true })).toBeVisible({ timeout: 30_000 });
}

/**
 * Exercise the create-session verify: the native adapter reports the SHA-256
 * digest of the wrapper it wrote, so the UI must observe exactly the digest the
 * session recorded. A mismatch is the confirmed regression where the browser
 * compared the Account client id and wrongly reported the key as changed.
 */
async function verifyAliceGatewayKeyThroughUi(page: Page, wrapper: string): Promise<void> {
  await openApiKeysSection(page);
  const row = aliceGatewayKeyRow(page);
  await expect(row).toHaveCount(1);
  const testButton = row.getByRole('button', { name: '测试一次', exact: true });
  await expect(testButton).toBeVisible({ timeout: 30_000 });
  const verifyResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${codexClientConfigurationPath}/verify`
  ));
  // Only the post-verify inspect carries the applied digest; a stale mount
  // inspect without a fingerprint must not satisfy this wait.
  const inspectResponsePromise = page.waitForResponse(async (response) => {
    if (response.request().method() !== 'GET') return false;
    if (new URL(response.url()).pathname !== codexClientConfigurationPath) return false;
    const body = await response.json().catch(() => undefined) as { appliedKeyFingerprint?: string } | undefined;
    return Boolean(body?.appliedKeyFingerprint);
  });
  await testButton.click();
  const verifyResponse = await verifyResponsePromise;
  expect(verifyResponse.status()).toBe(200);
  const inspectResponse = await inspectResponsePromise;
  expect(inspectResponse.status()).toBe(200);
  const inspected = await inspectResponse.json() as { status?: string; appliedKeyFingerprint?: string };
  expect(inspected.appliedKeyFingerprint).toBe(sha256Hex(wrapper));
  await expect(page.getByText('配置被改动过', { exact: true })).toHaveCount(0);
  await expect(page.getByText('客户端配置测试失败，请重试。', { exact: true })).toHaveCount(0);
}

/**
 * The key row is one compact workspace row: it stays inside the viewport with
 * no horizontal scrolling at both the split and the stack width. At the stack
 * width the workspace list lives in the navigation drawer, so the section is
 * re-opened the way a user would.
 */
async function assertAliceGatewayKeyRowWorkspace(page: Page): Promise<void> {
  for (const viewport of [{ width: 1054, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width < 768) {
      await openNavigationDrawer(page);
      await page.getByRole('option', { name: 'Xpod', exact: true }).click();
    }
    const row = aliceGatewayKeyRow(page);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('范围：整个 Pod');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      { message: 'The Xpod key section should fit the viewport without horizontal scrolling' }).toBe(true);
    await page.screenshot({ path: path.join(screenshotDir, `xpod-key-row-${viewport.width}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
}

function aliceGatewayKeyRow(page: Page): Locator {
  // `data-key-id` is the Account credential id, stable across a reload; the
  // visible name is only the creating session's memory of the wrapper request.
  if (aliceIssuedKeyId) return page.locator(`[data-key-id="${aliceIssuedKeyId}"]`);
  return page.locator('[data-key-id]').filter({ has: page.getByText(aliceGatewayKeyName, { exact: true }) });
}

/**
 * The digest the native adapter records for the applied wrapper. Kept byte for
 * byte in step with `contentHash` in `contract/client-config/base-adapter.ts`
 * and the browser's `apiKeyFingerprint`, so the comparison here is a real
 * contract check rather than a re-implementation the test could drift from.
 */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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
  if ((page.viewportSize()?.width ?? 0) < 768) await openNavigationDrawer(page);
  await page.getByRole('option', { name: 'Xpod', exact: true }).click();
  await expect(page.getByRole('button', { name: '新建 Xpod 密钥' })).toBeVisible({ timeout: 30_000 });
}

async function deleteAliceFixtureCredentialThroughUi(page: Page): Promise<void> {
  await openModule(page, '/ai-connections', 'AI Connections');
  await page.getByRole('option', { name: 'OpenAI' }).click();
  const row = providerCredentialRow(page, primaryCredentialHint);
  const remove = row.getByRole('button', { name: /^删除 /u });
  if (await remove.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await remove.click();
    await expect(page.getByText(primaryCredentialHint, { exact: true })).toHaveCount(0);
  }
}

async function deleteAliceGatewayKeyThroughUi(page: Page): Promise<void> {
  await openApiKeysSection(page);
  const row = aliceGatewayKeyRow(page);
  await expect(row).toHaveCount(1);
  const destroy = row.getByRole('button', { name: /^销毁 /u });
  await expect(destroy).toBeVisible({ timeout: 30_000 });
  await expect(destroy).toBeEnabled();
  // Destruction is confirmed first, then a DELETE on the Account credential.
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'DELETE'
    && new URL(response.url()).pathname.startsWith('/.account/')
  ));
  await destroy.click();
  await row.getByRole('button', { name: /^确认删除 /u }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(row).toHaveCount(0);
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

/**
 * The masked hint the applet renders for a provider API key. It mirrors
 * `maskApiKey` in `src/api/ai-gateway/connect/index.ts`, which is what the
 * credential row shows beneath its label. The row's own label is the credential
 * name (the collection runtime defaults it to the provider id), so two OpenAI
 * keys read `openai`; the hint is what identifies one key's row.
 */
function credentialHint(apiKey: string): string {
  const trimmed = apiKey.trim();
  return `${trimmed.slice(0, Math.min(3, trimmed.length))}...${trimmed.slice(-Math.min(4, trimmed.length))}`;
}

/** The provider credential row carrying one key, located by its masked hint. */
function providerCredentialRow(page: Page, hint: string): Locator {
  return page.locator('[data-credential-state]').filter({ has: page.getByText(hint, { exact: true }) });
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

/**
 * These scenarios load the product route as a document after login, so the
 * desktop client must survive a `prompt=none` restoration. That restoration is
 * only allowed once a remembered grant exists, and the grant comes from the
 * real Consent "以后不再询问" choice. On the first login of a shared fixture the
 * Consent document is rendered and the choice must be offered and retained; a
 * later login may reuse the stored grant and skip Consent entirely, which is
 * itself the restored behaviour this prerequisite enables. Either way the
 * approval document must never report the requested choice as blocked.
 */
function assertRememberedDesktopClient(trace: BrowserOidcTrace): void {
  if ((trace.consentRequestCount ?? 0) > 0) {
    expect(trace.rememberClientObserved).toBe(true);
  }
  expect(trace.rememberClientBlocked).toBeUndefined();
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
      search: rect(document.querySelector('[data-workspace-list-header="true"] input[aria-label="搜索服务商"]')),
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
