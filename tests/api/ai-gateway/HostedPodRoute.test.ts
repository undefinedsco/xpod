import { describe, expect, it } from 'vitest';
import { resolveHostedPodRoute } from '../../../src/api/ai-gateway/pod/HostedPodRoute';

describe('resolveHostedPodRoute', () => {
  it('names the gateway route for a canonical deployment URL', () => {
    expect(resolveHostedPodRoute({
      canonicalBaseUrl: 'https://node.example/',
      gatewayHost: 'localhost',
      gatewayPort: 5737,
    })).toEqual({
      canonicalBaseUrl: 'https://node.example/',
      localBaseUrl: 'http://localhost:5737/',
    });
    expect(resolveHostedPodRoute({
      canonicalBaseUrl: 'https://node.example/',
      gatewayPort: '5737',
    })).toEqual({
      canonicalBaseUrl: 'https://node.example/',
      localBaseUrl: 'http://127.0.0.1:5737/',
    });
  });

  it('connects to the address the gateway bound rather than a guess', () => {
    // A wildcard bind is not connectable everywhere, and `localhost` may be IPv6-only.
    expect(resolveHostedPodRoute({ canonicalBaseUrl: 'https://node.example/', gatewayHost: '0.0.0.0', gatewayPort: 1 }))
      .toMatchObject({ localBaseUrl: 'http://127.0.0.1:1/' });
    expect(resolveHostedPodRoute({ canonicalBaseUrl: 'https://node.example/', gatewayHost: '::', gatewayPort: 1 }))
      .toMatchObject({ localBaseUrl: 'http://[::1]:1/' });
  });

  it('has no route to offer without a canonical URL or a gateway port', () => {
    expect(resolveHostedPodRoute({ gatewayPort: 5737 })).toBeUndefined();
    expect(resolveHostedPodRoute({ canonicalBaseUrl: 'https://node.example/' })).toBeUndefined();
    expect(resolveHostedPodRoute({ canonicalBaseUrl: '  ', gatewayPort: 5737 })).toBeUndefined();
    expect(resolveHostedPodRoute({ canonicalBaseUrl: 'https://node.example/', gatewayPort: 'not-a-port' }))
      .toBeUndefined();
  });
});
