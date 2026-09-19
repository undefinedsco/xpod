import { describe, expect, it } from 'vitest';
import { readManagedTunnelConfig } from '../../../src/api/handlers/ProvisionHandler';

describe('readManagedTunnelConfig', () => {
  it('normalizes every accepted spelling onto the catalogue id', () => {
    // Provision callers historically wrote `sakura-frp`; the runtime only knows one id.
    for (const spelling of [ 'sakura_frp', 'sakura-frp' ]) {
      expect(readManagedTunnelConfig({
        managedTunnel: { subdomain: 'node-1', localPort: 3300, provider: spelling, endpoint: 'https://entry.example/' },
      })).toMatchObject({ config: { provider: 'sakura_frp' } });
    }

    expect(readManagedTunnelConfig({
      managedTunnel: { provider: 'cloudflare', endpoint: 'https://entry.example/' },
    })).toMatchObject({ config: { provider: 'cloudflare' } });
  });

  it('refuses providers it cannot start instead of storing a dead profile', () => {
    expect(readManagedTunnelConfig({
      managedTunnel: { provider: 'tailscale', endpoint: 'https://entry.example/' },
    })).toBeUndefined();
    expect(readManagedTunnelConfig({
      managedTunnel: { provider: 'none', endpoint: 'https://entry.example/' },
    })).toBeUndefined();
    expect(readManagedTunnelConfig(null)).toBeUndefined();
  });
});
