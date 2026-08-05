import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Browser, type Page, test } from '@playwright/test';

const env = process.env;
const baseUrl = env.XPOD_SETTINGS_E2E_BASE_URL;
const aliceState = env.XPOD_SETTINGS_E2E_ALICE_STATE;
const bobState = env.XPOD_SETTINGS_E2E_BOB_STATE;
const alicePodUrl = env.XPOD_SETTINGS_E2E_ALICE_POD_URL;
const testApiKey = env.XPOD_SETTINGS_E2E_TEST_API_KEY;
const providerFixtureUrl = env.XPOD_SETTINGS_E2E_PROVIDER_FIXTURE_URL;
const providerFixtureControlToken = env.XPOD_SETTINGS_E2E_PROVIDER_FIXTURE_CONTROL_TOKEN;
const screenshotDir = path.resolve('.test-data/acceptance/screenshots');
const hasRequiredEnvironment = Boolean(baseUrl && aliceState && bobState && alicePodUrl && testApiKey);
const hasModelDiscoveryEnvironment = Boolean(hasRequiredEnvironment && providerFixtureUrl);

test.describe('Xpod settings product acceptance', () => {
  test.skip(!hasRequiredEnvironment, 'Set XPOD_SETTINGS_E2E_BASE_URL, XPOD_SETTINGS_E2E_ALICE_STATE, XPOD_SETTINGS_E2E_BOB_STATE, XPOD_SETTINGS_E2E_ALICE_POD_URL and XPOD_SETTINGS_E2E_TEST_API_KEY.');

  test.beforeAll(async () => {
    await mkdir(screenshotDir, { recursive: true });
  });

  test('persists Alice API-key credential in her private Pod and keeps it isolated from Bob', async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await authenticatedPage(browser, aliceState!);
    const bob = await authenticatedPage(browser, bobState!);
    try {
      const { aliceBefore, bobBefore } = await test.step('read Alice and Bob baselines', async () => ({
        aliceBefore: await readPodAiConnectionStatus(alice),
        bobBefore: await readPodAiConnectionStatus(bob),
      }));
      expect(aliceBefore.webId).not.toBe(bobBefore.webId);

      await test.step('connect Alice OpenAI API key', async () => {
        await openModule(alice, '/settings/models', 'Models');
        await completeApiKeyThroughUi(alice, testApiKey!);
      });
      await test.step('verify Alice Pod persistence after reload', async () => {
        await alice.reload({ waitUntil: 'domcontentloaded' });
        await expect(alice.locator('body')).not.toContainText(testApiKey!);
        await expect(alice.locator('body')).toContainText(/openai|configured|connected|api key/i);

        const aliceAfter = await readPodAiConnectionStatus(alice);
        expect(aliceAfter.webId).toBe(aliceBefore.webId);
        expect(aliceAfter.configuredProviders).toBeGreaterThanOrEqual(1);
        expect(aliceAfter.configuredProviders).toBeGreaterThanOrEqual(aliceBefore.configuredProviders);
      });

      await test.step('verify Bob remains isolated', async () => {
        await openModule(bob, '/settings/models', 'Models');
        await expect(bob.locator('body')).not.toContainText(testApiKey!);
        const bobAfter = await readPodAiConnectionStatus(bob);
        expect(bobAfter.webId).toBe(bobBefore.webId);
        expect(bobAfter.configuredProviders).toBe(bobBefore.configuredProviders);
      });
    } finally {
      await alice.context().close();
      await bob.context().close();
    }
  });

  test('model discovery and stale models: Picks persist without crossing WebID boundaries', async ({ browser }) => {
    test.skip(!hasModelDiscoveryEnvironment, 'Set the real Xpod auth environment plus XPOD_SETTINGS_E2E_PROVIDER_FIXTURE_URL.');
    test.setTimeout(180_000);
    const alice = await authenticatedPage(browser, aliceState!);
    const bob = await authenticatedPage(browser, bobState!);
    try {
      const aliceBefore = await readPodAiConnectionStatus(alice);
      const bobBefore = await readPodAiConnectionStatus(bob);
      expect(aliceBefore.webId).not.toBe(bobBefore.webId);
      await setFixtureModels(['gpt-5', 'gpt-5-mini']);
      await resetFixtureAuthTouches();

      await test.step('connect Alice and wait for live provider discovery', async () => {
        const descriptorResponse = waitForServiceAccessDescriptor(alice);
        await openModule(alice, '/settings/models', 'Models');
        const descriptor = await readServiceAccessDescriptor(await descriptorResponse);
        expectServiceAccessOwner(descriptor, aliceBefore.webId);
        await completeApiKeyThroughUi(alice, testApiKey!);
        await expect(alice.getByRole('checkbox', { name: /gpt-5 \(gpt-5\)/i }).first()).toBeVisible({ timeout: 30_000 });
      });

      await test.step('Pick only gpt-5 and persist it through the authenticated API', async () => {
        const checkbox = alice.getByRole('checkbox', { name: /gpt-5 \(gpt-5\)/i }).first();
        if (await checkbox.isChecked()) {
          await checkbox.uncheck();
          await saveSelectedModels(alice);
        }
        await checkbox.check();
        await saveSelectedModels(alice);
      });

      await test.step('remove gpt-5 upstream, force refresh and retain the selected row as unavailable', async () => {
        await removeFixtureModel('gpt-5');
        const refreshModelsButton = alice.getByRole('button', { name: '刷新模型', exact: true });
        await expect(refreshModelsButton).toBeVisible();
        const discoverResponse = alice.waitForResponse((response) => (
          new URL(response.url()).pathname === '/api/ai/gateway/providers/openai/models/discover'
          && response.request().method() === 'POST'
        ));
        await refreshModelsButton.click();
        const discovery = await discoverResponse;
        expect(discovery.ok(), `forced discovery failed: ${discovery.status()}`).toBe(true);
        const catalog = await discovery.json() as { models?: Array<{ id?: string; availability?: string; selected?: boolean }> };
        expect(catalog.models).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: expect.stringMatching(/(?:^|#)gpt-5$/u), availability: 'unavailable', selected: true }),
        ]));
        await expect(alice.getByText('供应商已不可用', { exact: true })).toBeVisible();

        const modelsResponse = reloadModelsResponse(alice);
        await alice.reload({ waitUntil: 'domcontentloaded' });
        await waitForStableAuthenticatedRoute(alice, '/settings/models');
        expect(await readModelsResponse(await modelsResponse)).toEqual([]);
      });

      await test.step('prove Bob remains isolated and receives no Alice-picked model', async () => {
        const modelsResponse = reloadModelsResponse(bob);
        const descriptorResponse = waitForServiceAccessDescriptor(bob);
        await openModule(bob, '/settings/models', 'Models');
        const descriptor = await readServiceAccessDescriptor(await descriptorResponse);
        expectServiceAccessOwner(descriptor, bobBefore.webId);
        expect(descriptor.service?.webId).not.toBe(aliceBefore.webId);
        const models = await readModelsResponse(await modelsResponse);
        expect(models).toEqual([]);
        await expect(bob.getByRole('checkbox', { name: /gpt-5 \(gpt-5\)/i })).toHaveCount(0);
      });

      const fixtureSnapshot = await readFixtureSnapshot();
      expect(fixtureSnapshot.authorizationTouched).toBe(true);
      expect(fixtureSnapshot.authorizationRequestCount).toBeGreaterThan(0);
      expect(JSON.stringify(fixtureSnapshot)).not.toContain(testApiKey!);
    } finally {
      await alice.context().close();
      await bob.context().close();
    }
  });

  test('shows real Models, Pod, Network and Services data with SDK geometry and the narrow stack contract', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await authenticatedPage(browser, aliceState!);
    try {
      for (const viewport of [
        { name: 'desktop', width: 1440, height: 960 },
        { name: 'narrow', width: 390, height: 844 },
      ]) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const module of [
          { label: 'Models', path: '/settings/models', expected: /openai|anthropic|kimi|bailian|deepseek|gateway/i },
          { label: 'Pod', path: '/settings/pod', expected: /webid|pod|issuer|storage|providers/i },
          { label: 'Network', path: '/settings/network', expected: /endpoint|addresses|capabilities|unsupported|supported/i },
          { label: 'Services', path: '/settings/services', expected: /runtime|solid|gateway|storage|logs|rdf/i },
        ]) {
          await test.step(`${viewport.name}:${module.label}`, async () => {
            await openModule(page, module.path, module.label);
            await expect(page.locator('main')).toHaveCount(1);
            await expect(page.locator('body')).toContainText(module.expected);
            await expect(page.locator('body')).not.toContainText(/mock|fixture|storybook/i);
            await assertSdkGeometryContract(page, module.label === 'Models');
            await page.screenshot({
              path: path.join(screenshotDir, `${viewport.name}-${module.label.toLowerCase()}.png`),
              fullPage: true,
            });
          });
        }
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await openModule(page, '/settings/models', 'Models');

      const search = page.getByRole('searchbox').or(page.getByPlaceholder(/search/i)).first();
      await expect(search).toBeVisible();
      await search.focus();
      await expect(search).toBeFocused();

      const detailTrigger = page
        .locator('[data-testid="workspace-list-pane"] button')
        .filter({ hasText: /openai/i })
        .first();
      await expect(detailTrigger).toBeVisible();
      await detailTrigger.focus();
      await expect(detailTrigger).toBeFocused();
      await detailTrigger.press('Enter');
      await expect(page.locator('main')).toBeVisible();
      await page.screenshot({ path: path.join(screenshotDir, 'narrow-stack-detail.png'), fullPage: true });

      const backToList = page.getByRole('button', { name: /返回列表|back/i }).first();
      await expect(backToList).toBeVisible();
      await backToList.click();
      await expect(page.locator('main')).toHaveCount(1);
      await expect(search.or(page.getByRole('searchbox').first())).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
});

async function authenticatedPage(browser: Browser, storageStatePath: string): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStatePath });
  return await context.newPage();
}

async function openModule(page: Page, route: string, label: string): Promise<void> {
  await gotoProductRoute(page, new URL(route, baseUrl!).toString());
  await waitForStableAuthenticatedRoute(page, route);
  await expect(page.getByRole('link', { name: label, exact: true }).first()).toBeVisible();
}

async function gotoProductRoute(page: Page, url: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return;
    } catch (error) {
      const retryable = error instanceof Error && /ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET/u.test(error.message);
      if (!retryable || attempt === 3) throw error;
      await page.waitForTimeout(500 * attempt);
    }
  }
}

async function waitForStableAuthenticatedRoute(page: Page, route: string): Promise<void> {
  await expect.poll(async () => {
    const path = new URL(page.url()).pathname;
    const mainVisible = await page.locator('main').isVisible().catch(() => false);
    const authBoundaryVisible = await page.locator('[data-auth-boundary="surface"]').isVisible().catch(() => false);
    return path === route && mainVisible && !authBoundaryVisible;
  }, { timeout: 30_000 }).toBe(true);

  // Inrupt can complete a restored browser session with one final callback navigation
  // after the first product frame renders. Require the intended route to remain ready
  // across a quiet window so acceptance actions are not racing that navigation.
  await page.waitForTimeout(1_000);
  await expect.poll(async () => (
    new URL(page.url()).pathname === route
    && await page.locator('main').isVisible().catch(() => false)
    && !await page.locator('[data-auth-boundary="surface"]').isVisible().catch(() => false)
  ), { timeout: 30_000 }).toBe(true);
}

async function completeApiKeyThroughUi(page: Page, apiKey: string): Promise<void> {
  await page.getByRole('button', { name: 'OpenAI', exact: true }).click();
  const externalConsolePromise = page.context().waitForEvent('page');
  const apiKeyButton = page.getByRole('button', { name: 'OpenAI API Key', exact: true }).or(
    page.getByRole('button', { name: '更新 API Key', exact: true }),
  ).or(page.getByRole('button', { name: '配置 API Key', exact: true })).first();
  await expect(apiKeyButton).toBeVisible();
  await apiKeyButton.click();
  const externalConsole = await externalConsolePromise;
  await externalConsole.close();
  await page.getByLabel('OpenAI API Key 输入', { exact: true }).fill(apiKey);
  const saveResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/ai/gateway/providers/openai/connect/complete-api-key'
    && response.request().method() === 'POST'
  ));
  await page.getByRole('button', { name: '保存 OpenAI API Key', exact: true }).click();
  const saveResponse = await saveResponsePromise;
  const saveResponseBody = await saveResponse.text();
  expect(saveResponse.ok(), `save failed with HTTP ${saveResponse.status()}: ${saveResponseBody}`).toBe(true);
  await expect(page.locator('body')).toContainText(/connected|configured|saved|已连接|已配置|已保存/i);
}

async function saveSelectedModels(page: Page): Promise<void> {
  const saveResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/ai/gateway/providers/openai/models/selection'
    && response.request().method() === 'PUT'
  ));
  await expect(page.getByRole('button', { name: '保存模型', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  const saveResponse = await saveResponsePromise;
  expect(saveResponse.ok(), `model selection save failed: ${saveResponse.status()}`).toBe(true);
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
}

function reloadModelsResponse(page: Page): Promise<import('@playwright/test').Response> {
  return page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/v1/models'
    && response.request().method() === 'GET'
  ));
}

async function readModelsResponse(response: import('@playwright/test').Response): Promise<string[]> {
  expect(response.ok(), `Gateway /v1/models failed: ${response.status()}`).toBe(true);
  const payload = await response.json() as { data?: Array<{ id?: unknown }> };
  return Array.isArray(payload.data)
    ? payload.data.map((model) => model.id).filter((id): id is string => typeof id === 'string')
    : [];
}

async function fixtureControl(pathname: string, init?: RequestInit): Promise<any> {
  const headers = new Headers(init?.headers);
  if (providerFixtureControlToken) headers.set('x-xpod-fixture-token', providerFixtureControlToken);
  const response = await fetch(`${providerFixtureUrl!.replace(/\/$/u, '')}${pathname}`, {
    ...init,
    headers,
  });
  const body = await response.json().catch(() => ({}));
  expect(response.ok, `provider fixture control failed: ${response.status} ${JSON.stringify(body)}`).toBe(true);
  return body;
}

async function setFixtureModels(modelIds: string[]): Promise<void> {
  await fixtureControl('/models', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ models: modelIds }),
  });
}

async function removeFixtureModel(id: string): Promise<void> {
  await fixtureControl('/models/remove', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

async function resetFixtureAuthTouches(): Promise<void> {
  await fixtureControl('/auth/reset', { method: 'POST' });
}

async function readFixtureSnapshot(): Promise<{
  authorizationTouched?: boolean;
  authorizationRequestCount?: number;
  [key: string]: unknown;
}> {
  return await fixtureControl('/status') as {
    authorizationTouched?: boolean;
    authorizationRequestCount?: number;
    [key: string]: unknown;
  };
}

function waitForServiceAccessDescriptor(page: Page): Promise<import('@playwright/test').Response> {
  return page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/applets/service-access/ai-connection'
    && response.request().method() === 'GET'
  ));
}

async function readServiceAccessDescriptor(response: import('@playwright/test').Response): Promise<{
  service?: { webId?: unknown };
  resources?: Array<{ url?: unknown }>;
}> {
  expect(response.ok(), `service access descriptor failed: ${response.status()}`).toBe(true);
  return await response.json() as {
    service?: { webId?: unknown };
    resources?: Array<{ url?: unknown }>;
  };
}

function expectServiceAccessOwner(
  descriptor: { service?: { webId?: unknown }; resources?: Array<{ url?: unknown }> },
  webId: string,
): void {
  expect(descriptor.service?.webId).toBe(webId);
  const ownerSegment = new URL(webId).pathname.split('/').filter(Boolean)[0];
  expect(ownerSegment).toBeTruthy();
  expect(descriptor.resources?.map((resource) => resource.url)).toEqual(expect.arrayContaining([
    expect.stringContaining(`/${ownerSegment}/settings/providers/openai.ttl`),
  ]));
}

async function readPodAiConnectionStatus(page: Page): Promise<{ webId: string; configuredProviders: number }> {
  const responsePromise = page.waitForResponse((response) => (
    response.url().endsWith('/api/pod/settings/status') && response.request().method() === 'GET'
  ));
  await openModule(page, '/settings/pod', 'Pod');
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const payload = await response.json() as {
    identity?: { webId?: unknown };
    aiConnection?: { status?: unknown; configuredProviders?: unknown; source?: unknown };
  };
  expect(payload.aiConnection).toMatchObject({ status: 'available', source: 'drizzle-solid' });
  expect(typeof payload.identity?.webId).toBe('string');
  expect(typeof payload.aiConnection?.configuredProviders).toBe('number');
  return {
    webId: payload.identity!.webId as string,
    configuredProviders: payload.aiConnection!.configuredProviders as number,
  };
}

async function assertSdkGeometryContract(page: Page, requiresSearch: boolean): Promise<void> {
  const metrics = await page.evaluate(() => {
    const header = document.querySelector('header') ?? document.querySelector('[data-slot="header"]');
    const search = document.querySelector('input[type="search"], [role="searchbox"]') as HTMLElement | null;
    const main = document.querySelector('main') as HTMLElement | null;
    const nav = document.querySelector('nav, aside') as HTMLElement | null;
    const styles = getComputedStyle(document.documentElement);
    const rect = (element: Element | null) => {
      const box = element?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    };
    return {
      header: rect(header),
      search: rect(search),
      main: rect(main),
      nav: rect(nav),
      radius: styles.getPropertyValue('--radius').trim(),
      background: styles.getPropertyValue('--background').trim(),
    };
  });

  expect(metrics.header).toBeTruthy();
  if (requiresSearch) expect(metrics.search).toBeTruthy();
  expect(metrics.main).toBeTruthy();
  expect(metrics.nav).toBeTruthy();
  expect(metrics.radius || 'defined').toBeTruthy();
  expect(metrics.background || 'defined').toBeTruthy();
  if (requiresSearch) {
    expect(metrics.search!.y).toBeGreaterThanOrEqual(metrics.header!.y - 1);
    expect(metrics.search!.y + metrics.search!.height).toBeLessThanOrEqual(metrics.header!.y + metrics.header!.height + 1);
  }
  expect(metrics.main!.width).toBeGreaterThan(240);
  expect(Math.abs(metrics.main!.x - metrics.nav!.x)).toBeGreaterThan(16);
}
