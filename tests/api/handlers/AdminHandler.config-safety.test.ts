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


  it('allows non-secret public Cloud host settings for API and registry entrypoints', () => {
    const readResult = sanitizeEnvForRead({
      XPOD_PUBLIC_API_URL: 'https://api.undefineds.co/',
      XPOD_PUBLIC_REGISTRY_URL: 'https://registry.undefineds.co/',
      CSS_ALLOWED_HOSTS: '*.undefineds.co',
      CSS_BASE_STORAGE_DOMAIN: 'undefineds.co',
      CSS_CLUSTER_INGRESS_DOMAIN: 'undefineds.co',
    });

    expect(readResult.env).toMatchObject({
      XPOD_PUBLIC_API_URL: 'https://api.undefineds.co/',
      XPOD_PUBLIC_REGISTRY_URL: 'https://registry.undefineds.co/',
      CSS_ALLOWED_HOSTS: '*.undefineds.co',
      CSS_BASE_STORAGE_DOMAIN: 'undefineds.co',
      CSS_CLUSTER_INGRESS_DOMAIN: 'undefineds.co',
    });

    const patch = createAllowedAdminConfigPatch({
      XPOD_PUBLIC_API_URL: 'https://api.undefineds.co/',
      XPOD_PUBLIC_REGISTRY_URL: 'https://registry.undefineds.co/',
      CSS_ALLOWED_HOSTS: '*.undefineds.co',
      CSS_BASE_STORAGE_DOMAIN: 'undefineds.co',
      CSS_CLUSTER_INGRESS_DOMAIN: 'undefineds.co',
    });

    expect(patch).toMatchObject(readResult.env);
  });


  it('allows non-secret tunnel profile selection while keeping credentials separate', () => {
    const profiles = JSON.stringify([
      {
        id: 'ngrok-dev',
        provider: 'ngrok',
        publicUrl: 'https://native.ngrok-free.dev/',
        credentialEnvKey: 'NGROK_AUTHTOKEN',
      },
      {
        id: 'cloudflare-home',
        provider: 'cloudflare',
        publicUrl: 'https://home-tunnel.example.com/',
        credentialEnvKey: 'CLOUDFLARE_TUNNEL_TOKEN',
      },
    ]);

    const readResult = sanitizeEnvForRead({
      XPOD_TUNNEL_PROFILES: profiles,
      XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'cloudflare-home',
      CLOUDFLARE_TUNNEL_URL: 'https://home-tunnel.example.com/',
      SAKURA_TUNNEL_URL: 'https://sakura.example.com/',
      CLOUDFLARE_TUNNEL_TOKEN: 'cf-secret',
    });

    expect(readResult.env).toMatchObject({
      XPOD_TUNNEL_PROFILES: profiles,
      XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'cloudflare-home',
      CLOUDFLARE_TUNNEL_URL: 'https://home-tunnel.example.com/',
      SAKURA_TUNNEL_URL: 'https://sakura.example.com/',
    });
    expect(readResult.env).not.toHaveProperty('CLOUDFLARE_TUNNEL_TOKEN');

    expect(createAllowedAdminConfigPatch({
      XPOD_TUNNEL_PROFILES: profiles,
      XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'cloudflare-home',
      CLOUDFLARE_TUNNEL_URL: 'https://home-tunnel.example.com/',
      SAKURA_TUNNEL_URL: 'https://sakura.example.com/',
      CLOUDFLARE_TUNNEL_TOKEN: '',
    })).toEqual({
      XPOD_TUNNEL_PROFILES: profiles,
      XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'cloudflare-home',
      CLOUDFLARE_TUNNEL_URL: 'https://home-tunnel.example.com/',
      SAKURA_TUNNEL_URL: 'https://sakura.example.com/',
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
