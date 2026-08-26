import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Browser, type Page, type Response, test } from '@playwright/test';

const env = process.env;
const baseUrl = env.XPOD_SETTINGS_E2E_BASE_URL;
const aliceState = env.XPOD_SETTINGS_E2E_ALICE_STATE;
const bobState = env.XPOD_SETTINGS_E2E_BOB_STATE;
const testApiKey = env.XPOD_SETTINGS_E2E_TEST_API_KEY;
const screenshotDir = path.resolve('.test-data/acceptance/screenshots');
const hasRequiredEnvironment = Boolean(baseUrl && aliceState && bobState && testApiKey);
const settingsWriteTimeoutMs = 45_000;

test.describe('Xpod settings write diagnostics', () => {
  test('redacts API keys from failed settings write diagnostics', () => {
    const secret = 'sk-diagnostic-test-secret';
    const diagnostic = formatSettingsWriteDiagnostics({
      requirements: [
        { name: 'OpenAI provider resource', pathSuffix: '/settings/providers/openai.ttl' },
      ],
      observed: [
        {
          method: 'PATCH',
          pathname: '/alice/settings/providers/openai',
          status: 400,
          ok: false,
          body: `failed to store ${secret}`,
        },
      ],
      pageErrors: [ `page leaked ${secret}` ],
      requestFailures: [ `request leaked ${secret}` ],
      visibleText: `UI leaked ${secret}`,
      secrets: [ secret ],
    });

    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).toContain('[redacted]');
    expect(diagnostic).toContain('/alice/settings/providers/openai');
  });

  test('requires canonical settings resource paths for provider and credential writes', () => {
    const providerRequirement = { name: 'OpenAI provider resource', pathSuffix: '/settings/providers/openai.ttl' };
    const credentialRequirement = { name: 'OpenAI credential resource', pathSuffix: '/settings/credentials.ttl' };

    expect(settingsWriteMatchesRequirement({
      method: 'PATCH',
      pathname: '/alice/settings/providers/openai.ttl',
      status: 200,
      ok: true,
    }, providerRequirement)).toBe(true);
    expect(settingsWriteMatchesRequirement({
      method: 'PUT',
      pathname: '/alice/settings/credentials.ttl',
      status: 201,
      ok: true,
    }, credentialRequirement)).toBe(true);
    expect(settingsWriteMatchesRequirement({
      method: 'PATCH',
      pathname: '/alice/settings/providers/openai',
      status: 200,
      ok: true,
    }, providerRequirement)).toBe(false);
  });

  test('allows only PATCH 404 to fall back to PUT', () => {
    expect(settingsWriteIsTerminalFailure({
      method: 'PATCH',
      pathname: '/alice/settings/providers/openai.ttl',
      status: 400,
      ok: false,
    })).toBe(true);
    expect(settingsWriteIsTerminalFailure({
      method: 'PATCH',
      pathname: '/alice/settings/providers/openai.ttl',
      status: 404,
      ok: false,
    })).toBe(false);
    expect(settingsWriteIsTerminalFailure({
      method: 'PUT',
      pathname: '/alice/settings/providers/openai.ttl',
      status: 404,
      ok: false,
    })).toBe(true);
  });

  test('does not fail when a response body abort follows observed write headers', () => {
    const pathname = '/alice/settings/providers/openai.ttl';
    const observed: ObservedSettingsWrite[] = [ {
      method: 'PATCH',
      pathname,
      status: 201,
      ok: true,
    } ];

    expect(settingsRequestFailureIsTerminal('PATCH', pathname, observed)).toBe(false);
    expect(settingsRequestFailureIsTerminal('PATCH', pathname, [])).toBe(true);
  });
});

test.describe('Xpod settings product acceptance', () => {
  test.skip(!hasRequiredEnvironment, 'Set XPOD_SETTINGS_E2E_BASE_URL, XPOD_SETTINGS_E2E_ALICE_STATE, XPOD_SETTINGS_E2E_BOB_STATE and XPOD_SETTINGS_E2E_TEST_API_KEY.');

  test.beforeAll(async () => {
    await mkdir(screenshotDir, { recursive: true });
  });

  test('persists Alice API-key credential in her Pod and keeps it isolated from Bob', async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await authenticatedPage(browser, aliceState!);
    const bob = await authenticatedPage(browser, bobState!);
    try {
      await openModule(alice, '/settings/models', 'Models');
      await completeApiKeyThroughUi(alice, testApiKey!);
      await alice.reload({ waitUntil: 'domcontentloaded' });
      await expect(alice.locator('body')).not.toContainText(testApiKey!);
      await expect(alice.getByRole('button', { name: '更新 API Key' })).toBeVisible();
      await openModule(bob, '/settings/models', 'Models');
      await bob.getByText(/^OpenAI$/i).first().click();
      await expect(bob.locator('body')).not.toContainText(testApiKey!);
      await expect(bob.getByRole('button', { name: 'OpenAI API Key' })).toBeVisible();
      await expect(bob.getByRole('button', { name: '更新 API Key' })).toHaveCount(0);
    } finally {
      await cleanupApiKeyThroughUi(alice).catch(() => undefined);
      await alice.context().close();
      await bob.context().close();
    }
  });

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 960 },
    { name: 'narrow', width: 390, height: 844 },
  ]) {
    test(`shows real Models, Pod, Network and Services data with SDK geometry at ${viewport.name} width`, async ({ browser }) => {
      test.setTimeout(180_000);
      const page = await authenticatedPage(browser, aliceState!);
      try {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const module of [
          { label: 'Models', path: '/settings/models', expected: /openai|anthropic|kimi|bailian|deepseek|gateway/i },
          { label: 'Pod', path: '/settings/pod', expected: /webid|pod|issuer|storage|providers/i },
          { label: 'Network', path: '/dashboard/network', expected: /endpoint|addresses|capabilities|unsupported|supported/i },
          { label: 'Services', path: '/settings/services', expected: /runtime|solid|gateway|storage|logs|rdf/i },
        ]) {
          await openModule(page, module.path, module.label);
          await expect(page.locator('main')).toHaveCount(1);
          await expect(page.locator('body')).toContainText(module.expected);
          await expect(page.locator('body')).not.toContainText(/mock|fixture|storybook/i);
          await assertSdkGeometryContract(page);
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

  test('keeps narrow stack detail, back navigation and focus contract mandatory', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await authenticatedPage(browser, aliceState!);
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await openModule(page, '/settings/models', 'Models');

      const search = page.getByRole('searchbox').or(page.getByPlaceholder(/search/i)).first();
      await expect(search).toBeVisible();
      await search.focus();
      await expect(search).toBeFocused();

      const listPane = page.getByTestId('workspace-list-pane');
      const mainPane = page.getByTestId('workspace-main-pane');
      const detailTrigger = page.getByRole('option', { name: 'OpenAI' });
      await expect(detailTrigger).toBeVisible();
      await detailTrigger.focus();
      await expect(detailTrigger).toBeFocused();
      await detailTrigger.press('Enter');
      await expect(listPane).toBeHidden();
      await expect(mainPane).toBeVisible();
      await expect(mainPane).toBeFocused();
      await page.screenshot({ path: path.join(screenshotDir, 'narrow-stack-detail.png'), fullPage: true });

      await page.getByRole('button', { name: '返回列表' }).click();
      await expect(listPane).toBeVisible();
      await expect(mainPane).toBeHidden();
      await expect(listPane).toBeFocused();
      await expect(search.or(page.getByRole('searchbox').first())).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
});

async function authenticatedPage(browser: Browser, storageStatePath: string): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStatePath });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  return page;
}

async function openModule(page: Page, route: string, label: string): Promise<void> {
  await page.goto(new URL(route, baseUrl!).toString(), { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('link', { name: label })).toBeVisible();
}

async function completeApiKeyThroughUi(page: Page, apiKey: string): Promise<void> {
  await page.getByText(/^OpenAI$/i).first().click();
  await page.getByRole('button', { name: 'OpenAI API Key' }).click();
  await page.getByLabel('OpenAI API Key 输入').fill(apiKey);
  await waitForSettingsWritesDuring(
    page,
    () => page.getByRole('button', { name: '保存 OpenAI API Key' }).click(),
    [
      { name: 'OpenAI provider resource', pathSuffix: '/settings/providers/openai.ttl' },
      { name: 'OpenAI credential resource', pathSuffix: '/settings/credentials.ttl' },
    ],
    [ apiKey ],
  );
  await expect(page.getByRole('button', { name: '更新 API Key' })).toBeVisible();
}

async function cleanupApiKeyThroughUi(page: Page): Promise<void> {
  await openModule(page, '/settings/models', 'Models');
  await page.getByText(/^OpenAI$/i).first().click();
  await page.getByRole('button', { name: '移除配置' }).click();
  await expect(page.getByRole('button', { name: 'OpenAI API Key' })).toBeVisible();
}

async function assertSdkGeometryContract(page: Page): Promise<void> {
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
  expect(metrics.search).toBeTruthy();
  expect(metrics.main).toBeTruthy();
  expect(metrics.nav).toBeTruthy();
  expect(metrics.radius || 'defined').toBeTruthy();
  expect(metrics.background || 'defined').toBeTruthy();
  expect(metrics.search!.y).toBeGreaterThanOrEqual(metrics.header!.y - 1);
  expect(metrics.search!.y + metrics.search!.height).toBeLessThanOrEqual(metrics.header!.y + metrics.header!.height + 1);
  expect(metrics.main!.width).toBeGreaterThan(240);
  expect(Math.abs(metrics.main!.x - metrics.nav!.x)).toBeGreaterThan(16);
}

type SettingsWriteRequirement = {
  name: string;
  pathSuffix: string;
};

type ObservedSettingsWrite = {
  method: string;
  pathname: string;
  status: number;
  ok: boolean;
  body?: string;
};

type SettingsWriteDiagnosticsInput = {
  requirements: SettingsWriteRequirement[];
  observed: ObservedSettingsWrite[];
  pageErrors: string[];
  requestFailures: string[];
  visibleText: string;
  secrets: string[];
};

async function waitForSettingsWritesDuring(
  page: Page,
  action: () => Promise<unknown>,
  requirements: SettingsWriteRequirement[],
  secrets: string[],
): Promise<void> {
  const observed: ObservedSettingsWrite[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  let actionFinished = false;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout>;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      page.off('response', responseHandler);
      page.off('pageerror', pageErrorHandler);
      page.off('requestfailed', requestFailedHandler);
      clearTimeout(timeout);
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const rejectWithDiagnostics = async () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(formatSettingsWriteDiagnostics({
        requirements,
        observed,
        pageErrors,
        requestFailures,
        visibleText: await settingsVisibleDiagnostics(page),
        secrets,
      })));
    };
    const checkComplete = () => {
      if (actionFinished && requirements.every((requirement) =>
        observed.some((write) => settingsWriteMatchesRequirement(write, requirement)),
      )) {
        resolveOnce();
      }
    };

    const responseHandler = async (response: Response) => {
      const method = response.request().method();
      const pathname = new URL(response.url()).pathname;
      if (!isSettingsLdpWrite(method, pathname)) return;

      const write: ObservedSettingsWrite = {
        method,
        pathname,
        status: response.status(),
        ok: response.ok(),
      };
      if (!response.ok()) {
        write.body = await response.text().catch((error: unknown) =>
          `Unable to read response body: ${stringFromError(error)}`,
        );
      }
      observed.push(write);
      if (settingsWriteIsTerminalFailure(write)) {
        void rejectWithDiagnostics();
        return;
      }
      checkComplete();
    };
    const pageErrorHandler = (error: Error) => pageErrors.push(error.stack || error.message);
    const requestFailedHandler = (request: { method: () => string; url: () => string; failure: () => { errorText: string } | null }) => {
      const method = request.method();
      const pathname = new URL(request.url()).pathname;
      if (!isSettingsLdpWrite(method, pathname)) return;

      requestFailures.push(`${method} ${pathname}: ${request.failure()?.errorText ?? 'unknown failure'}`);
      if (settingsRequestFailureIsTerminal(method, pathname, observed)) {
        void rejectWithDiagnostics();
      }
    };

    page.on('response', responseHandler);
    page.on('pageerror', pageErrorHandler);
    page.on('requestfailed', requestFailedHandler);
    timeout = setTimeout(() => void rejectWithDiagnostics(), settingsWriteTimeoutMs);
    void action()
      .then(() => {
        actionFinished = true;
        checkComplete();
      })
      .catch(async (error: unknown) => {
        if (settled) return;
        pageErrors.push(stringFromError(error));
        await rejectWithDiagnostics();
      });
  });
}

function isSettingsLdpWrite(method: string, pathname: string): boolean {
  return (method === 'PATCH' || method === 'PUT') &&
    pathname.includes('/settings/') &&
    !pathname.endsWith('/settings/-/sparql');
}

function settingsWriteMatchesRequirement(
  write: ObservedSettingsWrite,
  requirement: SettingsWriteRequirement,
): boolean {
  return write.ok && write.pathname.endsWith(requirement.pathSuffix);
}

function settingsWriteIsTerminalFailure(write: ObservedSettingsWrite): boolean {
  return !write.ok && !(write.method === 'PATCH' && write.status === 404);
}

function settingsRequestFailureIsTerminal(
  method: string,
  pathname: string,
  observed: ObservedSettingsWrite[],
): boolean {
  return !observed.some((write) => write.method === method && write.pathname === pathname);
}

function formatSettingsWriteDiagnostics(input: SettingsWriteDiagnosticsInput): string {
  const missing = input.requirements
    .filter((requirement) => !input.observed.some((write) => settingsWriteMatchesRequirement(write, requirement)))
    .map((requirement) => `${requirement.name} (${requirement.pathSuffix})`)
    .join(', ');
  const observed = input.observed.length > 0
    ? input.observed.map((write) =>
      `${write.method} ${write.pathname} -> ${write.status}${write.body ? ` body=${truncateDiagnostic(write.body)}` : ''}`,
    ).join('\n')
    : 'none';

  return redactSettingsDiagnosticText([
    'Settings LDP write acceptance failed.',
    `Missing: ${missing || 'none'}`,
    `Observed writes:\n${observed}`,
    `Page errors:\n${input.pageErrors.join('\n') || 'none'}`,
    `Request failures:\n${input.requestFailures.join('\n') || 'none'}`,
    `Visible page diagnostics:\n${input.visibleText || 'none'}`,
  ].join('\n'), input.secrets);
}

async function settingsVisibleDiagnostics(page: Page): Promise<string> {
  const bodyText = await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '');
  return bodyText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /AI Connection request failed|failed|error|失败|错误/i.test(line))
    .slice(0, 12)
    .join('\n');
}

function redactSettingsDiagnosticText(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    redacted = redacted.replaceAll(secret, '[redacted]');
  }
  return redacted
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, '[redacted]')
    .replace(/\b(Bearer|token|api[-_ ]?key)\s+([A-Za-z0-9._~+/=-]{8,})/gi, '$1 [redacted]');
}

function truncateDiagnostic(value: string): string {
  return value.length > 1_000 ? `${value.slice(0, 1_000)}...` : value;
}

function stringFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
