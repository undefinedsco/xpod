import { describe, expect, it, vi } from 'vitest';

import {
  AiGatewayService,
  type GatewayCredentialStore,
  type StoredGatewayCredential,
} from '../../../src/api/ai-gateway/AiGatewayService';
import { encodePlaintextCredential } from '../../../src/api/ai-gateway/credentials/PlaintextCredentialPayload';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import type { ProviderRuntimeRegistry } from '../../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import { InMemorySessionAffinityStore } from '../../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import { ModelRouter, type GatewayModelSelection } from '../../../src/api/ai-gateway/routing/ModelRouter';
import type { AuthContext } from '../../../src/api/auth/AuthContext';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const AUTH: AuthContext = { type: 'solid', webId: WEB_ID, viaApiKey: true };

function credential(id: string, provider: string): StoredGatewayCredential {
  return {
    id,
    credentialIri: `https://pod.example/settings/credentials.ttl#${id}`,
    provider,
    authMode: 'apiKey',
    enabled: true,
    models: [],
    health: 'healthy',
    quota: { status: 'available' },
    storageMode: 'plaintext-v1',
    secretPayload: encodePlaintextCredential({ type: 'apiKey', apiKey: `sk-${id}` }),
  };
}

function selection(provider: string, id: string): GatewayModelSelection {
  return {
    provider,
    models: [{ id: `${provider}.ttl#${id}`, modelType: 'chat', status: 'active' }],
    version: `sha256:${provider}`,
  };
}

function createService(selections: GatewayModelSelection[]): AiGatewayService {
  const registry = createDefaultProviderRegistry();
  const credentials: GatewayCredentialStore = {
    listCredentials: vi.fn(async() => [
      credential('openai-key', 'openai'),
      credential('anthropic-key', 'anthropic'),
    ]),
  };
  const runtimes = {
    get: vi.fn(() => ({
      execute: vi.fn(async function* () {
        yield { type: 'response.started', id: 'resp_fixture' };
        yield { type: 'text.delta', text: 'ok' };
        yield { type: 'response.completed', finishReason: 'stop' };
      }),
    })),
  } as unknown as ProviderRuntimeRegistry;
  const selectionRepository = {
    listActiveSelections: vi.fn(async() => selections),
  };
  return new AiGatewayService({
    deployment: 'cloud',
    registry,
    router: new ModelRouter({
      registry,
      affinityStore: new InMemorySessionAffinityStore({ secret: '0123456789abcdef0123456789abcdef' }),
      credentials: credentials.listCredentials,
      selectionRepository,
    }),
    credentials,
    runtimes,
  });
}

describe('AI Gateway protocol/model selection integration', () => {
  it('exposes and routes only the same active picks across Responses, Chat and Messages', async() => {
    const service = createService([
      selection('openai', 'gpt-5'),
      selection('anthropic', 'claude-sonnet-4-5-20250929'),
    ]);

    await expect(service.listModels(AUTH)).resolves.toEqual([
      expect.objectContaining({ id: 'gpt-5', owned_by: 'openai' }),
      expect.objectContaining({ id: 'claude-sonnet-4-5-20250929', owned_by: 'anthropic' }),
    ]);
    await expect(service.complete({
      auth: AUTH,
      protocol: 'responses',
      body: { model: 'gpt-5', input: [{ role: 'user', content: 'hello' }] },
    })).resolves.toMatchObject({ model: 'gpt-5' });
    await expect(service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: { model: 'gpt-5', messages: [{ role: 'user', content: 'hello' }] },
    })).resolves.toMatchObject({ model: 'gpt-5' });
    await expect(service.complete({
      auth: AUTH,
      protocol: 'anthropic',
      body: { model: 'claude-sonnet-4-5-20250929', messages: [{ role: 'user', content: 'hello' }] },
    })).resolves.toMatchObject({ model: 'claude-sonnet-4-5-20250929' });
  });

  it('returns a secret-free model_not_available error for an unpicked model', async() => {
    const service = createService([selection('openai', 'gpt-5')]);

    await expect(service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: { model: 'gpt-4.1', messages: [{ role: 'user', content: 'hello' }] },
    })).rejects.toMatchObject({ code: 'model_not_available', status: 404 });
    await expect(service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: { model: 'gpt-4.1', messages: [{ role: 'user', content: 'hello' }] },
    })).rejects.not.toThrow(/sk-openai-key/);
  });
});
