import { describe, it, expect, vi } from 'vitest';
import { DeclaredUsageQuotaAdapter } from '../../../src/api/ai-gateway/quota/DeclaredUsageQuotaAdapter';
import { createDefaultProviderRegistry, type ProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import { ProviderHttpTransport } from '../../../src/api/service/provider-http-transport';
import type { QuotaCredentialRecord } from '../../../src/api/ai-gateway/quota/ProviderQuotaAdapter';

const credential = { id: 'owned', credentialIri: 'https://pod.example/settings/credentials.ttl#owned', provider: 'custom', offeringId: 'opencode-go', authMode: 'apiKey', proxyUrl: 'http://proxy.example:7897', baseUrl: 'https://other.example/v1' } as QuotaCredentialRecord;
const input = { credential, secret: { type: 'apiKey' as const, apiKey: 'test-private' }, now: new Date('2026-11-23T00:00:00Z') };
const meter = (percent: number, status = 'ok') => ({ percent, status, resetsAt: '2026-12-01T00:00:00Z' });
const valid = () => ({ usage: { rolling: meter(0), weekly: meter(4), monthly: meter(100, 'rate-limited') } });
function fixture(registry = createDefaultProviderRegistry()) {
  const transport = new ProviderHttpTransport();
  const getJson = vi.spyOn(transport, 'getJson').mockResolvedValue(valid());
  return { adapter: new DeclaredUsageQuotaAdapter({ providerRegistry: registry, transport }), getJson };
}
describe('declared usage percentage windows', () => {
  it('uses the declared endpoint, preserves proxy/signal, and normalizes all meters', async () => {
    const { adapter, getJson } = fixture();
    const signal = new AbortController().signal;
    const result = await adapter.fetch({ ...input, signal });
    expect(result).toMatchObject({ status: 'available', expiresAt: '2026-11-23T00:05:00.000Z', windows: [
      { name: 'five-hour', used: 0, remaining: 100, limit: 100 },
      { name: 'weekly', used: 4, remaining: 96, limit: 100 },
      { name: 'monthly', used: 100, remaining: 0, limit: 100 },
    ] });
    expect(getJson).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://opencode.ai/inference/go/v1/usage', proxy: credential.proxyUrl, signal, headers: expect.objectContaining({ authorization: 'Bearer test-private' }) }));
    expect(JSON.stringify(result)).not.toContain('test-private');
  });
  it('does not send a generic custom key anywhere even when its Base URL resembles Go', async () => {
    const { adapter, getJson } = fixture();
    const undeclared = { ...credential, offeringId: 'openai-compatible', baseUrl: 'https://opencode.ai/inference/go/openai/v1' };
    expect(adapter.supports(undeclared)).toBe(false);
    expect((await adapter.fetch({ ...input, credential: undeclared })).status).toBe('unsupported');
    expect(getJson).not.toHaveBeenCalled();
  });
  it('supports a different program-declared window map without a provider branch', async () => {
    const registry = { getOffering: () => ({ upstream: [{ capability: 'quota', protocol: 'usage-percent-windows', options: { url: 'https://meter.example/usage', windows: { daily: 'daily' } } }] }) } as unknown as ProviderRegistry;
    const { adapter, getJson } = fixture(registry);
    getJson.mockResolvedValue({ usage: { daily: meter(25) } });
    expect((await adapter.fetch(input)).windows).toEqual([expect.objectContaining({ name: 'daily', used: 25, remaining: 75 })]);
  });
  it.each([{}, { usage: {} }, { usage: [] }, { usage: { rolling: meter(1) } },
    ...[-1, 101, NaN, '0', null, 1.5].map(percent => ({ usage: { ...valid().usage, weekly: { ...meter(0), percent } } })),
    { usage: { ...valid().usage, weekly: meter(20, 'rate-limited') } },
    { usage: { ...valid().usage, weekly: meter(20, 'unknown') } },
    ...['bad-date', '2026-02-30T00:00:00Z', '2026-12-01T00:00:00'].map(resetsAt => ({ usage: { ...valid().usage, weekly: { ...meter(20), resetsAt } } })),
  ])('rejects malformed or incomplete usage: %j', async body => {
    const { adapter, getJson } = fixture(); getJson.mockResolvedValue(body);
    expect(await adapter.fetch(input)).toMatchObject({ status: 'error', windows: [], metadata: { reason: 'invalid_usage_response' } });
  });
  it.each([401, 403, 429])('keeps upstream HTTP %s as an error', async status => {
    const { adapter, getJson } = fixture();
    getJson.mockRejectedValue(Object.assign(new Error('upstream'), { status, headers: new Headers({ 'retry-after': '60' }) }));
    const result = await adapter.fetch(input);
    expect(result.status).toBe('error'); expect(result.windows).toEqual([]);
    expect(result.metadata).toMatchObject({ providerStatusCode: status });
  });
  it('preserves cancellation and does not turn it into an available snapshot', async () => {
    const { adapter, getJson } = fixture();
    const controller = new AbortController(); controller.abort();
    getJson.mockRejectedValue(controller.signal.reason);
    await expect(adapter.fetch({ ...input, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

it('supports a second declared service and window vocabulary without a provider-id branch', async () => {
  const registry = { getOffering: () => ({ upstream: [{ capability: 'quota', protocol: 'usage-percent-windows', options: { url: 'https://usage.example/limits', windows: { daily: 'daily-limit' } } }] }) } as unknown as ProviderRegistry;
  const { adapter, getJson } = fixture(registry);
  getJson.mockResolvedValue({ usage: { daily: meter(25) } });
  const result = await adapter.fetch({ ...input, credential: { ...credential, provider: 'another-service', offeringId: 'plan' } });
  expect(result.windows).toEqual([expect.objectContaining({ name: 'daily-limit', used: 25, remaining: 75 })]);
  expect(getJson).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://usage.example/limits' }));
});

it('does not send a key to an insecure declaration or use OAuth credentials as API keys', async () => {
  const registry = { getOffering: () => ({ upstream: [{ capability: 'quota', protocol: 'usage-percent-windows', options: { url: 'http://usage.example/limits', windows: { daily: 'day' } } }] }) } as unknown as ProviderRegistry;
  const { adapter, getJson } = fixture(registry);
  expect((await adapter.fetch(input)).status).toBe('unsupported');
  expect(adapter.supports({ ...credential, authMode: 'deviceCodeOAuth' })).toBe(false);
  expect(getJson).not.toHaveBeenCalled();
});
