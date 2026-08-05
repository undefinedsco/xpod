import { describe, expect, it, vi } from 'vitest';
import { aiModelResource, aiProviderResource } from '@undefineds.co/models';

import type { AuthContext } from '../../src/api/auth/AuthContext';
import {
  PodModelSelectionRepository,
  type PodModelSelectionDb,
} from '../../src/api/ai-gateway/models/PodModelSelectionRepository';

const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const ALICE = 'https://pod.example/alice/profile/card#me';
const BOB = 'https://pod.example/bob/profile/card#me';

type Row = Record<string, unknown>;
type Pod = { providers: Map<string, Row>; models: Map<string, Row> };

function auth(webId: string): AuthContext {
  return { type: 'solid', webId, scopes: ['models:read', 'models:write'] };
}

function createPersistentPodFactory() {
  const pods = new Map<string, Pod>();
  const dbFactory = vi.fn(async ({ owner }: { owner: string }) => {
    const pod = pods.get(owner) ?? { providers: new Map(), models: new Map() };
    pods.set(owner, pod);
    const db: PodModelSelectionDb = {
      async init() {},
      select() {
        return {
          from(resource: typeof aiModelResource) {
            return {
              where() {
                return {
                  async execute() {
                    return resource === aiModelResource
                      ? [...pod.models.values()].map((row) => structuredClone(row))
                      : [];
                  },
                };
              },
            };
          },
        };
      },
      async findById(resource, id) {
        const row = resource === aiProviderResource ? pod.providers.get(id) : pod.models.get(id);
        return structuredClone(row ?? null);
      },
      insert(resource) {
        return {
          values(value) {
            return {
              async execute() {
                const row = structuredClone(value);
                const store = resource === aiProviderResource ? pod.providers : pod.models;
                store.set(String(row.id), row);
                return [structuredClone(row)];
              },
            };
          },
        };
      },
      async updateById(resource, id, patch) {
        const store = resource === aiProviderResource ? pod.providers : pod.models;
        const row = store.get(id);
        if (!row) return null;
        Object.assign(row, structuredClone(patch));
        return structuredClone(row);
      },
      async deleteById(resource, id) {
        const store = resource === aiProviderResource ? pod.providers : pod.models;
        return store.delete(id);
      },
    };
    return db;
  });
  return { pods, dbFactory };
}

describe.runIf(RUN_INTEGRATION_TESTS)('AI Gateway Pod model selection isolation integration', () => {
  it('persists Alice selections across repository reloads while Bob remains empty', async () => {
    const fixture = createPersistentPodFactory();
    const makeRepository = () => new PodModelSelectionRepository({
      dbFactory: fixture.dbFactory,
      internalPodAccess: { getTrustedFetch: vi.fn(async () => fetch) },
      providerIds: ['openai', 'anthropic', 'kimi', 'bailian', 'deepseek'],
    });
    const first = makeRepository();
    const initial = await first.listSelection({ webId: ALICE, provider: 'openai', auth: auth(ALICE) });
    await first.replaceSelection({
      webId: ALICE,
      provider: 'openai',
      models: [{ id: 'gpt-5', modelType: 'chat', displayName: 'GPT-5' }],
      expectedVersion: initial.version,
      auth: auth(ALICE),
    });

    const reloaded = makeRepository();
    await expect(reloaded.listSelection({ webId: ALICE, provider: 'openai', auth: auth(ALICE) }))
      .resolves.toMatchObject({
        provider: 'openai',
        models: [expect.objectContaining({ id: 'openai.ttl#gpt-5', status: 'active' })],
      });
    await expect(reloaded.listSelection({ webId: BOB, provider: 'openai', auth: auth(BOB) }))
      .resolves.toMatchObject({ provider: 'openai', models: [] });

    expect(fixture.pods.get(ALICE)?.models.get('openai.ttl#gpt-5')).toMatchObject({
      isProvidedBy: 'https://pod.example/alice/settings/providers/openai.ttl',
    });
    expect(fixture.pods.get(BOB)?.models.size ?? 0).toBe(0);
  });
});
