import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canAdvanceSolidOidcAt,
  clickSolidOidcAction,
  isCanonicalAiConnectionsUrl,
  loadRcSeedAccounts,
  prepareRcAuthenticatedSmoke,
  trySubmitSolidPassword,
  verifySeedProfileStorageBinding,
} from '../../scripts/prepare-rc-authenticated-smoke';

const defaultFetch = globalThis.fetch;

describe('RC authenticated smoke seed preparation', () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    globalThis.fetch = defaultFetch;
    vi.restoreAllMocks();
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('does not wait on the obsolete OIDC page after consent redirects to settings', async () => {
    const action = {
      click: vi.fn(async () => undefined),
    } as any;

    await clickSolidOidcAction(action);

    expect(action.click).toHaveBeenCalledWith({
      noWaitAfter: true,
      timeout: 5_000,
    });
  });

  it('recognizes the canonical AI Connections route and never advances its inner login card', () => {
    const baseUrl = 'https://id-rc.undefineds.co/';

    expect(isCanonicalAiConnectionsUrl(
      new URL('https://id-rc.undefineds.co/ai-connections'),
      baseUrl,
    )).toBe(true);
    expect(isCanonicalAiConnectionsUrl(
      new URL('https://id-rc.undefineds.co/ai-connections/openai'),
      baseUrl,
    )).toBe(true);
    expect(canAdvanceSolidOidcAt(
      new URL('https://id-rc.undefineds.co/ai-connections'),
      baseUrl,
    )).toBe(false);
    expect(canAdvanceSolidOidcAt(
      new URL('https://id-rc.undefineds.co/.account/oidc/consent/'),
      baseUrl,
    )).toBe(true);
    expect(canAdvanceSolidOidcAt(
      new URL('https://accounts.example/authorize'),
      baseUrl,
    )).toBe(true);
  });

  it('retries a login form replaced between visibility and password fill', async () => {
    const emailInput = {
      isVisible: vi.fn(async () => true),
      fill: vi.fn(async () => undefined),
    };
    const passwordInput = {
      isVisible: vi.fn(async () => true),
      fill: vi.fn()
        .mockRejectedValueOnce(new Error('element was detached'))
        .mockResolvedValueOnce(undefined),
      press: vi.fn(async () => undefined),
    };
    const page = {
      locator: vi.fn((selector: string) => ({
        first: () => selector.includes('password') ? passwordInput : emailInput,
      })),
    } as any;
    const account = { email: 'alice@example.com', password: 'private', podName: 'alice' };

    await expect(trySubmitSolidPassword(page, account)).resolves.toBe(false);
    await expect(trySubmitSolidPassword(page, account)).resolves.toBe(true);
    expect(passwordInput.press).toHaveBeenCalledWith('Enter', { timeout: 2_000 });
  });

  it('loads only named Alice and Bob accounts from the fixed RC seed config', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-rc-smoke-'));
    const seedPath = path.join(tempRoot, 'seed.json');
    await writeFile(seedPath, JSON.stringify([
      { email: 'alice@rc.example', password: 'alice-pass', pods: [{ name: 'alice' }] },
      { email: 'bob@rc.example', password: 'bob-pass', pods: [{ name: 'bob' }] },
      { email: 'carol@rc.example', password: 'carol-pass', pods: [{ name: 'carol' }] },
    ]));

    expect(await loadRcSeedAccounts(seedPath)).toEqual({
      alice: {
        email: 'alice@rc.example',
        password: 'alice-pass',
        podName: 'alice',
      },
      bob: {
        email: 'bob@rc.example',
        password: 'bob-pass',
        podName: 'bob',
      },
    });
  });

  it('rejects a seed config that does not provide both Alice and Bob', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-rc-smoke-'));
    const seedPath = path.join(tempRoot, 'seed.json');
    await writeFile(seedPath, JSON.stringify([
      { email: 'alice@rc.example', password: 'alice-pass', pods: [{ name: 'alice' }] },
    ]));

    await expect(loadRcSeedAccounts(seedPath)).rejects.toThrow(/Alice and Bob/i);
  });

  it('performs real browser OIDC state preparation without inventing Pod URLs or unused credentials', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-rc-smoke-'));
    const seedPath = path.join(tempRoot, 'seed.json');
    const outputEnvPath = path.join(tempRoot, 'smoke.env');
    const stateDir = path.join(tempRoot, 'state');
    await writeFile(seedPath, JSON.stringify([
      { email: 'alice@rc.example', password: 'alice-pass', pods: [{ name: 'alice' }] },
      { email: 'bob@rc.example', password: 'bob-pass', pods: [{ name: 'bob' }] },
    ]));

    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error(`unexpected fetch ${String(input)}`);
    }) as unknown as typeof fetch;
    const browserStateCalls: unknown[] = [];
    const result = await prepareRcAuthenticatedSmoke({
      baseUrl: 'https://id-rc.undefineds.co',
      seedConfigPath: seedPath,
      outputEnvPath,
      stateDir,
      browserStateWriter: async (input) => {
        browserStateCalls.push(input);
        await writeFile(input.aliceStatePath, JSON.stringify({ oidc: 'alice' }));
        await writeFile(input.bobStatePath, JSON.stringify({ oidc: 'bob' }));
      },
    });

    expect(result).toEqual({
      aliceStatePath: path.join(stateDir, 'alice-state.json'),
      bobStatePath: path.join(stateDir, 'bob-state.json'),
    });
    expect(browserStateCalls).toEqual([{
      baseUrl: 'https://id-rc.undefineds.co/',
      alice: {
        email: 'alice@rc.example',
        password: 'alice-pass',
        podName: 'alice',
      },
      bob: {
        email: 'bob@rc.example',
        password: 'bob-pass',
        podName: 'bob',
      },
      aliceStatePath: result.aliceStatePath,
      bobStatePath: result.bobStatePath,
    }]);
    expect(JSON.parse(await readFile(result.aliceStatePath, 'utf8'))).toEqual({ oidc: 'alice' });
    expect(JSON.parse(await readFile(result.bobStatePath, 'utf8'))).toEqual({ oidc: 'bob' });
    expect(calls).toHaveLength(0);
    const envFile = await readFile(outputEnvPath, 'utf8');
    expect(envFile).toContain(`XPOD_SETTINGS_E2E_ALICE_STATE='${result.aliceStatePath}'`);
    expect(envFile).toContain(`XPOD_SETTINGS_E2E_BOB_STATE='${result.bobStatePath}'`);
    expect(envFile).not.toContain('XPOD_SETTINGS_E2E_ALICE_POD_URL');
    expect(envFile).not.toContain('XPOD_SETTINGS_E2E_TEST_API_KEY');
  });

  it('requires each prepared account profile to publicly advertise its storage', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      `<https://id-rc.undefineds.co/bob/profile/card#me> <http://www.w3.org/ns/solid/terms#storage> <https://id-rc.undefineds.co/bob/> .`,
      { status: 200, headers: { 'content-type': 'text/turtle' } },
    ));

    await expect(verifySeedProfileStorageBinding({
      baseUrl: 'https://id-rc.undefineds.co/',
      account: { email: 'bob@rc.example', password: 'private', podName: 'bob' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledWith('https://id-rc.undefineds.co/bob/profile/card#me', expect.any(Object));
  });

  it('reports the profile status when a prepared account profile is not public', async () => {
    const fetchImpl = vi.fn(async () => new Response('Not logged in', {
      status: 401,
      headers: { 'content-type': 'text/plain' },
    }));

    await expect(verifySeedProfileStorageBinding({
      baseUrl: 'https://id-rc.undefineds.co/',
      account: { email: 'bob@rc.example', password: 'private', podName: 'bob' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/not publicly readable; status=401/i);
  });
});
