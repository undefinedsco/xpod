#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { startBrowserExternalRp } from '../tests/helpers/browserExternalRp';
import { authorizeRcSession, type RcIdentity, type RcRp } from '../tests/helpers/rcLightWeb';

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
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });

  const aliceStatePath = path.join(options.stateDir, 'alice-state.json');
  const bobStatePath = path.join(options.stateDir, 'bob-state.json');
  await (options.browserStateWriter ?? writeSolidOidcBrowserStates)({
    baseUrl,
    alice: accounts.alice,
    bob: accounts.bob,
    aliceStatePath,
    bobStatePath,
  });

  await writeFile(options.outputEnvPath, [
    `XPOD_SETTINGS_E2E_BASE_URL=${shellQuote(baseUrl.replace(/\/$/, ''))}`,
    `XPOD_SETTINGS_E2E_ALICE_STATE=${shellQuote(aliceStatePath)}`,
    `XPOD_SETTINGS_E2E_BOB_STATE=${shellQuote(bobStatePath)}`,
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });

  return {
    aliceStatePath,
    bobStatePath,
  };
}

export async function writeSolidOidcBrowserStates(input: RcBrowserStateWriterInput): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  let rp: RcRp | undefined;
  try {
    rp = await startBrowserExternalRp(input.baseUrl);
    const alice = await writeSolidOidcBrowserState(browser, rp, input.baseUrl, input.alice, input.aliceStatePath);
    const bob = await writeSolidOidcBrowserState(browser, rp, input.baseUrl, input.bob, input.bobStatePath);
    if (alice.accountId === bob.accountId || alice.webId === bob.webId || alice.storageUrl === bob.storageUrl) {
      throw new Error('RC seeds did not authenticate as two distinct Pod owners');
    }
  } finally {
    try { await rp?.close(); } finally { await browser.close(); }
  }
}

async function writeSolidOidcBrowserState(browser: Browser, rp: RcRp, baseUrl: string,
  account: RcSeedAccount, statePath: string): Promise<RcIdentity> {
  const context = await browser.newContext();
  try {
    const session = await authorizeRcSession(await context.newPage(), rp, baseUrl, account);
    // Only browser-managed Account Cookies/storage are persisted. RP tokens and
    // DPoP keys stay in this process; the sidecar is public identity evidence.
    await writeFile(statePath, JSON.stringify(await context.storageState()), { encoding: 'utf8', mode: 0o600 });
    await writeFile(`${statePath}.identity.json`, JSON.stringify(session.identity), { encoding: 'utf8', mode: 0o600 });
    return session.identity;
  } finally {
    await context.close();
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
