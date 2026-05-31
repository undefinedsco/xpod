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
});
