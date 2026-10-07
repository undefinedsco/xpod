import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { accountCreationResponseSucceeded, assertAccountCredentialsRestored, assertNewAccountCredential, assertMountedModelBinding, readOwnedPiConfiguration, createConfirmedMountedProvider } from '../../scripts/helpers/packaged-desktop-operations';

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
