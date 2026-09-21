import { describe, expect, it, vi } from 'vitest';
import { NetworkEnvironmentConfigurationStore } from '../../../src/api/network/NetworkEnvironmentConfigurationStore';

function createStore(initial: Record<string, string> = {}) {
  const env: Record<string, string> = { ...initial };
  const write = vi.fn(async(patch: Record<string, string>, removals: string[] = []) => {
    Object.assign(env, patch);
    for (const key of removals) {
      delete env[key];
    }
  });
  return { store: new NetworkEnvironmentConfigurationStore({ read: () => env, write }), env, write };
}

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
    const write = vi.fn(async(patch: Record<string, string>) => {
      Object.assign(current, patch);
    });
    const store = new NetworkEnvironmentConfigurationStore({ read: () => current, write });
    await store.update({ domainDns: { domain: 'xpod.example', recordTtl: 600, credential: 'dns-secret' }, p2p: { enabled: true } });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ XPOD_DNS_DOMAIN: 'xpod.example', XPOD_DNS_RECORD_TTL: '600', CLOUDFLARE_API_TOKEN: 'dns-secret', XPOD_P2P_ENABLED: 'true' }), expect.anything());
  });

  it('stores the public entry under the key the runtime reads', async () => {
    const { store, env } = createStore();

    await store.update({
      tunnelProfiles: {
        activeProfileId: 'home',
        profiles: [ { id: 'home', provider: 'cloudflare', label: 'Home', publicUrl: 'https://home.example.com' } ],
      },
    });

    expect(JSON.parse(env.XPOD_TUNNEL_PROFILES)).toEqual([
      { id: 'home', provider: 'cloudflare', label: 'Home', publicUrl: 'https://home.example.com' },
    ]);
  });

  it('still reads a profile saved under the legacy publicEndpoint field', async () => {
    const { store } = createStore({
      XPOD_TUNNEL_PROFILES: JSON.stringify([
        { id: 'home', provider: 'cloudflare', label: 'Home', publicEndpoint: 'https://legacy.example.com' },
      ]),
    });

    const config = await store.read();
    expect(config.tunnelProfiles.profiles[0]).toMatchObject({
      id: 'home',
      publicUrl: 'https://legacy.example.com',
    });
  });

  it('accepts every provider the runtime implements, including sakura', async () => {
    const { store, env } = createStore();

    await store.update({
      tunnelProfiles: {
        activeProfileId: 'sakura-home',
        profiles: [
          { id: 'sakura-home', provider: 'sakura_frp', label: 'Sakura', credential: 'sakura-token' },
          { id: 'ngrok-dev', provider: 'ngrok', label: 'ngrok' },
        ],
      },
    });

    const config = await store.read();
    expect(config.tunnelProfiles.profiles.map((profile) => profile.provider)).toEqual([ 'sakura_frp', 'ngrok' ]);
    expect(env.XPOD_TUNNEL_PROFILE_SAKURA_HOME_TOKEN).toBe('sakura-token');
    expect(Object.keys(env)).not.toContain('FRP_TUNNEL_TOKEN');
  });

  it('keeps each profile credential under its own key', async () => {
    const { store, env } = createStore();

    await store.update({
      tunnelProfiles: {
        activeProfileId: 'account-a',
        profiles: [
          { id: 'account-a', provider: 'ngrok', label: 'A', credential: 'token-a' },
          { id: 'account-b', provider: 'ngrok', label: 'B', credential: 'token-b' },
        ],
      },
    });

    expect(env.XPOD_TUNNEL_PROFILE_ACCOUNT_A_TOKEN).toBe('token-a');
    expect(env.XPOD_TUNNEL_PROFILE_ACCOUNT_B_TOKEN).toBe('token-b');
    expect(env.NGROK_AUTHTOKEN).toBeUndefined();
  });

  it('removes the credential together with a deleted profile', async () => {
    const { store, env, write } = createStore({
      XPOD_TUNNEL_PROFILE_ACCOUNT_A_TOKEN: 'token-a',
      XPOD_TUNNEL_PROFILE_ACCOUNT_B_TOKEN: 'token-b',
    });

    await store.update({
      tunnelProfiles: {
        activeProfileId: 'account-b',
        profiles: [ { id: 'account-b', provider: 'ngrok', label: 'B' } ],
      },
    });

    expect(env.XPOD_TUNNEL_PROFILE_ACCOUNT_B_TOKEN).toBe('token-b');
    expect(env.XPOD_TUNNEL_PROFILE_ACCOUNT_A_TOKEN).toBeUndefined();
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([ 'XPOD_TUNNEL_PROFILE_ACCOUNT_A_TOKEN' ]),
    );
  });

  it('records an explicit off selection instead of an empty value', async () => {
    const { store, env } = createStore({
      XPOD_TUNNEL_PROFILES: JSON.stringify([ { id: 'home', provider: 'ngrok', label: 'Home' } ]),
      NGROK_AUTHTOKEN: 'leftover',
    });

    const config = await store.update({ tunnelProfiles: { activeProfileId: '' } });

    expect(env.XPOD_TUNNEL_ACTIVE_PROFILE_ID).toBe('none');
    expect(config.tunnelProfiles.activeProfileId).toBe('none');
  });

  it('writes the certificate paths the runtime actually reads', async () => {
    const { store, env } = createStore();

    await store.update({ https: { certificatePath: '/etc/xpod/tls.crt', certificateKeyPath: '/etc/xpod/tls.key' } });

    expect(env.XPOD_ACME_CERTIFICATE_PATH).toBe('/etc/xpod/tls.crt');
    expect(env.XPOD_ACME_CERTIFICATE_KEY_PATH).toBe('/etc/xpod/tls.key');
    expect(env.XPOD_HTTPS_CERT_PATH).toBeUndefined();
  });
});
