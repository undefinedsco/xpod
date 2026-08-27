import { describe, expect, it, vi } from 'vitest';

import { assertAllowedProviderEndpoint } from '../../../src/api/ai-gateway/routing/ProviderEndpointPolicy';

describe('ProviderEndpointPolicy', () => {
  it.each([
    'http://127.0.0.1:11434/v1',
    'https://10.0.0.2/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/v1',
    'https://user:password@provider.example/v1',
  ])('rejects unsafe cloud endpoint %s', async (endpoint) => {
    await expect(assertAllowedProviderEndpoint(endpoint, {
      allowPrivateNetwork: false,
      resolve: vi.fn() as never,
    })).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });

  it('rejects public hostnames that resolve to a private address', async () => {
    await expect(assertAllowedProviderEndpoint('https://provider.example/v1', {
      allowPrivateNetwork: false,
      resolve: vi.fn(async () => [{ address: '192.168.1.20', family: 4 }]) as never,
    })).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });

  it('accepts a public HTTPS cloud endpoint', async () => {
    await expect(assertAllowedProviderEndpoint('https://provider.example/v1', {
      allowPrivateNetwork: false,
      resolve: vi.fn(async () => [{ address: '203.0.113.10', family: 4 }]) as never,
    })).resolves.toBeUndefined();
  });

  it('allows local deployments to use loopback HTTP providers', async () => {
    await expect(assertAllowedProviderEndpoint('http://127.0.0.1:11434/v1', {
      allowPrivateNetwork: true,
    })).resolves.toBeUndefined();
  });
});
