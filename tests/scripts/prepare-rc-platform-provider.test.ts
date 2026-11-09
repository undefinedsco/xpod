import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PlatformProviderError,
  assertOwnedCredentialResource,
  cleanupPlatformProvider,
  createPlatformProvider,
  createPlatformProviderForAccount,
  requirePlatformOrigin,
  requireRcBaseUrl,
  safeSummary,
} from '../../scripts/prepare-rc-platform-provider';

const RC = 'https://id-rc.undefineds.cn';
const ACCOUNT = { id: 'account-alice', webId: 'https://id-rc.undefineds.cn/alice/profile/card#me', storageUrl: 'https://pods-rc.undefineds.cn/alice/' };
const CREDENTIAL_ID = 'cred-abc123';
const CREDENTIAL_RESOURCE = `${RC}/.account/account/alice/client-credentials/${CREDENTIAL_ID}/`;

interface Fixture {
  fetches: string[];
  deletes: string[];
  issuedBodies: unknown[];
  modelsCalls: number;
  resourceExists: boolean;
  modelsStatus?: number;
  modelsBody?: unknown;
  redirect?: boolean;
}

function baseFetch(state: Fixture): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? 'GET';
    state.fetches.push(`${method} ${url.pathname}`);
    if (state.redirect) {
      return new Response('', { status: 302, headers: { location: 'https://evil.test/' } });
    }
    if (method === 'POST' && url.pathname === '/.account/login/password/') {
      return Response.json({ authorization: 'account-token-fixture' });
    }
    if (method === 'GET' && url.pathname === '/.account/') {
      return Response.json({ controls: {
        account: {
          id: ACCOUNT.id,
          bindings: `${RC}/.account/account/alice/bindings/`,
          clientCredentials: `${RC}/.account/account/alice/client-credentials/`,
        },
      } });
    }
    if (method === 'GET' && url.pathname === '/.account/account/alice/bindings/') {
      return Response.json({ bindings: [{ webId: ACCOUNT.webId, storageUrl: ACCOUNT.storageUrl }] });
    }
    if (method === 'POST' && url.pathname === '/.account/account/alice/client-credentials/') {
      state.issuedBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return Response.json({ id: CREDENTIAL_ID, secret: 'fixture-secret', resource: CREDENTIAL_RESOURCE }, { status: 201 });
    }
    if (method === 'GET' && url.pathname === '/v1/models') {
      state.modelsCalls++;
      return Response.json(state.modelsBody ?? { data: [{ id: 'linx' }, { id: 'linx-lite' }] }, { status: state.modelsStatus ?? 200 });
    }
    if (url.pathname === `/.account/account/alice/client-credentials/${CREDENTIAL_ID}/`) {
      if (method === 'DELETE') {
        state.deletes.push(url.pathname);
        if (!state.resourceExists) return new Response(null, { status: 404 });
        state.resourceExists = false;
        return new Response(null, { status: 204 });
      }
      if (method === 'GET') {
        if (!state.resourceExists) return new Response('', { status: 404 });
        return Response.json({ id: CREDENTIAL_ID, name: state.issuedBodies.at(-1) && (state.issuedBodies.at(-1) as { name?: string }).name });
      }
    }
    return new Response('', { status: 500 });
  }) as typeof fetch;
}

function newFixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    fetches: [],
    deletes: [],
    issuedBodies: [],
    modelsCalls: 0,
    resourceExists: true,
    ...overrides,
  };
}

describe('prepare RC platform provider', () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  async function paths() {
    root = await mkdtemp(path.join(os.tmpdir(), 'xpod-platform-provider-'));
    const seed = path.join(root, 'seed.json');
    await writeFile(seed, JSON.stringify([
      { email: 'alice@rc.example', password: 'alice-fixture-pass', pods: [{ name: 'alice' }] },
      { email: 'bob@rc.example', password: 'bob-fixture-pass', pods: [{ name: 'bob' }] },
    ]));
    return {
      seed,
      keyFile: path.join(root, 'provider.conf'),
      receiptFile: path.join(root, 'receipt.json'),
    };
  }

  it('requires the exact deployed RC HTTPS origin', () => {
    expect(requireRcBaseUrl(`${RC}/`).origin).toBe(RC);
    for (const value of ['http://id-rc.undefineds.cn/', 'https://id-rc.undefineds.cn/path', 'https://evil.test/',
      'https://id-rc.undefineds.cn:8443/', 'https://user:pass@id-rc.undefineds.cn/']) {
      expect(() => requireRcBaseUrl(value)).toThrow(PlatformProviderError);
    }
  });

  it('rejects a credential resource outside the RC Account authority or wrong id', () => {
    const base = new URL(`${RC}/`);
    expect(assertOwnedCredentialResource(`/.account/account/alice/client-credentials/${CREDENTIAL_ID}/`, base, CREDENTIAL_ID))
      .toBe(CREDENTIAL_RESOURCE);
    for (const raw of [
      `https://evil.test/.account/account/alice/client-credentials/${CREDENTIAL_ID}/`,
      `https://id-rc.undefineds.cn/other/${CREDENTIAL_ID}/`,
      `https://id-rc.undefineds.cn/.account/account/alice/client-credentials/${CREDENTIAL_ID}/?x=1`,
    ]) {
      expect(() => assertOwnedCredentialResource(raw, base, CREDENTIAL_ID)).toThrow(PlatformProviderError);
    }
    expect(() => assertOwnedCredentialResource(CREDENTIAL_RESOURCE, base, 'other-id')).toThrow(PlatformProviderError);
  });

  it('issues one normal Account client credential, proves real models, and writes 0600 owned files', async () => {
    const files = await paths();
    const state = newFixture();
    await createPlatformProvider({
      baseUrl: `${RC}/`, seedConfigPath: files.seed, keyFile: files.keyFile, receiptFile: files.receiptFile,
      fetchImpl: baseFetch(state), nonce: 'rc-platform-provider-testnonce', now: () => new Date('2026-11-09T00:00:00.000Z'),
    });

    const config = await readFile(files.keyFile, 'utf8');
    expect(config).toBe([
      'provider=custom',
      `apiKey=sk-${Buffer.from(`${CREDENTIAL_ID}:fixture-secret`).toString('base64')}`,
      `baseUrl=${RC}/v1`,
      'expectedModels=linx-lite',
      '',
    ].join('\n'));
    expect((await stat(files.keyFile)).mode & 0o777).toBe(0o600);
    expect((await stat(files.receiptFile)).mode & 0o777).toBe(0o600);
    const receipt = JSON.parse(await readFile(files.receiptFile, 'utf8'));
    expect(receipt).toEqual({
      schemaVersion: 1,
      kind: 'rc-platform-provider',
      phase: 'issued',
      id: CREDENTIAL_ID,
      nonce: 'rc-platform-provider-testnonce',
      resource: CREDENTIAL_RESOURCE,
      createdAt: '2026-11-09T00:00:00.000Z',
    });
    expect(JSON.stringify(receipt)).not.toContain('fixture-secret');
    expect(JSON.stringify(receipt)).not.toContain('alice@rc.example');
    expect(state.modelsCalls).toBe(1);
    expect(state.issuedBodies).toEqual([{ name: 'rc-platform-provider-testnonce', webId: ACCOUNT.webId }]);
    expect(state.deletes).toEqual([]);
  });

  it('refuses to overwrite existing key or receipt outputs before issuing anything', async () => {
    const files = await paths();
    await writeFile(files.keyFile, 'foreign\n', { mode: 0o600 });
    const state = newFixture();
    await expect(createPlatformProvider({
      baseUrl: `${RC}/`, seedConfigPath: files.seed, keyFile: files.keyFile, receiptFile: files.receiptFile,
      fetchImpl: baseFetch(state),
    })).rejects.toMatchObject({ reason: 'output-exists' });
    expect(state.fetches).toEqual([]);
    expect(await readFile(files.keyFile, 'utf8')).toBe('foreign\n');
  });

  it('revokes the issued credential and writes no key when models discovery fails', async () => {
    const files = await paths();
    const state = newFixture({ modelsStatus: 404, modelsBody: { error: 'not found' } });
    await expect(createPlatformProvider({
      baseUrl: `${RC}/`, seedConfigPath: files.seed, keyFile: files.keyFile, receiptFile: files.receiptFile,
      fetchImpl: baseFetch(state), nonce: 'rc-platform-provider-failmodels',
    })).rejects.toMatchObject({ reason: 'models', status: 404 });
    expect(state.deletes).toEqual([`/.account/account/alice/client-credentials/${CREDENTIAL_ID}/`]);
    await expect(stat(files.keyFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(files.receiptFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the receipt and removes the key when revocation fails after issuance', async () => {
    const files = await paths();
    const state = newFixture({ modelsStatus: 200, modelsBody: { data: [{ id: 'linx' }] } });
    const failingDelete = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (init?.method === 'DELETE' && url.pathname.includes('/client-credentials/')) {
        return Promise.resolve(new Response('', { status: 500 }));
      }
      return baseFetch(state)(input, init);
    }) as typeof fetch;
    await expect(createPlatformProvider({
      baseUrl: `${RC}/`, seedConfigPath: files.seed, keyFile: files.keyFile, receiptFile: files.receiptFile,
      fetchImpl: failingDelete, nonce: 'rc-platform-provider-revoke-fail',
    })).rejects.toMatchObject({ reason: 'revoke-failed', status: 500 });
    await expect(stat(files.keyFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const receipt = JSON.parse(await readFile(files.receiptFile, 'utf8'));
    expect(receipt.id).toBe(CREDENTIAL_ID);
    expect(receipt.resource).toBe(CREDENTIAL_RESOURCE);
    expect(JSON.stringify(receipt)).not.toContain('fixture-secret');
  });

  it('cleans up an issued credential after the same seed login and removes only owned files', async () => {
    const files = await paths();
    const state = newFixture();
    await createPlatformProvider({
      baseUrl: `${RC}/`, seedConfigPath: files.seed, keyFile: files.keyFile, receiptFile: files.receiptFile,
      fetchImpl: baseFetch(state), nonce: 'rc-platform-provider-cleanup',
    });
    const summary = await cleanupPlatformProvider({
      baseUrl: `${RC}/`, seedConfigPath: files.seed, keyFile: files.keyFile, receiptFile: files.receiptFile,
      fetchImpl: baseFetch(state),
    });
    expect(summary).toEqual({ phase: 'cleanup', ok: true, reason: 'revoked' });
    expect(state.deletes).toEqual([`/.account/account/alice/client-credentials/${CREDENTIAL_ID}/`]);
    await expect(stat(files.keyFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(files.receiptFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is idempotent when the credential is already revoked', async () => {
    const files = await paths();
    const state = newFixture();
    await createPlatformProvider({
      baseUrl: `${RC}/`, seedConfigPath: files.seed, keyFile: files.keyFile, receiptFile: files.receiptFile,
      fetchImpl: baseFetch(state), nonce: 'rc-platform-provider-already',
    });
    state.resourceExists = false;
    const summary = await cleanupPlatformProvider({
      baseUrl: `${RC}/`, seedConfigPath: files.seed, keyFile: files.keyFile, receiptFile: files.receiptFile,
      fetchImpl: baseFetch(state),
    });
    expect(summary).toEqual({ phase: 'cleanup', ok: true, reason: 'already-revoked' });
    await expect(stat(files.keyFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(files.receiptFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a foreign key file and receipt when ownership cannot be proven', async () => {
    const files = await paths();
    const state = newFixture();
    await createPlatformProvider({
      baseUrl: `${RC}/`, seedConfigPath: files.seed, keyFile: files.keyFile, receiptFile: files.receiptFile,
      fetchImpl: baseFetch(state), nonce: 'rc-platform-provider-foreign',
    });
    await writeFile(files.keyFile, 'provider=openai\napiKey=sk-foreign\nbaseUrl=https://evil.test/v1\n', { mode: 0o600 });
    await expect(cleanupPlatformProvider({
      baseUrl: `${RC}/`, seedConfigPath: files.seed, keyFile: files.keyFile, receiptFile: files.receiptFile,
      fetchImpl: baseFetch(state),
    })).rejects.toMatchObject({ reason: 'ownership-mismatch' });
    expect((await stat(files.keyFile)).isFile()).toBe(true);
    expect((await stat(files.receiptFile)).isFile()).toBe(true);
  });

  it('preserves the receipt and nonzero-fails when cleanup cannot revoke', async () => {
    const files = await paths();
    const state = newFixture();
    await createPlatformProvider({
      baseUrl: `${RC}/`, seedConfigPath: files.seed, keyFile: files.keyFile, receiptFile: files.receiptFile,
      fetchImpl: baseFetch(state), nonce: 'rc-platform-provider-cleanup-fail',
    });
    const failingDelete = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (init?.method === 'DELETE' && url.pathname.includes('/client-credentials/')) {
        return Promise.resolve(new Response('', { status: 503 }));
      }
      return baseFetch(state)(input, init);
    }) as typeof fetch;
    await expect(cleanupPlatformProvider({
      baseUrl: `${RC}/`, seedConfigPath: files.seed, keyFile: files.keyFile, receiptFile: files.receiptFile,
      fetchImpl: failingDelete,
    })).rejects.toMatchObject({ reason: 'revoke-failed', status: 503 });
    expect((await stat(files.receiptFile)).isFile()).toBe(true);
  });

  it('does not delete files or credentials without an owned receipt', async () => {
    const files = await paths();
    await writeFile(files.keyFile, 'foreign-key\n', { mode: 0o600 });
    const state = newFixture();
    const summary = await cleanupPlatformProvider({
      baseUrl: `${RC}/`, seedConfigPath: files.seed, keyFile: files.keyFile, receiptFile: files.receiptFile,
      fetchImpl: baseFetch(state),
    });
    expect(summary).toEqual({ phase: 'cleanup', ok: true, reason: 'no-receipt' });
    expect(state.fetches).toEqual([]);
    expect(await readFile(files.keyFile, 'utf8')).toBe('foreign-key\n');
  });

  it('refuses redirects instead of following them with the Account token', async () => {
    const files = await paths();
    const state = newFixture({ redirect: true });
    await expect(createPlatformProvider({
      baseUrl: `${RC}/`, seedConfigPath: files.seed, keyFile: files.keyFile, receiptFile: files.receiptFile,
      fetchImpl: baseFetch(state),
    })).rejects.toBeInstanceOf(PlatformProviderError);
  });

  it('prints only fixed safe summaries, never the issued secret or account identity', () => {
    expect(safeSummary(new PlatformProviderError('models', 404), 'create'))
      .toEqual({ phase: 'create', ok: false, reason: 'models', status: 404 });
    expect(safeSummary(new Error('Bearer sk-secret at alice@rc.example'), 'create'))
      .toEqual({ phase: 'create', ok: false, reason: 'unexpected' });
  });
});

describe('process-local platform provider for an already authenticated account', () => {
  const GENERIC_CREDENTIAL = `${RC}/.account/account/alice/client-credentials/generic-1/`;

  function accountFetch(
    state: { issued: unknown[]; models: number; deletes: string[]; deleteStatus?: number },
    origin = RC,
  ) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.pathname.endsWith('/client-credentials/')) {
        state.issued.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return Response.json({
          id: 'generic-1',
          secret: 'generic-secret',
          resource: `${origin}/.account/account/alice/client-credentials/generic-1/`,
        }, { status: 201 });
      }
      if (method === 'GET' && url.pathname === '/v1/models') {
        state.models++;
        return Response.json({ data: [{ id: 'linx' }, { id: 'linx-lite' }] });
      }
      if (method === 'DELETE' && url.pathname === '/.account/account/alice/client-credentials/generic-1/') {
        state.deletes.push(url.pathname);
        return new Response(null, { status: state.deleteStatus ?? 204 });
      }
      return new Response(null, { status: 500 });
    }) as typeof fetch;
  }

  const accountOptions = (fetchImpl: typeof fetch, origin = RC) => ({
    baseUrl: `${origin}/`,
    authorization: 'account-token-fixture',
    controls: {
      account: {
        clientCredentials: `${origin}/.account/account/alice/client-credentials/`,
        bindings: `${origin}/.account/account/alice/bindings/`,
      },
    },
    webId: ACCOUNT.webId,
    fetchImpl,
    nonce: 'rc-platform-provider-generic',
  });

  it('accepts exactly the RC and production platform origins', () => {
    expect(requirePlatformOrigin(`${RC}/`).origin).toBe(RC);
    expect(requirePlatformOrigin('https://id.undefineds.co/').origin).toBe('https://id.undefineds.co');
    for (const value of ['https://evil.test/', 'http://id.undefineds.co/', `${RC}/path`, 'https://id.undefineds.co:8443/']) {
      expect(() => requirePlatformOrigin(value)).toThrow(PlatformProviderError);
    }
  });

  it('issues once, proves real models, returns an in-process provider, and writes no files', async () => {
    const state = { issued: [] as unknown[], models: 0, deletes: [] as string[] };
    const created = await createPlatformProviderForAccount(accountOptions(accountFetch(state)));
    expect(created.provider).toEqual({
      id: 'custom',
      offeringId: 'openai-compatible',
      apiKey: `sk-${Buffer.from('generic-1:generic-secret').toString('base64')}`,
      baseUrl: `${RC}/v1`,
      expected: ['linx-lite'],
      source: 'file',
    });
    expect(state.issued).toEqual([{ name: 'rc-platform-provider-generic', webId: ACCOUNT.webId }]);
    expect(state.models).toBe(1);
    const calls = Object.keys(created);
    expect(calls.sort()).toEqual(['provider', 'revoke']);
    await created.revoke();
    expect(state.deletes).toEqual([new URL(GENERIC_CREDENTIAL).pathname]);
    await created.revoke();
    expect(state.deletes).toHaveLength(1);
  });

  it('works for the production stable origin with the same normal lifecycle', async () => {
    const state = { issued: [] as unknown[], models: 0, deletes: [] as string[] };
    const origin = 'https://id.undefineds.co';
    const created = await createPlatformProviderForAccount(accountOptions(accountFetch(state, origin), origin));
    expect(created.provider.baseUrl).toBe(`${origin}/v1`);
    expect(created.provider.expected).toEqual(['linx-lite']);
  });

  it('auto-revokes and throws an opaque error when models are missing', async () => {
    const state = { issued: [] as unknown[], models: 0, deletes: [] as string[] };
    const failing = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if ((init?.method ?? 'GET') === 'GET' && url.pathname === '/v1/models') {
        return Promise.resolve(Response.json({ data: [{ id: 'linx' }] }));
      }
      return accountFetch(state)(input, init);
    }) as typeof fetch;
    await expect(createPlatformProviderForAccount(accountOptions(failing)))
      .rejects.toMatchObject({ reason: 'models' });
    expect(state.deletes).toEqual([new URL(GENERIC_CREDENTIAL).pathname]);
    await expect(createPlatformProviderForAccount(accountOptions(failing)))
      .rejects.not.toHaveProperty('message', expect.stringContaining('generic-secret'));
  });

  it('throws an opaque revoke error when deletion is not confirmed and does not retry-claim success', async () => {
    const state = { issued: [] as unknown[], models: 0, deletes: [] as string[], deleteStatus: 503 };
    const created = await createPlatformProviderForAccount(accountOptions(accountFetch(state)));
    await expect(created.revoke()).rejects.toMatchObject({ reason: 'revoke-failed', status: 503 });
    expect((await created.revoke().catch(error => error)).message).toBe('revoke-failed');
  });
});
