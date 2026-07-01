import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfigFromEnv } from '../../src/api/container';

describe('loadConfigFromEnv cssTokenEndpoint', () => {
  const envKeys = [
    'CSS_TOKEN_ENDPOINT',
    'CSS_BASE_URL',
    'CSS_AUTH_MODE',
    'XPOD_EDITION',
    'API_PORT',
    'API_HOST',
    'CLOUDFLARE_TUNNEL_TOKEN',
    'NGROK_AUTHTOKEN',
    'NGROK_URL',
    'NGROK_BIN',
    'XPOD_TUNNEL_PROFILES',
    'XPOD_TUNNEL_ACTIVE_PROFILE_ID',
    'XPOD_TUNNEL_PROVIDER',
    'CLOUDFLARE_TUNNEL_TOKEN',
  ] as const;

  const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('prefers explicit CSS_TOKEN_ENDPOINT', () => {
    process.env.CSS_TOKEN_ENDPOINT = 'http://localhost:3999/.oidc/token';
    process.env.CSS_BASE_URL = 'http://localhost:3310';

    const config = loadConfigFromEnv();
    expect(config.cssTokenEndpoint).toBe('http://localhost:3999/.oidc/token');
  });

  it('derives endpoint from CSS_BASE_URL when token endpoint is missing', () => {
    process.env.CSS_BASE_URL = 'http://localhost:3310';

    const config = loadConfigFromEnv();
    expect(config.cssTokenEndpoint).toBe('http://localhost:3310/.oidc/token');
  });

  it('falls back to localhost default when base URL is missing', () => {
    const config = loadConfigFromEnv();
    expect(config.cssTokenEndpoint).toBe('http://localhost:3000/.oidc/token');
  });

  it('defaults auth mode to acp and reads CSS_AUTH_MODE when set', () => {
    expect(loadConfigFromEnv().authMode).toBe('acp');

    process.env.CSS_AUTH_MODE = 'wac';
    expect(loadConfigFromEnv().authMode).toBe('acl');
  });



  it('loads multiple tunnel profiles and keeps only the selected one active', () => {
    process.env.XPOD_TUNNEL_PROFILES = JSON.stringify([
      {
        id: 'ngrok-dev',
        provider: 'ngrok',
        publicUrl: 'https://native.ngrok-free.dev',
        credentialEnvKey: 'NGROK_AUTHTOKEN',
      },
      {
        id: 'cloudflare-home',
        provider: 'cloudflare',
        publicUrl: 'https://home-tunnel.example.com',
        credentialEnvKey: 'CLOUDFLARE_TUNNEL_TOKEN',
      },
    ]);
    process.env.XPOD_TUNNEL_ACTIVE_PROFILE_ID = 'cloudflare-home';
    process.env.NGROK_AUTHTOKEN = 'ngrok-token';
    process.env.CLOUDFLARE_TUNNEL_TOKEN = 'cf-token';

    const config = loadConfigFromEnv();

    expect(config.tunnelProfiles?.map((profile) => profile.id)).toEqual(['ngrok-dev', 'cloudflare-home']);
    expect(config.tunnelActiveProfileId).toBe('cloudflare-home');
    expect(config.activeTunnelProfile).toMatchObject({
      id: 'cloudflare-home',
      provider: 'cloudflare',
      publicUrl: 'https://home-tunnel.example.com/',
    });
  });


  it('keeps legacy tunnel auto-selection when only old ngrok env is configured', () => {
    process.env.NGROK_URL = 'https://native.ngrok-free.dev';

    const config = loadConfigFromEnv();

    expect(config.tunnelProvider).toBe('ngrok');
    expect(config.tunnelActiveProfileId).toBe('ngrok');
    expect(config.activeTunnelProfile).toMatchObject({
      id: 'ngrok',
      provider: 'ngrok',
      publicUrl: 'https://native.ngrok-free.dev/',
    });
  });

  it('reads user-owned tunnel provider credentials from local environment only', () => {
    process.env.CLOUDFLARE_TUNNEL_TOKEN = 'cf-user-token';
    process.env.NGROK_AUTHTOKEN = 'ngrok-user-token';
    process.env.NGROK_URL = 'https://node-tunnel.ngrok-free.dev';
    process.env.NGROK_BIN = '/opt/homebrew/bin/ngrok';

    const config = loadConfigFromEnv();

    expect(config.cloudflareTunnelToken).toBe('cf-user-token');
    expect(config.ngrokAuthToken).toBe('ngrok-user-token');
    expect(config.ngrokUrl).toBe('https://node-tunnel.ngrok-free.dev');
    expect(config.ngrokPath).toBe('/opt/homebrew/bin/ngrok');
  });

  it('ignores xpod-prefixed ngrok aliases and only reads native NGROK_* variables', () => {
    const legacyPrefix = `${'XPOD'}_${'NGROK'}_`;
    process.env[`${legacyPrefix}AUTHTOKEN`] = 'legacy-token';
    process.env[`${legacyPrefix}URL`] = 'https://legacy.ngrok-free.dev';
    process.env[`${legacyPrefix}BIN`] = '/legacy/ngrok';

    expect(loadConfigFromEnv().ngrokAuthToken).toBeUndefined();
    expect(loadConfigFromEnv().ngrokUrl).toBeUndefined();
    expect(loadConfigFromEnv().ngrokPath).toBeUndefined();

    process.env.NGROK_AUTHTOKEN = 'native-token';
    process.env.NGROK_URL = 'https://native.ngrok-free.dev';
    process.env.NGROK_BIN = '/usr/local/bin/ngrok';

    const config = loadConfigFromEnv();

    expect(config.ngrokAuthToken).toBe('native-token');
    expect(config.ngrokUrl).toBe('https://native.ngrok-free.dev');
    expect(config.ngrokPath).toBe('/usr/local/bin/ngrok');

    delete process.env[`${legacyPrefix}AUTHTOKEN`];
    delete process.env[`${legacyPrefix}URL`];
    delete process.env[`${legacyPrefix}BIN`];
  });
});
