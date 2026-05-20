import { describe, expect, it } from 'vitest';
import { buildApiChildEnv, buildCssArgs, buildCssChildEnv } from '../../src/runtime/css-process';

describe('CSS child process env and args', () => {
  it('maps CSS_OIDC_ISSUER to the internal idpUrl CLI shorthand only', () => {
    const args = buildCssArgs({
      cssBinary: 'community-solid-server',
      configPath: 'config/local.json',
      cssModuleRoot: '/xpod',
      cssPort: 3001,
      baseUrl: 'http://localhost:3000/',
      externalOidcIssuer: 'https://id.undefineds.co',
    });

    expect(args).toContain('--idpUrl');
    expect(args.slice(-2)).toEqual(['--idpUrl', 'https://id.undefineds.co']);
    expect(args).not.toContain('--oidcIssuer');
  });

  it('does not leak OIDC aliases into the CSS child env', () => {
    const env = buildCssChildEnv('http://localhost:3000/', 3001, {
      CSS_OIDC_ISSUER: 'https://id.undefineds.co',
      CSS_IDP_URL: 'https://legacy-idp.example',
      XPOD_OIDC_ISSUER: 'https://wrong.example',
      oidcIssuer: 'https://legacy-issuer.example',
      idpUrl: 'https://legacy-shorthand.example',
      KEEP_ME: 'yes',
    });

    expect(env.CSS_BASE_URL).toBe('http://localhost:3000/');
    expect(env.CSS_PORT).toBe('3001');
    expect(env.KEEP_ME).toBe('yes');
    expect(env.CSS_OIDC_ISSUER).toBeUndefined();
    expect(env.CSS_IDP_URL).toBeUndefined();
    expect(env.XPOD_OIDC_ISSUER).toBeUndefined();
    expect(env.oidcIssuer).toBeUndefined();
    expect(env.idpUrl).toBeUndefined();
  });

  it('keeps CSS_OIDC_ISSUER visible to the API child and points tokens at the external IdP', () => {
    const env = buildApiChildEnv({
      apiPort: 3002,
      mainPort: 3000,
      cssPort: 3001,
      baseUrl: 'http://localhost:3000/',
      externalOidcIssuer: 'https://id.undefineds.co/',
      baseEnv: {
        CSS_OIDC_ISSUER: 'https://id.undefineds.co/',
      },
    });

    expect(env.CSS_OIDC_ISSUER).toBe('https://id.undefineds.co/');
    expect(env.CSS_TOKEN_ENDPOINT).toBe('https://id.undefineds.co/.oidc/token');
  });
});
