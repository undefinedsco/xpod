import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadRcSeedAccounts, prepareRcAuthenticatedSmoke, writeSolidOidcBrowserStates } from '../../scripts/prepare-rc-authenticated-smoke';

import { chromium } from 'playwright';
import * as externalRp from '../helpers/browserExternalRp';
import * as lightWeb from '../helpers/rcLightWeb';

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

  it('delegates seed credentials and state paths without inventing Pod URLs or unused credentials', async () => {
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

  it('persists only browser storage and safe identity from the shared real-RP driver', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-rc-smoke-'));
    const close = vi.fn(async () => undefined);
    const contexts = ['alice', 'bob'].map(name => ({
      newPage: vi.fn(async () => ({ name })), close: vi.fn(async () => undefined),
      storageState: vi.fn(async () => ({ cookies: [{ name: 'account', value: `fixture-${name}`, httpOnly: true }], origins: [] })),
    }));
    vi.spyOn(chromium, 'launch').mockResolvedValue({ close, newContext: vi.fn()
      .mockResolvedValueOnce(contexts[0]).mockResolvedValueOnce(contexts[1]) } as any);
    const rp = { close: vi.fn(async () => undefined) };
    vi.spyOn(externalRp, 'startBrowserExternalRp').mockResolvedValue(rp as any);
    const authorize = vi.spyOn(lightWeb, 'authorizeRcSession').mockImplementation(async page => ({
      identity: { accountId: (page as any).name, webId: `https://id.example/${(page as any).name}/profile/card#me`,
        storageUrl: `https://pods.example/${(page as any).name}/` },
      authenticatedFetch: vi.fn() as any,
    }));
    const aliceStatePath = path.join(tempRoot, 'alice-state.json');
    const bobStatePath = path.join(tempRoot, 'bob-state.json');
    await writeSolidOidcBrowserStates({ baseUrl: 'https://id.example/',
      alice: { email: 'alice@example.com', password: 'SYNTHETIC_SECRET', podName: 'alice' },
      bob: { email: 'bob@example.com', password: 'SYNTHETIC_SECRET', podName: 'bob' }, aliceStatePath, bobStatePath });
    expect(authorize).toHaveBeenCalledTimes(2);
    for (const statePath of [aliceStatePath, bobStatePath]) {
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
      expect((await stat(`${statePath}.identity.json`)).mode & 0o777).toBe(0o600);
      const identity = await readFile(`${statePath}.identity.json`, 'utf8');
      expect(Object.keys(JSON.parse(identity)).sort()).toEqual(['accountId', 'storageUrl', 'webId']);
      expect(identity).not.toContain('SYNTHETIC_SECRET');
    }
    expect(close).toHaveBeenCalledOnce();
    expect(rp.close).toHaveBeenCalledOnce();
    expect(contexts.every(context => context.close.mock.calls.length === 1)).toBe(true);
  });
});
