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
