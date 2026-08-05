import { describe, expect, it, vi } from 'vitest';
import { aiModelResource, aiProviderResource } from '@undefineds.co/models';
import type { AuthContext } from '../../../src/api/auth/AuthContext';
import {
  ModelSelectionBlockedError,
  PodModelSelectionRepository,
  type PodModelSelectionDb,
  type PodModelSelection,
  type PodSelectedModel,
} from '../../../src/api/ai-gateway/models/PodModelSelectionRepository';

const ALICE = 'https://pod.example/alice/profile/card#me';
const BOB = 'https://pod.example/bob/profile/card#me';

function auth(webId: string): AuthContext {
  return { type: 'solid', webId, scopes: ['models:read', 'models:write'] };
}

type Row = Record<string, unknown>;

interface FakePod {
  providers: Map<string, Row>;
  models: Map<string, Row>;
}

interface HarnessHooks {
  beforeWrite?: () => Promise<void>;
}

function makePod(): FakePod {
  return { providers: new Map(), models: new Map() };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createHarness(initial: Record<string, FakePod> = {}, hooks: HarnessHooks = {}) {
  const pods = new Map(Object.entries(initial));
  const calls: Array<{ op: string; resource?: unknown; id?: string; value?: Row; where?: unknown }> = [];
  const fail = { operation: undefined as string | undefined };

  const dbFactory = vi.fn(async ({ owner }: { owner: string }) => {
    const pod = pods.get(owner) ?? makePod();
    pods.set(owner, pod);
    const db: PodModelSelectionDb = {
      async init() {},
      select() {
        return {
          from(resource: unknown) {
            return {
              where(condition: unknown) {
                calls.push({ op: 'select', resource, where: condition });
                return {
                  async execute() {
                    if (resource !== aiModelResource) {
                      return [];
                    }
                    return [...pod.models.values()].map(clone);
                  },
                };
              },
            };
          },
        } as ReturnType<PodModelSelectionDb['select']>;
      },
      async findById<T>(resource: unknown, id: string): Promise<T | null> {
        calls.push({ op: 'findById', resource, id });
        const row = resource === aiProviderResource ? pod.providers.get(id) : pod.models.get(id);
        return clone(row ?? null) as T | null;
      },
      insert(resource: unknown) {
        return {
          values(value: unknown) {
            return {
              async execute() {
                calls.push({ op: 'insert', resource, value: clone(value as Row) });
                await hooks.beforeWrite?.();
                if (fail.operation === 'insert') {
                  fail.operation = undefined;
                  throw new Error('insert_failed');
                }
                const row = clone(value as Row);
                const id = String(row.id);
                if (resource === aiProviderResource) {
                  pod.providers.set(id, row);
                } else {
                  pod.models.set(id, row);
                }
                return [clone(row)];
              },
            };
          },
        } as ReturnType<PodModelSelectionDb['insert']>;
      },
      async updateById<T>(resource: unknown, id: string, patch: unknown): Promise<T | null> {
        calls.push({ op: 'updateById', resource, id, value: clone(patch as Row) });
        if (fail.operation === 'updateById') {
          fail.operation = undefined;
          throw new Error('update_failed');
        }
        const store = resource === aiProviderResource ? pod.providers : pod.models;
        const current = store.get(id);
        if (!current) {
          return null;
        }
        for (const [key, value] of Object.entries(clone(patch as Row))) {
          if (value === null) {
            delete current[key];
          } else {
            current[key] = value;
          }
        }
        return clone(current) as T;
      },
      async deleteById(resource: unknown, id: string) {
        calls.push({ op: 'deleteById', resource, id });
        if (fail.operation === 'deleteById') {
          throw new Error('delete_failed');
        }
        const store = resource === aiProviderResource ? pod.providers : pod.models;
        return store.delete(id);
      },
    };
    return db;
  });

  const repository = new PodModelSelectionRepository({
    providerIds: ['openai', 'anthropic', 'kimi', 'bailian', 'deepseek'],
    dbFactory,
    internalPodAccess: {
      getTrustedFetch: vi.fn(async () => fetch),
    },
  });

  return { repository, pods, calls, fail, dbFactory };
}

function model(id: string, overrides: Partial<PodSelectedModel> = {}): PodSelectedModel {
  return { id, modelType: 'chat', status: 'active', ...overrides };
}

describe('PodModelSelectionRepository', () => {
  it('uses resource-owned durable ids and full provider URI relations when replacing a selection', async () => {
    const harness = createHarness();

    const selection = await harness.repository.replaceSelection({
      webId: ALICE,
      provider: 'openai',
      models: [model('gpt-5', { displayName: 'GPT-5' })],
      expectedVersion: (await harness.repository.listSelection({ webId: ALICE, provider: 'openai', auth: auth(ALICE) })).version,
      auth: auth(ALICE),
    });

    const persisted = [...harness.pods.get(ALICE)!.models.values()][0];
    expect(persisted).toMatchObject({
      id: 'openai.ttl#gpt-5',
      isProvidedBy: 'https://pod.example/alice/settings/providers/openai.ttl',
      displayName: 'GPT-5',
      modelType: 'chat',
      status: 'active',
    });
    expect(selection.models).toEqual([
      expect.objectContaining({ id: 'openai.ttl#gpt-5', displayName: 'GPT-5', status: 'active' }),
    ]);
  });

  it('lists only models related to the requested provider and keeps version stable across row order', async () => {
    const pod = makePod();
    pod.models.set('openai.ttl#z', {
      id: 'openai.ttl#z',
      isProvidedBy: 'https://pod.example/alice/settings/providers/openai.ttl',
      modelType: 'chat',
      status: 'active',
    });
    pod.models.set('openai.ttl#a', {
      id: 'openai.ttl#a',
      isProvidedBy: 'https://pod.example/alice/settings/providers/openai.ttl',
      modelType: 'embedding',
      status: 'inactive',
    });
    pod.models.set('deepseek.ttl#chat', {
      id: 'deepseek.ttl#chat',
      isProvidedBy: 'https://pod.example/alice/settings/providers/deepseek.ttl',
      modelType: 'chat',
      status: 'active',
    });
    const harness = createHarness({ [ALICE]: pod });

    const first = await harness.repository.listSelection({ webId: ALICE, provider: 'openai', auth: auth(ALICE) });
    [...pod.models].reverse();
    const second = await harness.repository.listSelection({ webId: ALICE, provider: 'openai', auth: auth(ALICE) });

    expect(first.models.map((item) => item.id)).toEqual(['openai.ttl#a', 'openai.ttl#z']);
    expect(second.version).toBe(first.version);
    expect(first.models).not.toContainEqual(expect.objectContaining({ id: 'deepseek.ttl#chat' }));
    const relationQuery = harness.calls.find((call) => call.op === 'select' && call.where);
    expect(relationQuery).toBeDefined();
    expect((relationQuery?.where as { right?: unknown }).right)
      .toBe('https://pod.example/alice/settings/providers/openai.ttl');
  });

  it('replaces exactly the picked rows, deletes unpicked rows, and persists the provider default model', async () => {
    const pod = makePod();
    pod.models.set('openai.ttl#old', {
      id: 'openai.ttl#old',
      isProvidedBy: 'https://pod.example/alice/settings/providers/openai.ttl',
      modelType: 'chat',
      status: 'active',
    });
    const harness = createHarness({ [ALICE]: pod });
    const before = await harness.repository.listSelection({ webId: ALICE, provider: 'openai', auth: auth(ALICE) });

    const next = await harness.repository.replaceSelection({
      webId: ALICE,
      provider: 'openai',
      models: [model('new', { modelType: 'embedding' })],
      defaultModel: 'new',
      expectedVersion: before.version,
      auth: auth(ALICE),
    });

    expect([...pod.models.keys()]).toEqual(['openai.ttl#new']);
    expect(pod.providers.get('openai.ttl')).toMatchObject({
      id: 'openai.ttl',
      defaultModel: 'https://pod.example/alice/settings/providers/openai.ttl#new',
    });
    expect(next.defaultModel).toBe('openai.ttl#new');
  });

  it('marks missing picked models inactive after complete discovery without persisting unpicked discoveries', async () => {
    const pod = makePod();
    pod.models.set('openai.ttl#kept', {
      id: 'openai.ttl#kept',
      isProvidedBy: 'https://pod.example/alice/settings/providers/openai.ttl',
      displayName: 'old name',
      modelType: 'chat',
      status: 'active',
    });
    pod.models.set('openai.ttl#missing', {
      id: 'openai.ttl#missing',
      isProvidedBy: 'https://pod.example/alice/settings/providers/openai.ttl',
      modelType: 'chat',
      status: 'active',
    });
    const harness = createHarness({ [ALICE]: pod });

    const next = await harness.repository.reconcileAvailability({
      webId: ALICE,
      provider: 'openai',
      discoveredModels: [
        { id: 'kept', displayName: 'new name', modelType: 'chat' },
        { id: 'discovered-but-unpicked', modelType: 'embedding' },
      ],
      auth: auth(ALICE),
    });

    expect(pod.models.get('openai.ttl#kept')).toMatchObject({ status: 'active', displayName: 'new name' });
    expect(pod.models.get('openai.ttl#missing')).toMatchObject({ status: 'inactive' });
    expect(pod.models.has('openai.ttl#discovered-but-unpicked')).toBe(false);
    expect(next.models.map((item) => [item.id, item.status])).toEqual([
      ['openai.ttl#kept', 'active'],
      ['openai.ttl#missing', 'inactive'],
    ]);
  });

  it('lists active models across the five known providers without crossing Pod ownership', async () => {
    const alice = makePod();
    alice.models.set('openai.ttl#gpt-5', {
      id: 'openai.ttl#gpt-5',
      isProvidedBy: 'https://pod.example/alice/settings/providers/openai.ttl',
      modelType: 'chat',
      status: 'active',
    });
    alice.models.set('deepseek.ttl#old', {
      id: 'deepseek.ttl#old',
      isProvidedBy: 'https://pod.example/alice/settings/providers/deepseek.ttl',
      modelType: 'chat',
      status: 'inactive',
    });
    const bob = makePod();
    bob.models.set('openai.ttl#bob', {
      id: 'openai.ttl#bob',
      isProvidedBy: 'https://pod.example/bob/settings/providers/openai.ttl',
      modelType: 'chat',
      status: 'active',
    });
    const harness = createHarness({ [ALICE]: alice, [BOB]: bob });

    const selections = await harness.repository.listActiveSelections({ webId: ALICE, auth: auth(ALICE) });

    expect(selections).toEqual([
      expect.objectContaining({ provider: 'openai', models: [expect.objectContaining({ id: 'openai.ttl#gpt-5', status: 'active' })] }),
    ]);
    expect(JSON.stringify(selections)).not.toContain('bob');
  });

  it('rejects a stale version before any mutation', async () => {
    const harness = createHarness();
    const before = await harness.repository.listSelection({ webId: ALICE, provider: 'openai', auth: auth(ALICE) });

    await expect(harness.repository.replaceSelection({
      webId: ALICE,
      provider: 'openai',
      models: [model('gpt-5')],
      expectedVersion: `${before.version}-stale`,
      auth: auth(ALICE),
    })).rejects.toThrow('model_selection_version_conflict');

    expect([...harness.pods.get(ALICE)!.models]).toHaveLength(0);
    expect(harness.calls.filter((call) => ['insert', 'updateById', 'deleteById'].includes(call.op))).toHaveLength(0);
  });

  it('serializes same-provider replacements so one expected version can commit', async () => {
    let releaseFirstWrite!: () => void;
    let firstWriteStarted!: () => void;
    const firstWrite = new Promise<void>((resolve) => { firstWriteStarted = resolve; });
    const firstWriteRelease = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    let blockedFirstWrite = true;
    const harness = createHarness({}, {
      beforeWrite: async () => {
        if (!blockedFirstWrite) {
          return;
        }
        blockedFirstWrite = false;
        firstWriteStarted();
        await firstWriteRelease;
      },
    });
    const before = await harness.repository.listSelection({ webId: ALICE, provider: 'openai', auth: auth(ALICE) });

    const first = harness.repository.replaceSelection({
      webId: ALICE,
      provider: 'openai',
      models: [model('first')],
      expectedVersion: before.version,
      auth: auth(ALICE),
    });
    await firstWrite;
    const second = harness.repository.replaceSelection({
      webId: ALICE,
      provider: 'openai',
      models: [model('second')],
      expectedVersion: before.version,
      auth: auth(ALICE),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releaseFirstWrite();

    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<PodModelSelection> => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ message: 'model_selection_version_conflict' });
    expect([...harness.pods.get(ALICE)!.models.keys()]).toEqual([`${fulfilled[0].value.models[0].id}`]);
    await expect(harness.repository.listSelection({ webId: ALICE, provider: 'openai', auth: auth(ALICE) }))
      .resolves.toEqual(fulfilled[0].value);
  });

  it('rolls back partial mutations when an exact upsert fails', async () => {
    const pod = makePod();
    pod.models.set('openai.ttl#old', {
      id: 'openai.ttl#old',
      isProvidedBy: 'https://pod.example/alice/settings/providers/openai.ttl',
      modelType: 'chat',
      status: 'active',
      unknownPredicate: 'must-survive-rollback',
    });
    const harness = createHarness({ [ALICE]: pod });
    const before = await harness.repository.listSelection({ webId: ALICE, provider: 'openai', auth: auth(ALICE) });
    harness.fail.operation = 'insert';

    await expect(harness.repository.replaceSelection({
      webId: ALICE,
      provider: 'openai',
      models: [model('old', { displayName: 'renamed' }), model('new')],
      expectedVersion: before.version,
      auth: auth(ALICE),
    })).rejects.toThrow('insert_failed');

    expect([...pod.models.keys()]).toEqual(['openai.ttl#old']);
    expect(pod.models.get('openai.ttl#old')).toMatchObject({ status: 'active' });
    expect(pod.models.get('openai.ttl#old')).not.toHaveProperty('displayName', 'renamed');
    expect(pod.models.get('openai.ttl#old')).toHaveProperty('unknownPredicate', 'must-survive-rollback');
    expect(harness.calls.filter((call) => call.op === 'deleteById' && call.resource === aiModelResource)).toHaveLength(0);
  });

  it('keeps logically removed rows hidden when cleanup deletion fails after commit', async () => {
    const pod = makePod();
    pod.models.set('openai.ttl#old', {
      id: 'openai.ttl#old',
      isProvidedBy: 'https://pod.example/alice/settings/providers/openai.ttl',
      modelType: 'chat',
      status: 'active',
    });
    const harness = createHarness({ [ALICE]: pod });
    const before = await harness.repository.listSelection({ webId: ALICE, provider: 'openai', auth: auth(ALICE) });
    harness.fail.operation = 'deleteById';

    await expect(harness.repository.replaceSelection({
      webId: ALICE,
      provider: 'openai',
      models: [model('new')],
      expectedVersion: before.version,
      auth: auth(ALICE),
    })).resolves.toMatchObject({ models: [expect.objectContaining({ id: 'openai.ttl#new' })] });

    expect(pod.models.get('openai.ttl#old')).toMatchObject({ status: 'removed' });
    expect((await harness.repository.listSelection({ webId: ALICE, provider: 'openai', auth: auth(ALICE) })).models)
      .not.toContainEqual(expect.objectContaining({ id: 'openai.ttl#old' }));
  });

  it('accepts the canonical absolute provider model resource id', async () => {
    const harness = createHarness();

    const selection = await harness.repository.replaceSelection({
      webId: ALICE,
      provider: 'openai',
      models: [model('https://pod.example/alice/settings/providers/openai.ttl#gpt-5')],
      auth: auth(ALICE),
    });

    expect(selection.models).toEqual([
      expect.objectContaining({ id: 'openai.ttl#gpt-5' }),
    ]);
  });

  it.each([
    ['foreign absolute URL', 'https://pod.example/bob/settings/providers/openai.ttl#gpt-5'],
    ['same-Pod private path', 'https://pod.example/alice/private/openai.ttl#gpt-5'],
    ['same-Pod private document', 'https://pod.example/alice/private/openai.ttl'],
    ['private relative path', 'private/openai.ttl#gpt-5'],
    ['private relative document', 'private/openai.ttl'],
    ['nested provider suffix', 'https://pod.example/alice/foo/settings/providers/openai.ttl#gpt-5'],
    ['nested provider document', 'https://pod.example/alice/foo/settings/providers/openai.ttl'],
    ['nested relative provider suffix', 'foo/settings/providers/openai.ttl#gpt-5'],
    ['nested relative provider document', 'foo/settings/providers/openai.ttl'],
    ['wrong relative provider path', 'settings/providers/openai.ttl#gpt-5'],
    ['wrong relative provider document', 'settings/providers/openai.ttl'],
    ['nested provider suffix', 'openai.ttl/nested#gpt-5'],
    ['protocol-relative URL', '//pod.example/alice/settings/providers/openai.ttl#gpt-5'],
    ['protocol-relative document', '//pod.example/alice/settings/providers/openai.ttl'],
    ['javascript URL', 'javascript:alert(1)'],
    ['malformed URL', 'https://[broken/openai.ttl#gpt-5'],
  ])('rejects %s model ids before mutating the owner Pod', async (_name, id) => {
    const harness = createHarness();

    await expect(harness.repository.replaceSelection({
      webId: ALICE,
      provider: 'openai',
      models: [model(id)],
      auth: auth(ALICE),
    })).rejects.toThrow(/model_selection_model_(?:invalid_iri|provider_mismatch)/u);
    expect(harness.calls.filter((call) => ['insert', 'updateById', 'deleteById'].includes(call.op))).toHaveLength(0);
  });

  it('does not allow a caller authenticated as another WebID to access the Pod', async () => {
    const harness = createHarness();

    await expect(harness.repository.listSelection({
      webId: ALICE,
      provider: 'openai',
      auth: auth(BOB),
    })).rejects.toThrow('pod_model_selection_auth_mismatch');
    expect(harness.dbFactory).not.toHaveBeenCalled();
  });

  it('restores deleted model rows and provider metadata when a later exact write fails', async () => {
    const pod = makePod();
    pod.models.set('openai.ttl#old', {
      id: 'openai.ttl#old',
      isProvidedBy: 'https://pod.example/alice/settings/providers/openai.ttl',
      modelType: 'chat',
      status: 'active',
    });
    pod.providers.set('openai.ttl', {
      id: 'openai.ttl',
      defaultModel: 'https://pod.example/alice/settings/providers/openai.ttl#old',
    });
    const harness = createHarness({ [ALICE]: pod });
    const before = await harness.repository.listSelection({ webId: ALICE, provider: 'openai', auth: auth(ALICE) });
    harness.fail.operation = 'updateById';

    await expect(harness.repository.replaceSelection({
      webId: ALICE,
      provider: 'openai',
      models: [model('new')],
      defaultModel: 'new',
      expectedVersion: before.version,
      auth: auth(ALICE),
    })).rejects.toThrow('update_failed');

    expect([...pod.models.keys()]).toEqual(['openai.ttl#old']);
    expect(pod.providers.get('openai.ttl')).toMatchObject({
      defaultModel: 'https://pod.example/alice/settings/providers/openai.ttl#old',
    });
  });

  it('reports a blocked context instead of falling back when relation-filtered LDP queries are unavailable', async () => {
    const repository = new PodModelSelectionRepository({
      dbFactory: vi.fn(async () => ({
        select: () => ({ from: () => ({}) }),
        findById: vi.fn(),
        insert: vi.fn(),
        updateById: vi.fn(),
        deleteById: vi.fn(),
      }) as any),
      internalPodAccess: { getTrustedFetch: vi.fn(async () => fetch) },
    });

    const error = await repository.listSelection({ webId: ALICE, provider: 'openai', auth: auth(ALICE) })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelSelectionBlockedError);
    expect(error).toMatchObject({
      code: 'BLOCKED/NEEDS_CONTEXT',
      recommendation: expect.stringContaining('@undefineds.co/drizzle-solid'),
    });
  });
});
