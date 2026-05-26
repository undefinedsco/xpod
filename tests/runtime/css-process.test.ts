import { describe, expect, it } from 'vitest';
import { buildApiChildEnv, buildCssArgs, buildCssChildEnv } from '../../src/runtime/css-process';

describe('CSS child process env and args', () => {
  it('maps oidcIssuer to the internal oidcIssuer CLI shorthand only', () => {
    const args = buildCssArgs({
      cssBinary: 'community-solid-server',
      configPath: 'config/local.json',
      cssModuleRoot: '/xpod',
      cssPort: 3001,
      baseUrl: 'http://localhost:3000/',
      externalOidcIssuer: 'https://id.undefineds.co',
    });

    expect(args).toContain('--oidcIssuer');
    expect(args.slice(-2)).toEqual(['--oidcIssuer', 'https://id.undefineds.co']);
    expect(args).not.toContain('--idpUrl');
  });

  it('does not leak oidcIssuer into the CSS child env', () => {
    const env = buildCssChildEnv('http://localhost:3000/', 3001, {
      oidcIssuer: 'https://id.undefineds.co',
      KEEP_ME: 'yes',
    });

    expect(env.CSS_BASE_URL).toBe('http://localhost:3000/');
    expect(env.CSS_PORT).toBe('3001');
    expect(env.KEEP_ME).toBe('yes');
    expect(env.oidcIssuer).toBeUndefined();
  });

  it('keeps oidcIssuer visible to the API child and points tokens at the external IdP', () => {
    const env = buildApiChildEnv({
      apiPort: 3002,
      mainPort: 3000,
      cssPort: 3001,
      baseUrl: 'http://localhost:3000/',
      externalOidcIssuer: 'https://id.undefineds.co/',
      baseEnv: {
        oidcIssuer: 'https://id.undefineds.co/',
      },
    });

    expect(env.oidcIssuer).toBe('https://id.undefineds.co/');
    expect(env.CSS_TOKEN_ENDPOINT).toBe('https://id.undefineds.co/.oidc/token');
  });
});
