import { describe, expect, test } from 'bun:test';
import { updateNetworkConfiguration } from './network-settings';

describe('network settings API', () => {
  test('writes desired configuration separately from observed status', async () => {
    const authenticatedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://pod.example/api/network/settings/configuration');
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual({ domainDns: { recordTtl: 600 } });
      return new Response(JSON.stringify({ configuration: { domainDns: { recordTtl: 600 } }, applyState: 'restart-required' }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const result = await updateNetworkConfiguration({ podUrl: 'https://pod.example/', authenticatedFetch, patch: { domainDns: { recordTtl: 600 } } });
    expect(result.applyState).toBe('restart-required');
  });
});
