#!/usr/bin/env bun
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';

export interface RcSeedAccount {
  email: string;
  password: string;
  podName: string;
}

export interface RcSeedAccounts {
  alice: RcSeedAccount;
  bob: RcSeedAccount;
}

export interface PrepareRcAuthenticatedSmokeOptions {
  baseUrl: string;
  seedConfigPath: string;
  outputEnvPath: string;
  stateDir: string;
  browserStateWriter?: RcBrowserStateWriter;
  testProviderApiKeyFactory?: () => string;
}

export interface RcBrowserStateWriterInput {
  baseUrl: string;
  alice: RcSeedAccount;
  bob: RcSeedAccount;
  aliceStatePath: string;
  bobStatePath: string;
}

export type RcBrowserStateWriter = (input: RcBrowserStateWriterInput) => Promise<void>;

export interface PrepareRcAuthenticatedSmokeResult {
  aliceStatePath: string;
  bobStatePath: string;
  alicePodUrl: string;
  testApiKeyHash: string;
}

interface SeedConfigEntry {
  email?: unknown;
  password?: unknown;
  pods?: unknown;
}

export async function loadRcSeedAccounts(seedConfigPath: string): Promise<RcSeedAccounts> {
  const raw = await readFile(seedConfigPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('RC seed config must be an array');
  }

  const accounts = parsed
    .map((entry) => normalizeSeedAccount(entry as SeedConfigEntry))
    .filter((entry): entry is RcSeedAccount => entry !== undefined);
  const alice = accounts.find((account) => /(^|[._+-])alice([@._+-]|$)/i.test(account.email) || account.podName === 'alice');
  const bob = accounts.find((account) => /(^|[._+-])bob([@._+-]|$)/i.test(account.email) || account.podName === 'bob');
  if (!alice || !bob) {
    throw new Error('RC seed config must provide both Alice and Bob accounts');
  }

  return { alice, bob };
}

export async function prepareRcAuthenticatedSmoke(
  options: PrepareRcAuthenticatedSmokeOptions,
): Promise<PrepareRcAuthenticatedSmokeResult> {
  const baseUrl = ensureTrailingSlash(options.baseUrl);
  const accounts = await loadRcSeedAccounts(options.seedConfigPath);
  await mkdir(options.stateDir, { recursive: true });

  const testApiKey = (options.testProviderApiKeyFactory ?? createTestProviderApiKey)();

  const aliceStatePath = path.join(options.stateDir, 'alice-state.json');
  const bobStatePath = path.join(options.stateDir, 'bob-state.json');
  await (options.browserStateWriter ?? writeSolidOidcBrowserStates)({
    baseUrl,
    alice: accounts.alice,
    bob: accounts.bob,
    aliceStatePath,
    bobStatePath,
  });

  const alicePodUrl = new URL(`/${accounts.alice.podName}/`, baseUrl).toString();
  await writeFile(options.outputEnvPath, [
    `XPOD_SETTINGS_E2E_BASE_URL=${shellQuote(baseUrl.replace(/\/$/, ''))}`,
    `XPOD_SETTINGS_E2E_ALICE_STATE=${shellQuote(aliceStatePath)}`,
    `XPOD_SETTINGS_E2E_BOB_STATE=${shellQuote(bobStatePath)}`,
    `XPOD_SETTINGS_E2E_ALICE_POD_URL=${shellQuote(alicePodUrl)}`,
    `XPOD_SETTINGS_E2E_TEST_API_KEY=${shellQuote(testApiKey)}`,
    '',
  ].join('\n'), 'utf8');

  return {
    aliceStatePath,
    bobStatePath,
    alicePodUrl,
    testApiKeyHash: `sha256:${sha256(testApiKey)}`,
  };
}

function createTestProviderApiKey(): string {
  return `sk-rc-provider-${randomBytes(24).toString('base64url')}`;
}

export async function writeSolidOidcBrowserStates(input: RcBrowserStateWriterInput): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    await writeSolidOidcBrowserState(browser, input.baseUrl, input.alice, input.aliceStatePath);
    await writeSolidOidcBrowserState(browser, input.baseUrl, input.bob, input.bobStatePath);
  } finally {
    await browser.close();
  }
}

async function writeSolidOidcBrowserState(
  browser: Browser,
  baseUrl: string,
  account: RcSeedAccount,
  statePath: string,
): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(new URL('/settings/models', baseUrl).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    const loginButton = page.getByRole('button', { name: /^登录$|^login$/i }).first();
    await loginButton.click({ timeout: 30_000 });
    await completeSolidOidcLogin(page, baseUrl, account, 90_000);
    // The route-level WebIdAuthBoundary renders its unauthenticated surface as
    // `[data-auth-surface-mode="page"]`; once the session is authenticated the
    // protected route's `main` element renders and that surface disappears.
    await page.waitForFunction(() => (
      document.querySelector('main') !== null
      && document.querySelector('[data-auth-surface-mode="page"]') === null
    ), undefined, { timeout: 30_000 });
    await context.storageState({ path: statePath });
  } finally {
    await context.close();
  }
}

async function completeSolidOidcLogin(
  page: Page,
  baseUrl: string,
  account: RcSeedAccount,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const targetOrigin = new URL(baseUrl).origin;
  let submittedPassword = false;

  while (Date.now() < deadline) {
    const current = new URL(page.url());
    if (
      current.origin === targetOrigin
      && current.pathname.startsWith('/settings/')
      && await page.locator('main').isVisible({ timeout: 300 }).catch(() => false)
      && !await page.locator('[data-auth-surface-mode="page"]').isVisible({ timeout: 300 }).catch(() => false)
    ) {
      return;
    }

    const passwordSubmission = await trySubmitSolidPassword(page, account);
    if (passwordSubmission !== undefined) {
      submittedPassword ||= passwordSubmission;
      await page.waitForTimeout(400);
      continue;
    }

    const action = page.getByRole('button', {
      name: /authorize|allow|approve|consent|continue|submit|yes|log in|login|授权|允许|继续|确认/i,
    }).first();
    if (await action.isVisible({ timeout: 300 }).catch(() => false)) {
      await clickSolidOidcAction(action);
      await page.waitForTimeout(400);
      continue;
    }

    await page.waitForTimeout(300);
  }

  const current = new URL(page.url());
  const mainVisible = await page.locator('main').isVisible({ timeout: 300 }).catch(() => false);
  const authSurfaceVisible = await page.locator('[data-auth-surface-mode="page"]').isVisible({ timeout: 300 }).catch(() => false);
  throw new Error([
    'OIDC login did not finish for seeded account',
    `submittedPassword=${submittedPassword}`,
    `currentOrigin=${current.origin}`,
    `currentPath=${current.pathname}`,
    `mainVisible=${mainVisible}`,
    `authSurfaceVisible=${authSurfaceVisible}`,
  ].join('; '));
}

export async function clickSolidOidcAction(action: Locator): Promise<void> {
  await action.click({
    noWaitAfter: true,
    timeout: 5_000,
  });
}

export async function trySubmitSolidPassword(
  page: Page,
  account: RcSeedAccount,
): Promise<boolean | undefined> {
  const emailInput = page.locator('input[name="email"], input[type="email"], input#email').first();
  const passwordInput = page.locator('input[name="password"], input[type="password"], input#password').first();
  if (
    !await emailInput.isVisible({ timeout: 300 }).catch(() => false)
    || !await passwordInput.isVisible({ timeout: 300 }).catch(() => false)
  ) {
    return undefined;
  }

  try {
    await emailInput.fill(account.email, { timeout: 2_000 });
    await passwordInput.fill(account.password, { timeout: 2_000 });
    await passwordInput.press('Enter', { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function normalizeSeedAccount(entry: SeedConfigEntry): RcSeedAccount | undefined {
  if (!entry || typeof entry.email !== 'string' || typeof entry.password !== 'string') {
    return undefined;
  }
  const podName = firstPodName(entry.pods);
  if (!podName) {
    return undefined;
  }
  return {
    email: entry.email,
    password: entry.password,
    podName,
  };
}

function firstPodName(pods: unknown): string | undefined {
  if (!Array.isArray(pods)) {
    return undefined;
  }
  for (const pod of pods) {
    if (pod && typeof pod === 'object' && typeof (pod as Record<string, unknown>).name === 'string') {
      const name = ((pod as Record<string, unknown>).name as string).trim();
      if (name) {
        return name;
      }
    }
  }
  return undefined;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv: string[]): PrepareRcAuthenticatedSmokeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('usage: prepare-rc-authenticated-smoke --base-url URL --seed-config PATH --output-env PATH --state-dir PATH');
    }
    values.set(key, value);
  }
  const options = {
    baseUrl: values.get('--base-url'),
    seedConfigPath: values.get('--seed-config'),
    outputEnvPath: values.get('--output-env'),
    stateDir: values.get('--state-dir'),
  };
  for (const [key, value] of Object.entries(options)) {
    if (!value) {
      throw new Error(`${key} is required`);
    }
  }
  return options as PrepareRcAuthenticatedSmokeOptions;
}

if (import.meta.main) {
  try {
    const result = await prepareRcAuthenticatedSmoke(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`[prepare-rc-authenticated-smoke] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
