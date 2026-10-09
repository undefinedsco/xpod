import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Response } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { credentialResource } from '@undefineds.co/models';
import { PiConfigAdapter } from '@undefineds.co/ai-connections/client-config';
import type { MountedPodPermissionPhase } from '../../scripts/helpers/packaged-desktop-permissions';
import { accountCreationResponseSucceeded, assertAccountCredentialsRestored, assertNewAccountCredential, assertMountedModelBinding, createConfirmedMountedProvider, createMountedKeyInUi, readOwnedPiConfiguration } from '../../scripts/helpers/packaged-desktop-operations';

it('confirms collection row keys against credential resource ids through the shared model', async () => {
  const rowKey = 'deepseek-fixture';
  const id = credentialResource.buildId({ id: rowKey });
  const webId = 'https://id.example/profile/card#me';
  const model = 'fixture-model';
  const credential = { id, provider: 'deepseek' };
  let present = false;
  const client = {
    webId,
    createApiKeyCredential: vi.fn(async () => { present = true; return credential; }),
    deleteProviderCredential: vi.fn(async () => { present = false; }),
    listProviders: async () => [{ id: 'deepseek', credentials: present ? [credential] : [] }],
    discoverModels: async () => ({ provider: 'deepseek', credential: id, models: [{ id: model }] }),
    saveModelSelection: async () => undefined,
    listGatewayModels: async () => [{ id: model, provider: 'deepseek', credentialId: id, availability: 'available' }],
    quota: async () => ({ status: 'available' }),
  };
  const controller = {
    client,
    credentialsCollection: { isReady: () => true, pendingKeys: new Set(), conflicts: [] },
    get credentialRows() { return present ? [{ id: rowKey }] : []; },
  };
  const host = { solid: { session: { getSnapshot: () => ({ status: 'authenticated', webId }) },
    pod: { status: 'ready', current: { webId } } } };
  const phase = { handle: { evaluate: async (fn: Function, input: unknown) => fn({ host, controller }, input) } } as unknown as MountedPodPermissionPhase;
  let now = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now += 31_000);
  try {
    const result = await createConfirmedMountedProvider(phase, {
      provider: 'deepseek', credential: { apiKey: 'fixture' }, model,
    });
    expect(result.credentialId).toBe(id);
    expect(client.createApiKeyCredential).toHaveBeenCalledTimes(1);
    await expect(result.remove()).resolves.toBe(true);
    expect(present).toBe(false);
  } finally { clock.mockRestore(); }
});

it.each([200, 201])('recognizes an Account creation success %s without requiring 201', status => {
  expect(accountCreationResponseSucceeded(status, 'CSS-Account-Token fixture')).toBe(true);
});

it('requires the Pod record to name the unique newly issued Account credential', () => {
  assertNewAccountCredential(['original'], [{ clientId: 'original' }, { clientId: 'new' }], 'new');
  expect(() => assertNewAccountCredential(['original'], [{ clientId: 'original' }], 'original')).toThrow('newly issued');
  expect(() => assertNewAccountCredential(['original'], [{ clientId: 'original' }], 'new')).toThrow('newly issued');
  expect(() => assertNewAccountCredential(['original'], [{ clientId: 'new' }, { clientId: 'unrelated' }], 'new')).toThrow('newly issued');
});

it('rejects failed or non-Account issuance and independently detects an orphan after Pod registration fails', () => {
  expect(accountCreationResponseSucceeded(401, 'CSS-Account-Token fixture')).toBe(false);
  expect(accountCreationResponseSucceeded(200, 'Bearer fixture')).toBe(false);
  assertAccountCredentialsRestored(['original'], [{ clientId: 'original' }]);
  expect(() => assertAccountCredentialsRestored(['original'], [{ clientId: 'original' }, { clientId: 'orphan' }])).toThrow('Account credential');
});

it('matches the actual discovery credential, selected model and published provider without accepting another row', () => {
  const input = { provider: 'deepseek' as const, credentialId: 'new', model: 'deepseek-flash', webId: 'https://id.example/card#me' };
  const result = { credential: { id: 'new', provider: 'deepseek' }, credentialCount: 1, providerId: 'deepseek', webId: input.webId,
    discovery: { provider: 'deepseek', credential: 'new', models: [{ id: input.model }] },
    models: [{ id: input.model, provider: 'deepseek', availability: 'available' }] };
  assertMountedModelBinding(input, result);
  for (const changed of [{ ...result, credentialCount: 2 },
    { ...result, discovery: { ...result.discovery, credential: 'old' } },
    { ...result, models: [{ ...result.models[0], id: 'different' }] },
    { ...result, models: [{ ...result.models[0], provider: 'foreign' }] },
    { ...result, webId: input.webId.replace('#me', '#other') }]) {
    expect(() => assertMountedModelBinding(input, changed)).toThrow('binding');
  }
});

it('requires actual Pi files in the owned home and refuses foreign paths or gateway configuration', async () => {
  const root = path.join(process.cwd(), '.test-data', 'packaged-desktop-operations');
  await mkdir(root, { recursive: true });
  const fixture = await mkdtemp(path.join(root, 'config-'));
  const home = path.join(fixture, 'owned-home');
  const files = path.join(home, '.pi', 'agent');
  const outside = path.join(fixture, 'outside-settings.json');
  await mkdir(files, { recursive: true });
  const models = path.join(files, 'models.json');
  const settings = path.join(files, 'settings.json');
  const gateway = 'http://127.0.0.1:41234/';
  const projection = { providers: { xpod: { baseUrl: `${gateway}v1`, apiKey: 'fixture-private-wrapper' } } };
  try {
    await writeFile(models, JSON.stringify(projection), { mode: 0o600 });
    await writeFile(settings, JSON.stringify({ defaultProvider: 'xpod' }), { mode: 0o600 });
    expect(await readOwnedPiConfiguration(home, gateway)).toBe('fixture-private-wrapper');
    expect((await lstat(models)).mode & 0o077).toBe(0);
    await expect(readOwnedPiConfiguration(home, 'http://127.0.0.1:41235/')).rejects.toThrow('differs');
    await writeFile(outside, JSON.stringify({ defaultProvider: 'xpod' }));
    const original = await readFile(outside, 'utf8');
    await rm(settings);
    await symlink(outside, settings);
    await expect(readOwnedPiConfiguration(home, gateway)).rejects.toThrow('escaped');
    expect(await readFile(outside, 'utf8')).toBe(original);
    await rm(settings);
    await writeFile(settings, JSON.stringify({ defaultProvider: 'foreign' }));
    await expect(readOwnedPiConfiguration(home, gateway)).rejects.toThrow('differs');
    await rm(models);
    await expect(readOwnedPiConfiguration(home, gateway)).rejects.toThrow();
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

it('accepts session DPoP issuance only with its proof', () => {
  expect(accountCreationResponseSucceeded(200, 'DPoP fixture', 'proof')).toBe(true);
  expect(accountCreationResponseSucceeded(200, 'DPoP fixture')).toBe(false);
  expect(accountCreationResponseSucceeded(401, 'DPoP fixture', 'proof')).toBe(false);
});

it.each([
  ['identity', 'provider-identity'], ['collection', 'provider-collection'],
  ['create', 'provider-create'], ['publication', 'provider-publication'],
] as const)('attributes the actual provider %s rejection without replaying its credential mutation', async (stage, condition) => {
  const secret = 'fixture-private-credential-never-publish';
  const cause = new Error(secret);
  const webId = 'https://owner.example/card#me';
  let created = false;
  let removed = false;
  const client = {
    webId,
    createApiKeyCredential: vi.fn(() => {
      if (stage === 'create') throw cause;
      created = true;
      return { id: 'owned' };
    }),
    deleteProviderCredential: vi.fn(() => { removed = true; }),
    listProviders: vi.fn(() => { throw cause; }),
  };
  const mounted = {
    host: { solid: {
      session: { getSnapshot: () => ({ status: stage === 'identity' ? 'anonymous' : 'authenticated', webId }) },
      pod: { status: 'ready', current: { webId } },
    } },
    controller: {
      client,
      get credentialsCollection() {
        if (stage === 'collection') throw cause;
        return { isReady: () => true, pendingKeys: new Set(), conflicts: [] };
      },
      get credentialRows() { return created && !removed ? [{ id: 'owned' }] : []; },
    },
  };
  const phase = {
    handle: { evaluate: async (fn: (value: typeof mounted, arg: unknown) => unknown, arg: unknown) => fn(mounted, arg) },
  } as unknown as import('../../scripts/helpers/packaged-desktop-permissions').MountedPodPermissionPhase;
  const failure = await createConfirmedMountedProvider(phase,
    { provider: 'openai', credential: { apiKey: secret }, model: 'fixture-model' }).catch(error => error);
  const { describeFailure, publishedFailures } = await import('../../scripts/accept-packaged-desktop-permissions');
  expect(describeFailure(failure)).toEqual({ code: 'pod-operation',
    explanation: 'The mounted provider, key or Chat operation failed; the reviewed sub-condition names the operation',
    evidence: condition });
  const primary = failure instanceof AggregateError ? failure.errors[0] : failure;
  expect(primary.cause).toBeInstanceOf(Error);
  if (stage !== 'identity') expect(primary.cause).toBe(cause);
  expect(JSON.stringify(publishedFailures([failure, new Error(secret)]))).not.toContain(secret);
  expect(client.createApiKeyCredential).toHaveBeenCalledTimes(stage === 'identity' || stage === 'collection' ? 0 : 1);
  expect(client.deleteProviderCredential).toHaveBeenCalledTimes(stage === 'publication' ? 1 : 0);
  if (stage === 'publication') {
    expect(failure).toBeInstanceOf(AggregateError);
    expect(describeFailure(failure.errors[1]).evidence).toBe('provider-cleanup');
  }
});

it('keeps a generic primary at its real boundary when cleanup already has another condition', async () => {
  const { attributePackagedOperation, PackagedOperationError } = await import('../../scripts/helpers/packaged-desktop-operations');
  const { describeFailure } = await import('../../scripts/accept-packaged-desktop-permissions');
  const primary = new Error('private-primary-credential');
  const cleanup = new PackagedOperationError('key-cleanup', new Error('private-cleanup'));
  const combined = new AggregateError([primary, cleanup], 'private combined failure');
  const failure = await attributePackagedOperation('key-dialog', async () => { throw combined; }).catch(error => error);
  expect(describeFailure(failure).evidence).toBe('key-dialog');
  expect(failure.cause).toBe(combined);
  const typed = new PackagedOperationError('provider-create', primary);
  const typedCombined = new AggregateError([typed, cleanup], 'private combined failure');
  const retained = await attributePackagedOperation('key-dialog', async () => { throw typedCombined; }).catch(error => error);
  expect(retained).toBe(typedCombined);
  expect(describeFailure(retained).evidence).toBe('provider-create');
  expect(JSON.stringify(describeFailure(failure))).not.toContain('private-');
});

it.each(['present', 'unavailable'] as const)('confirms resource ids and waits for real row removal while rows are %s', async visibility => {
  vi.useFakeTimers();
  const { credentialResource } = await import('@undefineds.co/models');
  const rowKey = 'openai-confirm-owned';
  const resourceId = credentialResource.buildId({ id: rowKey });
  expect(resourceId).not.toBe(rowKey);
  const webId = 'https://owner.example/card#me';
  let exists = false;
  let deleting = false;
  let cleanupReads = 0;
  const credential = { id: resourceId, provider: 'openai' };
  const client = {
    webId,
    createApiKeyCredential: vi.fn(async () => { exists = true; return credential; }),
    deleteProviderCredential: vi.fn(async () => { deleting = true; }),
    listProviders: vi.fn(async () => [{ id: 'openai', credentials: exists ? [credential] : [] }]),
    discoverModels: vi.fn(async () => ({ provider: 'openai', credential: resourceId, models: [{ id: 'fixture-model' }] })),
    saveModelSelection: vi.fn(async () => undefined),
    listGatewayModels: vi.fn(async () => [{ id: 'fixture-model', provider: 'openai', credentialId: resourceId }]),
    quota: vi.fn(async () => ({ status: 'available' })),
  };
  const mounted = {
    host: { solid: { session: { getSnapshot: () => ({ status: 'authenticated', webId }) },
      pod: { status: 'ready', current: { webId } } } },
    controller: { client, credentialsCollection: { isReady: () => true, pendingKeys: new Set(), conflicts: [] },
      get credentialRows() {
        if (deleting && ++cleanupReads >= 3) exists = false;
        if (deleting && cleanupReads < 3 && visibility === 'unavailable') return undefined;
        return exists ? [{ id: rowKey }] : [];
      } },
  };
  const phase = { handle: { evaluate: async (fn: (v: typeof mounted, arg: unknown) => unknown, arg: unknown) => fn(mounted, arg) } } as unknown as import('../../scripts/helpers/packaged-desktop-permissions').MountedPodPermissionPhase;
  try {
    const pending = createConfirmedMountedProvider(phase,
      { provider: 'openai', credential: { apiKey: 'fixture-only-private' }, model: 'fixture-model' });
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(30_100);
    const result = await outcome;
    expect(result).not.toHaveProperty('error');
    const provider = (result as { value: Awaited<ReturnType<typeof createConfirmedMountedProvider>> }).value;
    expect(provider.credentialId).toBe(resourceId);
    expect(client.createApiKeyCredential).toHaveBeenCalledTimes(1);
    const removal = provider.remove();
    await vi.advanceTimersByTimeAsync(500);
    await expect(removal).resolves.toBe(true);
    expect(cleanupReads).toBeGreaterThanOrEqual(3);
    expect(exists).toBe(false);
    expect(client.deleteProviderCredential).toHaveBeenCalledTimes(1);
    expect(client.deleteProviderCredential).toHaveBeenCalledWith('openai', resourceId);
  } finally { vi.useRealTimers(); }
});

it.each([403, 200])('retains held Solid credential status and model observations without retaining its token (%s)', async status => {
  const { acceptHeldSolidCredential, attributePackagedOperation } = await import('../../scripts/helpers/packaged-desktop-operations');
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status }));
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:41234' } });
  vi.stubGlobal('fetch', fetch);
  const page = { evaluate: async (fn: Function, input: unknown) => fn(input) } as unknown as Page;
  try {
    const failure = await attributePackagedOperation('held-credential', () => acceptHeldSolidCredential(page, {
      gateway: 'http://127.0.0.1:41234/', podUrl: 'https://pod.example/a/', key: 'sk-private-held-token', model: 'selected',
    })).catch(error => error);
    expect(failure.condition).toBe('held-credential');
    expect(failure.cause.message).toContain('"status":' + status);
    expect(failure.cause.message).toContain('"modelCount":0');
    expect(failure.cause.message).not.toContain('private-held-token');
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { vi.unstubAllGlobals(); }
});


it('rejects an internal invocation before dispatching a Pod models request', async () => {
  const { acceptHeldSolidCredential } = await import('../../scripts/helpers/packaged-desktop-operations');
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'selected' }] })));
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:41234' } });
  vi.stubGlobal('fetch', fetch);
  const page = { evaluate: async (fn: Function, input: unknown) => fn(input) } as unknown as Page;
  try {
    await expect(acceptHeldSolidCredential(page, { gateway: 'http://127.0.0.1:41234/',
      podUrl: 'https://pod.example/a/', key: 'xpod_inv_v1.fixture', model: 'selected' }))
      .rejects.toThrow('Solid client credential');
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});


it.each(['complete', 'truncated', 'wrong-body', 'rejected'] as const)('checks a single real-protocol Chat response with a reasoning budget (%s)', async outcome => {
  const { acceptMountedFirstChat } = await import('../../scripts/helpers/packaged-desktop-operations');
  const endpoint = 'http://127.0.0.1:41234/v1/chat/completions';
  const marker = 'XPOD_REASONING_BUDGET';
  let onRequest: (request: unknown) => void;
  const page = {
    on: vi.fn((_event: string, handler: typeof onRequest) => { onRequest = handler; }),
    off: vi.fn(), evaluate: async (fn: Function, input: unknown) => fn(input),
  } as unknown as Page;
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    onRequest!({ url: () => endpoint, method: () => 'POST' });
    const request = JSON.parse(String(init.body));
    const complete = request.max_tokens >= 512 && outcome !== 'truncated';
    return new Response(JSON.stringify({ choices: [{ message: {
      content: complete ? outcome === 'wrong-body' ? 'unrelated' : marker : 'XPOD_',
      reasoning_content: 'Reasoning consumes the small output budget first.',
    }, finish_reason: complete ? 'stop' : 'length' }] }), { status: outcome === 'rejected' ? 401 : 200 });
  });
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:41234' } });
  vi.stubGlobal('fetch', fetch);
  try {
    const request = acceptMountedFirstChat(page, { gateway: 'http://127.0.0.1:41234/',
      podUrl: 'https://pod.example/a/', key: 'sk-owned-credential', model: 'reasoning-model', marker });
    if (outcome === 'complete') await expect(request).resolves.toEqual({ status: 200, bodyMatches: true, dispatches: 1 });
    else await expect(request).rejects.toThrow('Actual Chat');
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(body.max_tokens).toBeGreaterThanOrEqual(512);
    expect(body.max_tokens).toBeLessThanOrEqual(1024);
    expect(page.off).toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});


it('restores the fixture Pi projection before revoking its key so another WebID can use it', async () => {
  const root = path.join(process.cwd(), '.test-data', 'packaged-desktop-operations');
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, 'key-config-cleanup-'));
  const directory = path.join(home, '.pi', 'agent');
  await mkdir(directory, { recursive: true });
  const original = { defaultProvider: 'ollama', theme: 'user-theme' };
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify(original));
  const adapter = new PiConfigAdapter({ homeDir: home });
  const webId = 'https://id.example/alice/profile/card#me';
  const gateway = 'http://127.0.0.1:41234/';
  const wrapper = 'sk-Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=';
  const profile = { endpoint: gateway, apiKey: wrapper, webId };
  const control = 'https://id.example/.account/client-credentials';
  let present = false;
  let observeResponse: (response: Response) => void = () => undefined;
  const restore = vi.fn(async () => { await adapter.restore(webId); return { status: 'notConfigured' }; });
  const record = { id: 'issued-client', clientCredentialId: 'issued-client', owner: webId, kind: 'client-credentials' };
  const host = { capabilities: {
    aiClientCredentials: { list: async () => present ? [{ clientId: record.id }] : [] },
    aiClientConfiguration: { restore, inspect: async () => ({ status: (await adapter.inspect()).ownership === 'owned' ? 'configured' : 'notConfigured' }) },
  } };
  const controller = { selectSection: () => undefined, client: {
    webId, listGatewayKeys: async () => present ? [record] : [], deleteGatewayKey: async () => { present = false; },
  } };
  const locator = (name: unknown): Record<string, unknown> => ({
    fill: async () => undefined, selectOption: async () => undefined, waitFor: async () => undefined,
    getByRole: (_role: string, options: { name: unknown }) => locator(options.name),
    getByText: (text: string) => locator(text),
    click: async () => {
      if (name === '创建 Xpod 密钥') {
        present = true;
        observeResponse({ url: () => control, status: () => 201, json: async () => ({ id: record.id }), request: () => ({
          method: () => 'POST', postDataJSON: () => ({ name: 'fixture-key', webId }), allHeaders: async () => ({ authorization: 'CSS-Account-Token fixture' }),
        }) } as unknown as Response);
      } else if (name === '写入 Pi') await adapter.apply(await adapter.plan(profile));
      else if (name instanceof RegExp && name.source.startsWith('^确认删除')) present = false;
    },
  });
  const page = { on: (_event: string, listener: typeof observeResponse) => { observeResponse = listener; }, off: () => undefined,
    getByRole: (role: string, options?: { name: unknown }) => locator(options?.name ?? role), locator: () => locator('row'),
  } as unknown as Page;
  const phase = { handle: { evaluate: async (fn: Function, input: unknown) => fn({ host, controller }, input) } } as unknown as MountedPodPermissionPhase;
  try {
    const issued = await createMountedKeyInUi(page, phase, { name: 'fixture-key', configurationHome: home, gateway, accountCredentialControl: control });
    expect(issued.key).toBe(wrapper);
    await expect(adapter.plan({ ...profile, webId: webId.replace('alice', 'bob') })).rejects.toThrow('another WebID');
    await expect(issued.remove()).resolves.toBe(true);
    await expect(adapter.plan({ ...profile, webId: webId.replace('alice', 'bob') })).resolves.toBeDefined();
    expect(restore).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'))).toEqual(original);
    expect(present).toBe(false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
