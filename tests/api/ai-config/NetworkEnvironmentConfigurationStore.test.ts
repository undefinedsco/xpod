import { describe, expect, it, vi } from 'vitest';
import { NetworkEnvironmentConfigurationStore } from '../../../src/api/network/NetworkEnvironmentConfigurationStore';

describe('NetworkEnvironmentConfigurationStore', () => {
  it('projects environment configuration without returning credential values', async () => {
    const env = {
      XPOD_DNS_DOMAIN: 'xpod.example', XPOD_DDNS_ENABLED: 'true', XPOD_DNS_PROVIDER: 'cloudflare', XPOD_DNS_RECORD_TTL: '300', CLOUDFLARE_API_TOKEN: 'secret',
      XPOD_HTTPS_MODE: 'acme', XPOD_ACME_EMAIL: 'alice@example.com', XPOD_ACME_DOMAINS: 'xpod.example,www.xpod.example', XPOD_ACME_RENEW_BEFORE_DAYS: '30',
      XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'home', XPOD_TUNNEL_PROFILES: JSON.stringify([{ id: 'home', provider: 'cloudflare', label: 'Home', credentialEnv: 'CLOUDFLARE_TUNNEL_TOKEN' }]), CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-secret',
      XPOD_P2P_ENABLED: 'false', XPOD_P2P_SIGNAL_SERVICE: 'wss://signal.example', XPOD_P2P_FALLBACK_POLICY: 'when-direct-unavailable',
    };
    const store = new NetworkEnvironmentConfigurationStore({ read: () => env, write: vi.fn() });
    const config = await store.read();
    expect(config.domainDns).toMatchObject({ domain: 'xpod.example', recordTtl: 300, credentialConfigured: true });
    expect(config.https.domains).toEqual(['xpod.example', 'www.xpod.example']);
    expect(config.tunnelProfiles.profiles[0]).toMatchObject({ id: 'home', credentialConfigured: true });
    expect(JSON.stringify(config)).not.toContain('secret');
  });

  it('writes a bounded patch to the durable environment adapter', async () => {
    const current: Record<string, string> = {};
    const write = vi.fn(async (patch: Record<string, string>) => {
      Object.assign(current, patch);
    });
    const store = new NetworkEnvironmentConfigurationStore({ read: () => current, write });
    await store.update({ domainDns: { domain: 'xpod.example', recordTtl: 600, credential: 'dns-secret' }, p2p: { enabled: true } });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ XPOD_DNS_DOMAIN: 'xpod.example', XPOD_DNS_RECORD_TTL: '600', CLOUDFLARE_API_TOKEN: 'dns-secret', XPOD_P2P_ENABLED: 'true' }));
  });
});
