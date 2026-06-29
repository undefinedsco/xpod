import { describe, expect, it } from 'vitest';
import {
  createAllowedAdminConfigPatch,
  isAdminSecretEnvKey,
  sanitizeEnvForRead,
  sanitizeLogMessage,
} from '../../../src/api/handlers/AdminHandler';

describe('admin runtime config safety', () => {
  it('redacts secret-like runtime config values at the API boundary', () => {
    const result = sanitizeEnvForRead({
      CSS_BASE_URL: 'https://node-0000.undefineds.co/alice/',
      NGROK_AUTHTOKEN: 'ngrok-secret',
      CLOUDFLARE_TUNNEL_TOKEN: 'cf-secret',
      SAKURA_TUNNEL_TOKEN: 'sakura-secret',
      XPOD_SERVICE_TOKEN: 'service-secret',
      CSS_IDENTITY_DB_URL: 'postgres://user:pass@db/xpod',
      XPOD_HTTPS_KEY_PATH: '/etc/xpod/key.pem',
    });

    expect(result.env.CSS_BASE_URL).toBe('https://node-0000.undefineds.co/alice/');
    expect(result.env.XPOD_HTTPS_KEY_PATH).toBe('/etc/xpod/key.pem');
    expect(result.env).not.toHaveProperty('NGROK_AUTHTOKEN');
    expect(result.env).not.toHaveProperty('CLOUDFLARE_TUNNEL_TOKEN');
    expect(result.env).not.toHaveProperty('SAKURA_TUNNEL_TOKEN');
    expect(result.env).not.toHaveProperty('XPOD_SERVICE_TOKEN');
    expect(result.env).not.toHaveProperty('CSS_IDENTITY_DB_URL');
    expect(result.secrets.NGROK_AUTHTOKEN).toEqual({ configured: true });
    expect(result.secrets.CSS_IDENTITY_DB_URL).toEqual({ configured: true });
  });

  it('only accepts allowlisted config keys and keeps redacted secrets untouched unless replaced', () => {
    const patch = createAllowedAdminConfigPatch({
      CSS_BASE_URL: 'https://node-0000.undefineds.co/alice/',
      NGROK_AUTHTOKEN: '',
      XPOD_TUNNEL_PROVIDER: 'ngrok',
      EVIL_ENV: '1',
    });

    expect(patch).toEqual({
      CSS_BASE_URL: 'https://node-0000.undefineds.co/alice/',
      XPOD_TUNNEL_PROVIDER: 'ngrok',
    });
  });

  it('classifies token and database urls as secret but not certificate key paths', () => {
    expect(isAdminSecretEnvKey('NGROK_AUTHTOKEN')).toBe(true);
    expect(isAdminSecretEnvKey('XPOD_NODE_TOKEN')).toBe(true);
    expect(isAdminSecretEnvKey('CSS_IDENTITY_DB_URL')).toBe(true);
    expect(isAdminSecretEnvKey('XPOD_HTTPS_KEY_PATH')).toBe(false);
  });

  it('redacts configured secret values from log text', () => {
    const redacted = sanitizeLogMessage(
      'ngrok-secret and postgres://user:pass@db/xpod should not leave diagnostics',
      {
        NGROK_AUTHTOKEN: 'ngrok-secret',
        CSS_IDENTITY_DB_URL: 'postgres://user:pass@db/xpod',
      },
    );

    expect(redacted).toBe('[redacted:NGROK_AUTHTOKEN] and [redacted:CSS_IDENTITY_DB_URL] should not leave diagnostics');
  });
});
