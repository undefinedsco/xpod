import { describe, expect, it, vi } from 'vitest';
import { PlatformGatewayCredentialStore, platformGatewayConfiguration, registerPlatformGatewayProvider } from '../../../src/api/ai-gateway/credentials/PlatformGatewayCredentialStore';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import { ProviderRuntimeRegistry } from '../../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import { ProviderHttpTransport } from '../../../src/api/service/provider-http-transport';
import { ModelRouter } from '../../../src/api/ai-gateway/routing/ModelRouter';
import { InMemorySessionAffinityStore } from '../../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import { AiGatewayService, type GatewayCredentialStore } from '../../../src/api/ai-gateway/AiGatewayService';
import type { AuthContext } from '../../../src/api/auth/AuthContext';

const input = { webId: 'https://id.example/new/profile#me', deployment: 'cloud' };
const config = { provider: 'platform-undefineds', baseUrl: 'https://platform.example/v1', apiKey: 'secret-platform-test', defaultModel: 'linx-lite' };
const auth: AuthContext = { type: 'solid', webId: input.webId, accessToken: 'caller-token', tokenType: 'Bearer' };

function setup(personal: GatewayCredentialStore = { listCredentials: async() => [] }) {
  let clock = 1_000;
  let failure = false;
  let empty = false;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const transport = new ProviderHttpTransport({
    resolver: async() => [{ address: '93.184.216.34', family: 4 }],
    fetch: (async(url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
      if (String(url).endsWith('/models')) {
        if (failure) return new Response('unavailable', { status: 503 });
        return Response.json({ data: empty ? [] : [{ id: 'linx-lite' }, { id: 'linx-pro', display_name: 'Linx Pro' }] });
      }
      return new Response('data: {"id":"chatcmpl-platform","choices":[{"index":0,"delta":{"content":"platform answer"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch,
  });
  const registry = createDefaultProviderRegistry();
  registerPlatformGatewayProvider(registry, config);
  const store = new PlatformGatewayCredentialStore({ config, personal, transport, now: () => clock });
  const router = new ModelRouter({ registry, affinityStore: new InMemorySessionAffinityStore({ secret: '0123456789abcdef0123456789abcdef' }), credentials: store.listCredentials.bind(store) });
  const service = new AiGatewayService({ deployment: 'cloud', registry, router, credentials: store, runtimes: new ProviderRuntimeRegistry({ registry, transport }), vault: { open: vi.fn(), seal: vi.fn(), rewrap: vi.fn() } });
  return { store, service, registry, calls, advance: () => { clock += 61_000; }, fail: () => { failure = true; }, empty: () => { empty = true; } };
}

describe('platform Gateway capacity', () => {
  it('does not fabricate capacity without a deployment endpoint and secret', () => {
    expect(platformGatewayConfiguration({})).toBeUndefined();
    expect(platformGatewayConfiguration({ DEFAULT_MODEL: 'fake', DEFAULT_API_KEY: 'key' })).toBeUndefined();
    expect(platformGatewayConfiguration({ DEFAULT_API_BASE: 'https://platform.example/v1', DEFAULT_API_KEY: 'key', DEFAULT_PROVIDER: 'undefineds' })?.provider).toBe('platform-undefineds');
    expect(() => platformGatewayConfiguration({ DEFAULT_API_BASE: 'https://key@platform.example/v1', DEFAULT_API_KEY: 'key' })).toThrow('invalid_platform_provider_endpoint');
  });

  it('gives a new user discovered models and Chat through the same generic runtime without leaking service secrets', async() => {
    const fixture = setup();
    const models = await fixture.service.listModels(auth);
    expect(models.map((model) => model.id)).toEqual(['linx-lite', 'linx-pro']);
    expect(JSON.stringify(models)).not.toContain(config.apiKey);
    const response = await fixture.service.complete({ auth, protocol: 'chatCompletions', body: { model: 'linx-pro', messages: [{ role: 'user', content: 'hello' }] } });
    expect(JSON.stringify(response)).toContain('platform answer');
    expect(JSON.stringify(response)).not.toContain(config.apiKey);
    expect(fixture.calls.map((call) => call.url)).toEqual([`${config.baseUrl}/models`, `${config.baseUrl}/chat/completions`]);
    expect(fixture.calls.every((call) => call.authorization === `Bearer ${config.apiKey}`)).toBe(true);
    expect(fixture.registry.isProvidedInDeployment(config.provider, 'cloud')).toBe(true);
    expect(fixture.registry.requireProvider('openai').defaultBaseUrl).toBe('https://api.openai.com/v1');
  });

  it('coalesces discovery, retains verified discovery on upstream failure, and retains the operator default for an empty list', async() => {
    const fixture = setup();
    await Promise.all([fixture.store.listCredentials(input), fixture.store.listCredentials(input)]);
    expect(fixture.calls).toHaveLength(1);
    fixture.advance();
    fixture.fail();
    expect((await fixture.store.listCredentials(input))[0].models).toEqual(['linx-lite', 'linx-pro']);
    const empty = setup();
    empty.empty();
    expect((await empty.store.listCredentials(input))[0].models).toEqual(['linx-lite']);
  });

  it('uses only an explicitly configured default on initial discovery failure', async() => {
    const fixture = setup();
    fixture.fail();
    expect((await fixture.store.listCredentials(input))[0].models).toEqual(['linx-lite']);
  });

  it('keeps platform lifecycle out of the personal repository and preserves personal delegation', async() => {
    const personal = { listCredentials: vi.fn(async() => []), recordSuccess: vi.fn(), recordFailure: vi.fn(), renewCredential: vi.fn(async() => true), rewrapCredential: vi.fn(async() => true) };
    const fixture = setup(personal);
    const platform = (await fixture.store.listCredentials(input))[0];
    const health = { ...input, provider: platform.provider, credentialId: platform.id, credentialIri: platform.credentialIri };
    await fixture.store.recordSuccess(health);
    await fixture.store.recordFailure(health);
    expect(await fixture.store.renewCredential({ ...health, reason: 'authentication_failed' })).toBe(false);
    expect(personal.recordSuccess).not.toHaveBeenCalled();
    expect(personal.recordFailure).not.toHaveBeenCalled();
    expect(personal.renewCredential).not.toHaveBeenCalled();
    const own = { ...health, credentialId: 'own', credentialIri: 'https://pod.example/credentials#own' };
    await fixture.store.recordSuccess(own);
    await fixture.store.recordFailure(own);
    expect(await fixture.store.renewCredential({ ...own, reason: 'expired' })).toBe(true);
    expect(personal.recordSuccess).toHaveBeenCalledWith(own);
    expect(personal.recordFailure).toHaveBeenCalledWith(own);
  });

  it('keeps authentication failure and transient cooldown in platform process state', async() => {
    const fixture = setup();
    const platform = (await fixture.store.listCredentials(input))[0];
    const health = { ...input, provider: platform.provider, credentialId: platform.id, credentialIri: platform.credentialIri };
    await fixture.store.recordFailure({ ...health, status: 429 });
    expect((await fixture.store.listCredentials(input))[0].cooldownUntil).toEqual(new Date(61_000));
    await fixture.store.recordSuccess(health);
    expect((await fixture.store.listCredentials(input))[0].cooldownUntil).toBeUndefined();
    await fixture.store.recordFailure({ ...health, status: 401 });
    expect((await fixture.store.listCredentials(input))[0].health).toBe('invalid');
  });
});
