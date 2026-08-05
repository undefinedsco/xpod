import { describe, expect, it, vi } from 'vitest';

import { encodePlaintextCredential } from '../../../src/api/ai-gateway/credentials/PlaintextCredentialPayload';
import type { AuthContext } from '../../../src/api/auth/AuthContext';
import {
  ProviderModelSelectionService,
  type ProviderModelCatalog,
} from '../../../src/api/ai-gateway/models/ProviderModelSelectionService';
import type { DiscoveredProviderModel } from '../../../src/api/ai-gateway/models/ProviderModelDiscoveryAdapters';
import type {
  PodModelSelection,
  PodSelectedModelInput,
} from '../../../src/api/ai-gateway/models/PodModelSelectionRepository';

const ALICE = 'https://pod.example/alice/profile/card#me';
const BOB = 'https://pod.example/bob/profile/card#me';
const AUTH_ALICE: AuthContext = { type: 'solid', webId: ALICE, scopes: ['models:read', 'models:write'] };
const AUTH_BOB: AuthContext = { type: 'solid', webId: BOB, scopes: ['models:read', 'models:write'] };

function selection(
  provider = 'openai',
  version = 'selection-v1',
  models: PodModelSelection['models'] = [],
): PodModelSelection {
  return { provider, models, version };
}

function picked(id: string, status: 'active' | 'inactive' = 'active'): PodModelSelection['models'][number] {
  return { id: `openai.ttl#${id}`, modelType: 'chat', status };
}

function createHarness(options: {
  now?: () => Date;
  selection?: PodModelSelection;
  secret?: Record<string, unknown>;
  adapterDiscover?: (secret: Record<string, unknown>) => Promise<DiscoveredProviderModel[]>;
} = {}) {
  let currentSelection = options.selection ?? selection();
  const adapter = {
    provider: 'openai',
    discover: vi.fn(async ({ secret }: { secret: Record<string, unknown> }) =>
      options.adapterDiscover ? options.adapterDiscover(secret) : [{ id: 'gpt-5', modelType: 'chat' as const }]),
  };
  const credentialRepository = {
    getActiveCredential: vi.fn(async ({ webId }: { webId: string }) => ({
      id: `${webId}-credential`,
      credentialIri: `${webId}/settings/ai/credentials/openai.ttl#credential`,
      webId,
      provider: 'openai',
      deployment: 'local' as const,
      authMode: 'apiKey' as const,
      storageMode: 'plaintext-v1' as const,
      secretPayload: encodePlaintextCredential(options.secret ?? { type: 'apiKey', apiKey: 'sk-test-secret' }),
      status: 'active' as const,
    })),
  };
  const selectionRepository = {
    listSelection: vi.fn(async () => currentSelection),
    reconcileAvailability: vi.fn(async () => currentSelection),
    replaceSelection: vi.fn(async (input: { models: readonly PodSelectedModelInput[]; expectedVersion?: string }) => {
      currentSelection = selection(
        currentSelection.provider,
        'selection-v2',
        input.models.map((model) => ({
          id: `openai.ttl#${typeof model === 'string' ? model : model.id}`,
          displayName: typeof model === 'string' ? undefined : model.displayName,
          modelType: typeof model === 'string' ? 'chat' : model.modelType,
          status: 'active' as const,
        })),
      );
      return currentSelection;
    }),
  };
  const discoveryRegistry = {
    get: vi.fn(() => adapter),
  };
  const service = new ProviderModelSelectionService({
    credentialRepository: credentialRepository as any,
    selectionRepository: selectionRepository as any,
    discoveryRegistry: discoveryRegistry as any,
    now: options.now,
  });
  return { service, adapter, credentialRepository, selectionRepository, discoveryRegistry, getSelection: () => currentSelection };
}

describe('ProviderModelSelectionService', () => {
  it('requires an active credential before provider discovery', async () => {
    const harness = createHarness();
    harness.credentialRepository.getActiveCredential.mockResolvedValue(undefined);

    await expect(harness.service.discover({
      webId: ALICE,
      provider: 'openai',
      deployment: 'local',
      auth: AUTH_ALICE,
    })).rejects.toThrow('active_credential_required');
    expect(harness.adapter.discover).not.toHaveBeenCalled();
  });

  it('reconciles durable picks after a successful discovery', async () => {
    const harness = createHarness({
      selection: selection('openai', 'selection-v1', [picked('gpt-5'), picked('old', 'inactive')]),
      adapterDiscover: async () => [
        { id: 'gpt-5', displayName: 'GPT-5', modelType: 'chat' },
        { id: 'gpt-4.1', modelType: 'chat' },
      ],
    });
    const catalog = await harness.service.discover({
      webId: ALICE,
      provider: 'openai',
      deployment: 'local',
      auth: AUTH_ALICE,
    });

    expect(catalog).toMatchObject({ provider: 'openai', status: 'ready', version: 'selection-v1' });
    expect(catalog.models).toEqual([
      { id: 'gpt-5', displayName: 'GPT-5', modelType: 'chat', selected: true, availability: 'available' },
      { id: 'gpt-4.1', modelType: 'chat', selected: false, availability: 'available' },
      { id: 'openai.ttl#old', modelType: 'chat', selected: true, availability: 'unavailable' },
    ]);
    expect(harness.selectionRepository.reconcileAvailability).toHaveBeenCalledWith(expect.objectContaining({
      webId: ALICE,
      provider: 'openai',
      discoveredModels: [
        { id: 'gpt-5', displayName: 'GPT-5', modelType: 'chat' },
        { id: 'gpt-4.1', modelType: 'chat' },
      ],
      auth: AUTH_ALICE,
    }));
  });

  it('returns statusUnknown on discovery failure without changing durable unavailable state', async () => {
    const secret = 'sk-error-secret';
    const harness = createHarness({
      secret: { type: 'apiKey', apiKey: secret },
      selection: selection('openai', 'selection-v4', [picked('gpt-5'), picked('old', 'inactive')]),
      adapterDiscover: async () => { throw new Error(`upstream leaked ${secret}`); },
    });

    const catalog = await harness.service.discover({
      webId: ALICE,
      provider: 'openai',
      deployment: 'local',
      auth: AUTH_ALICE,
    });

    expect(catalog).toMatchObject({ provider: 'openai', status: 'statusUnknown', version: 'selection-v4' });
    expect(catalog.models).toEqual([
      { id: 'openai.ttl#gpt-5', modelType: 'chat', selected: true, availability: 'statusUnknown' },
      { id: 'openai.ttl#old', modelType: 'chat', selected: true, availability: 'unavailable' },
    ]);
    expect(harness.selectionRepository.reconcileAvailability).not.toHaveBeenCalled();
    expect(JSON.stringify(catalog)).not.toContain(secret);
  });

  it('rejects model ids outside the latest discovered catalog before atomic replacement', async () => {
    const harness = createHarness();
    const catalog = await harness.service.discover({
      webId: ALICE,
      provider: 'openai',
      deployment: 'local',
      auth: AUTH_ALICE,
    });

    await expect(harness.service.replaceSelection({
      webId: ALICE,
      provider: 'openai',
      modelIds: ['invented-model'],
      expectedVersion: catalog.version,
      auth: AUTH_ALICE,
    })).rejects.toThrow('model_not_in_discovered_catalog');
    expect(harness.selectionRepository.replaceSelection).not.toHaveBeenCalled();
  });

  it('isolates cache entries by WebID and provider', async () => {
    const calls: string[] = [];
    const harness = createHarness({ adapterDiscover: async () => [{ id: 'gpt-5', modelType: 'chat' }] });
    harness.adapter.discover.mockImplementation(async ({ secret }: { secret: Record<string, unknown> }) => {
      calls.push(String(secret.apiKey));
      return [{ id: 'gpt-5', modelType: 'chat' }];
    });

    await harness.service.discover({ webId: ALICE, provider: 'openai', deployment: 'local', auth: AUTH_ALICE });
    await harness.service.discover({ webId: ALICE, provider: 'openai', deployment: 'local', auth: AUTH_ALICE });
    await harness.service.discover({ webId: BOB, provider: 'openai', deployment: 'local', auth: AUTH_BOB });
    await harness.service.discover({ webId: ALICE, provider: 'anthropic', deployment: 'local', auth: AUTH_ALICE });

    expect(calls).toHaveLength(3);
    expect(harness.discoveryRegistry.get).toHaveBeenCalledWith('openai');
    expect(harness.discoveryRegistry.get).toHaveBeenCalledWith('anthropic');
  });

  it('expires catalogs at the five-minute boundary', async () => {
    let now = new Date('2026-08-05T00:00:00.000Z');
    const harness = createHarness({ now: () => now });

    await harness.service.discover({ webId: ALICE, provider: 'openai', deployment: 'local', auth: AUTH_ALICE });
    now = new Date('2026-08-05T00:04:59.999Z');
    await harness.service.discover({ webId: ALICE, provider: 'openai', deployment: 'local', auth: AUTH_ALICE });
    expect(harness.adapter.discover).toHaveBeenCalledTimes(1);

    now = new Date('2026-08-05T00:05:00.000Z');
    await harness.service.discover({ webId: ALICE, provider: 'openai', deployment: 'local', auth: AUTH_ALICE });
    expect(harness.adapter.discover).toHaveBeenCalledTimes(2);
  });

  it('deduplicates a refresh started exactly at the expiry boundary', async () => {
    let now = new Date('2026-08-05T00:00:00.000Z');
    const harness = createHarness({ now: () => now });
    await harness.service.discover({ webId: ALICE, provider: 'openai', deployment: 'local', auth: AUTH_ALICE });

    now = new Date('2026-08-05T00:05:00.000Z');
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const refreshStarted = new Promise<void>((resolve) => { started = resolve; });
    harness.adapter.discover.mockImplementation(async () => {
      started();
      await gate;
      return [{ id: 'gpt-5', modelType: 'chat' }];
    });

    const first = harness.service.discover({ webId: ALICE, provider: 'openai', deployment: 'local', auth: AUTH_ALICE });
    const second = harness.service.discover({ webId: ALICE, provider: 'openai', deployment: 'local', auth: AUTH_ALICE });
    await refreshStarted;
    expect(harness.adapter.discover).toHaveBeenCalledTimes(2);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('deduplicates concurrent discovery and does not cache decoded secrets', async () => {
    let release!: () => void;
    let discoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { discoveryStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const secret = 'sk-only-on-stack';
    const harness = createHarness({
      secret: { type: 'apiKey', apiKey: secret },
      adapterDiscover: async (received) => {
        expect(received.apiKey).toBe(secret);
        discoveryStarted();
        await gate;
        return [{ id: 'gpt-5', modelType: 'chat' }];
      },
    });

    const first = harness.service.discover({ webId: ALICE, provider: 'openai', deployment: 'local', auth: AUTH_ALICE });
    const second = harness.service.discover({ webId: ALICE, provider: 'openai', deployment: 'local', auth: AUTH_ALICE });
    await started;
    expect(harness.adapter.discover).toHaveBeenCalledTimes(1);
    release();
    const catalogs = await Promise.all([first, second]);
    expect(catalogs[0]).toEqual(catalogs[1]);
    expect(JSON.stringify(catalogs[0])).not.toContain(secret);
  });

  it('uses the cached catalog version and repository expectedVersion for atomic replacement', async () => {
    const harness = createHarness();
    const catalog = await harness.service.discover({
      webId: ALICE,
      provider: 'openai',
      deployment: 'local',
      auth: AUTH_ALICE,
    });

    const next = await harness.service.replaceSelection({
      webId: ALICE,
      provider: 'openai',
      modelIds: ['gpt-5'],
      defaultModel: 'gpt-5',
      expectedVersion: catalog.version,
      auth: AUTH_ALICE,
    });

    expect(harness.selectionRepository.replaceSelection).toHaveBeenCalledWith(expect.objectContaining({
      webId: ALICE,
      provider: 'openai',
      models: [{ id: 'gpt-5', modelType: 'chat', status: 'active' }],
      defaultModel: 'gpt-5',
      expectedVersion: catalog.version,
      auth: AUTH_ALICE,
    }));
    expect(next).toMatchObject({ status: 'ready', version: 'selection-v2' });
  });
});
