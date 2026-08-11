import { describe, expect, it, vi } from 'vitest';

import { encodePlaintextCredential } from '../../../src/api/ai-gateway/credentials/PlaintextCredentialPayload';
import type { AuthContext } from '../../../src/api/auth/AuthContext';
import { GatewayProtocolError } from '../../../src/api/ai-gateway/errors';
import {
  ProviderModelSelectionService,
  type ProviderModelDiscoveryServiceLike,
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
  provider?: string;
  now?: () => Date;
  selection?: PodModelSelection;
  secret?: Record<string, unknown>;
  credential?: Record<string, unknown>;
  modelsService?: ProviderModelDiscoveryServiceLike;
  credentialVault?: { open: ReturnType<typeof vi.fn> };
  adapterDiscover?: (
    secret: Record<string, unknown>,
    input?: Record<string, unknown>,
  ) => Promise<DiscoveredProviderModel[]>;
} = {}) {
  const provider = options.provider ?? 'openai';
  let currentSelection = options.selection ?? selection(provider);
  const adapter = {
    provider,
    discover: vi.fn(async ({ secret, ...input }: { secret: Record<string, unknown>; [key: string]: unknown }) =>
      options.adapterDiscover
        ? options.adapterDiscover(secret, input)
        : [{ id: 'gpt-5', modelType: 'chat' as const }]),
  };
  const credentialRepository = {
    getActiveCredential: vi.fn(async ({ webId }: { webId: string }) => ({
      id: `${webId}-credential`,
      credentialIri: `${webId}/settings/ai/credentials/${provider}.ttl#credential`,
      webId,
      provider,
      deployment: 'local' as const,
      authMode: 'apiKey' as const,
      storageMode: 'plaintext-v1' as const,
      secretPayload: encodePlaintextCredential(options.secret ?? { type: 'apiKey', apiKey: 'sk-test-secret' }),
      status: 'active' as const,
      ...options.credential,
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
    modelsService: options.modelsService,
    credentialVault: options.credentialVault as any,
    now: options.now,
  });
  return { service, adapter, credentialRepository, selectionRepository, discoveryRegistry, getSelection: () => currentSelection };
}

describe('ProviderModelSelectionService', () => {
  it('requires an active credential before provider discovery', async () => {
    const harness = createHarness();
    harness.credentialRepository.getActiveCredential.mockResolvedValue(undefined as any);

    await expect(harness.service.discover({
      webId: ALICE,
      provider: 'openai',
      deployment: 'local',
      auth: AUTH_ALICE,
    })).rejects.toThrow('active_credential_required');
    expect(harness.adapter.discover).not.toHaveBeenCalled();
  });

  it('passes the active credential offering and transport settings to discovery', async () => {
    let received: Record<string, unknown> | undefined;
    const harness = createHarness({
      provider: 'kimi',
      credential: {
        id: 'kimi-token-plan',
        credentialIri: `${ALICE}/settings/ai/credentials/kimi-token-plan.ttl#credential`,
        offeringId: 'subscription-key',
        metadata: {
          baseUrl: 'https://api.kimi.com/coding/v1',
          proxyUrl: 'http://proxy.example:8080',
          compatibility: 'openai',
        },
      },
      adapterDiscover: async (_secret, input) => {
        received = input;
        return [{ id: 'kimi-for-coding', modelType: 'chat' }];
      },
    });

    await harness.service.discover({
      webId: ALICE,
      provider: 'kimi',
      deployment: 'local',
      auth: AUTH_ALICE,
    });

    expect(received).toEqual(expect.objectContaining({
      baseUrl: 'https://api.kimi.com/coding/v1',
      proxyUrl: 'http://proxy.example:8080',
      offeringId: 'subscription-key',
      compatibility: 'openai',
      credentialId: 'kimi-token-plan',
      credentialIri: `${ALICE}/settings/ai/credentials/kimi-token-plan.ttl#credential`,
    }));
  });

  it('uses a custom credential endpoint and proxy instead of the provider fallback', async () => {
    let received: Record<string, unknown> | undefined;
    const harness = createHarness({
      provider: 'custom',
      credential: {
        id: 'custom-endpoint',
        offeringId: 'openai-compatible',
        metadata: {
          baseUrl: 'https://custom.example/v1',
          proxyUrl: 'https://proxy.example:8443',
          compatibility: 'auto',
        },
      },
      adapterDiscover: async (_secret, input) => {
        received = input;
        return [{ id: 'custom-model', modelType: 'chat' }];
      },
    });

    await harness.service.discover({
      webId: ALICE,
      provider: 'custom',
      deployment: 'local',
      auth: AUTH_ALICE,
    });

    expect(received).toEqual(expect.objectContaining({
      baseUrl: 'https://custom.example/v1',
      proxyUrl: 'https://proxy.example:8443',
      offeringId: 'openai-compatible',
      compatibility: 'auto',
    }));
  });

  it('uses the caller-owned offering-aware model service when one is injected', async () => {
    const modelsService: ProviderModelDiscoveryServiceLike = {
      listFromSecret: vi.fn(async (input) => {
        expect(input).toMatchObject({
          provider: 'kimi',
          offeringId: 'subscription-key',
          credentialId: 'kimi-token-plan',
          baseUrl: 'https://api.kimi.com/coding/v1',
          proxyUrl: 'http://proxy.example:8080',
          compatibility: 'openai',
        });
        return { models: [{ id: 'kimi-for-coding', modelType: 'chat' }] };
      }),
    };
    const harness = createHarness({
      provider: 'kimi',
      modelsService,
      credential: {
        id: 'kimi-token-plan',
        offeringId: 'subscription-key',
        metadata: {
          baseUrl: 'https://api.kimi.com/coding/v1',
          proxyUrl: 'http://proxy.example:8080',
          compatibility: 'openai',
        },
      },
    });

    await expect(harness.service.discover({
      webId: ALICE,
      provider: 'kimi',
      deployment: 'local',
      auth: AUTH_ALICE,
    })).resolves.toMatchObject({
      status: 'ready',
      models: [expect.objectContaining({ id: 'kimi-for-coding', modelType: 'chat' })],
    });
    expect(modelsService.listFromSecret).toHaveBeenCalledTimes(1);
    expect(harness.adapter.discover).not.toHaveBeenCalled();
  });

  it('opens the selected secret-cell credential before caller-owned discovery', async () => {
    const encryptedSecret = {
      algorithm: 'test-cell',
      webId: ALICE,
      credentialIri: `${ALICE}/settings/ai/credentials/openai.ttl#credential`,
      provider: 'openai',
      ciphertext: 'opaque',
    };
    const credentialVault = {
      open: vi.fn(async () => ({ type: 'apiKey', apiKey: 'sk-vault-secret' })),
    };
    const modelsService: ProviderModelDiscoveryServiceLike = {
      listFromSecret: vi.fn(async (input) => {
        expect(input.secret).toEqual({ type: 'apiKey', apiKey: 'sk-vault-secret' });
        return { models: [{ id: 'gpt-vault', modelType: 'chat' }] };
      }),
    };
    const harness = createHarness({
      modelsService,
      credentialVault,
      credential: {
        storageMode: undefined,
        secretPayload: undefined,
        encryptedSecret,
      },
    });

    await expect(harness.service.discover({
      webId: ALICE,
      provider: 'openai',
      deployment: 'local',
      auth: AUTH_ALICE,
    })).resolves.toMatchObject({ models: [expect.objectContaining({ id: 'gpt-vault' })] });
    expect(credentialVault.open).toHaveBeenCalledWith(
      { webId: ALICE },
      `${ALICE}/settings/ai/credentials/openai.ttl#credential`,
      'openai',
      encryptedSecret,
    );
  });

  it('isolates the discovery cache when the active credential or offering changes', async () => {
    let activeCredential: Record<string, unknown> = {
      id: 'kimi-token-plan',
      credentialIri: `${ALICE}/settings/ai/credentials/kimi-token-plan.ttl#credential`,
      offeringId: 'subscription-key',
      metadata: { baseUrl: 'https://api.kimi.com/coding/v1' },
    };
    const calls: Record<string, unknown>[] = [];
    const harness = createHarness({
      provider: 'kimi',
      adapterDiscover: async (_secret, input) => {
        calls.push(input ?? {});
        return [{ id: String(input?.offeringId), modelType: 'chat' }];
      },
    });
    harness.credentialRepository.getActiveCredential.mockImplementation(async () => ({
      id: String(activeCredential.id),
      credentialIri: String(activeCredential.credentialIri),
      webId: ALICE,
      provider: 'kimi',
      deployment: 'local' as const,
      authMode: 'apiKey' as const,
      storageMode: 'plaintext-v1',
      secretPayload: encodePlaintextCredential({ type: 'apiKey', apiKey: 'sk-test-secret' }),
      status: 'active' as const,
      ...activeCredential,
    } as any));

    const input = { webId: ALICE, provider: 'kimi', deployment: 'local' as const, auth: AUTH_ALICE };
    await harness.service.discover(input);
    await harness.service.discover(input);
    activeCredential = {
      id: 'kimi-api-platform',
      credentialIri: `${ALICE}/settings/ai/credentials/kimi-api-platform.ttl#credential`,
      offeringId: 'api-platform',
      metadata: { baseUrl: 'https://api.moonshot.ai/v1' },
    };
    await harness.service.discover(input);

    expect(harness.adapter.discover).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => call.offeringId)).toEqual(['subscription-key', 'api-platform']);
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

    const retry = await harness.service.discover({
      webId: ALICE,
      provider: 'openai',
      deployment: 'local',
      auth: AUTH_ALICE,
    });
    expect(retry).toMatchObject({
      provider: 'openai',
      status: 'statusUnknown',
      version: 'selection-v4',
      models: catalog.models,
    });
    expect(harness.adapter.discover).toHaveBeenCalledTimes(2);
  });

  it('does not cache a transient failure and retries the provider on the next discovery', async () => {
    let calls = 0;
    const harness = createHarness({
      adapterDiscover: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('temporary upstream outage');
        }
        return [{ id: 'gpt-5', modelType: 'chat' }];
      },
    });

    await expect(harness.service.discover({
      webId: ALICE,
      provider: 'openai',
      deployment: 'local',
      auth: AUTH_ALICE,
    })).resolves.toMatchObject({ status: 'statusUnknown' });
    await expect(harness.service.discover({
      webId: ALICE,
      provider: 'openai',
      deployment: 'local',
      auth: AUTH_ALICE,
    })).resolves.toMatchObject({ status: 'ready' });
    expect(harness.adapter.discover).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: 'reauthentication metadata',
      error: new GatewayProtocolError('provider auth failed', {
        code: 'provider_error',
        status: 401,
        details: { provider: 'openai', providerStatusCode: 401, reauthRequired: true },
      }),
    },
    {
      name: 'rate-limit metadata',
      error: new GatewayProtocolError('provider rate limited', {
        code: 'provider_error',
        status: 429,
        details: { provider: 'openai', providerStatusCode: 429, retryAfter: '30' },
      }),
    },
    {
      name: 'unsafe endpoint classification',
      error: new GatewayProtocolError('provider endpoint is not allowed', {
        code: 'invalid_request',
        status: 400,
        details: { provider: 'openai', classification: 'unsafe_base_url' },
      }),
    },
    {
      name: 'unconfigured provider classification',
      error: new GatewayProtocolError('provider is not configured', {
        code: 'invalid_request',
        status: 400,
        details: { provider: 'openai', classification: 'not_configured' },
      }),
    },
  ])('rethrows adapter $name errors with stable metadata', async ({ error }) => {
    const harness = createHarness({ adapterDiscover: async () => { throw error; } });

    await expect(harness.service.discover({
      webId: ALICE,
      provider: 'openai',
      deployment: 'local',
      auth: AUTH_ALICE,
    })).rejects.toBe(error);
    expect(harness.adapter.discover).toHaveBeenCalledTimes(1);
    await expect(harness.service.discover({
      webId: ALICE,
      provider: 'openai',
      deployment: 'local',
      auth: AUTH_ALICE,
    })).rejects.toBe(error);
    expect(harness.adapter.discover).toHaveBeenCalledTimes(2);
  });

  it('rethrows abort errors and does not cache the cancellation', async () => {
    const abortError = new Error('request cancelled');
    abortError.name = 'AbortError';
    const abortedController = new AbortController();
    abortedController.abort(abortError);
    const retryController = new AbortController();
    let calls = 0;
    const harness = createHarness({
      adapterDiscover: async () => {
        calls += 1;
        if (calls === 1) {
          throw abortError;
        }
        return [{ id: 'gpt-5', modelType: 'chat' }];
      },
    });

    await expect(harness.service.discover({
      webId: ALICE,
      provider: 'openai',
      deployment: 'local',
      auth: AUTH_ALICE,
      signal: abortedController.signal,
    })).rejects.toBe(abortError);
    await expect(harness.service.discover({
      webId: ALICE,
      provider: 'openai',
      deployment: 'local',
      auth: AUTH_ALICE,
      signal: retryController.signal,
    })).resolves.toMatchObject({ status: 'ready' });
    expect(harness.adapter.discover).toHaveBeenCalledTimes(2);
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

  it('force refresh bypasses a fresh ready catalog while the default path still uses the cache', async () => {
    let calls = 0;
    const harness = createHarness({
      adapterDiscover: async () => [{ id: `gpt-${++calls}`, modelType: 'chat' }],
    });
    const input = { webId: ALICE, provider: 'openai', deployment: 'local' as const, auth: AUTH_ALICE };

    await expect(harness.service.discover(input)).resolves.toMatchObject({
      models: [expect.objectContaining({ id: 'gpt-1' })],
    });
    await expect(harness.service.discover(input)).resolves.toMatchObject({
      models: [expect.objectContaining({ id: 'gpt-1' })],
    });
    await expect(harness.service.discover({ ...input, forceRefresh: true })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: 'gpt-2' })],
    });
    expect(harness.adapter.discover).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent force refreshes for the same WebID/provider key', async () => {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const harness = createHarness({
      adapterDiscover: async () => {
        started();
        await gate;
        return [{ id: 'gpt-refresh', modelType: 'chat' }];
      },
    });
    const input = { webId: ALICE, provider: 'openai', deployment: 'local' as const, auth: AUTH_ALICE, forceRefresh: true };

    const first = harness.service.discover(input);
    const second = harness.service.discover(input);
    await startedPromise;
    expect(harness.adapter.discover).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('keeps the last ready cache available after a force refresh fails', async () => {
    let calls = 0;
    const harness = createHarness({
      adapterDiscover: async () => {
        calls += 1;
        if (calls === 2) throw new Error('fixture provider temporarily unavailable');
        return [{ id: 'gpt-5', modelType: 'chat' }];
      },
    });
    const input = { webId: ALICE, provider: 'openai', deployment: 'local' as const, auth: AUTH_ALICE };

    const ready = await harness.service.discover(input);
    const unknown = await harness.service.discover({ ...input, forceRefresh: true });
    expect(ready.status).toBe('ready');
    expect(unknown.status).toBe('statusUnknown');
    await expect(harness.service.getCatalog(input)).resolves.toMatchObject({
      status: 'ready',
      models: [expect.objectContaining({ id: 'gpt-5', availability: 'available' })],
    });
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

  it('rejects a default model that is not part of the requested selection', async () => {
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
      modelIds: ['gpt-5'],
      defaultModel: 'gpt-4.1',
      expectedVersion: catalog.version,
      auth: AUTH_ALICE,
    })).rejects.toMatchObject({
      message: 'model_selection_default_not_picked',
      code: 'invalid_request',
      status: 400,
    });
    expect(harness.selectionRepository.replaceSelection).not.toHaveBeenCalled();
  });
});
