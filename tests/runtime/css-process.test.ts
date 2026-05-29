import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApiChildEnv, buildCssArgs, buildCssChildEnv, createCssChildRuntimeConfig } from '../../src/runtime/css-process';

describe('CSS child process env and args', () => {
  it('keeps external IdP out of CSS CLI args', () => {
    const args = buildCssArgs({
      cssBinary: 'community-solid-server',
      configPath: 'config/local.json',
      cssModuleRoot: '/xpod',
      cssPort: 3001,
      baseUrl: 'http://localhost:3000/',
      externalOidcIssuer: 'https://id.undefineds.co',
    });

    expect(args).not.toContain(`--${['idp', 'Url'].join('')}`);
    expect(args).not.toContain(`--${['oidc', 'Issuer'].join('')}`);
  });

  it('keeps oidcIssuer out of the CSS child env', () => {
    const env = buildCssChildEnv('http://localhost:3000/', 3001, 'https://id.undefineds.co', {
      [`CSS_${['OIDC', 'ISSUER'].join('_')}`]: 'https://id.undefineds.co',
      [`CSS_${['IDP', 'URL'].join('_')}`]: 'https://legacy-idp.example',
      [`XPOD_${['OIDC', 'ISSUER'].join('_')}`]: 'https://wrong.example',
      oidcIssuer: 'https://legacy-issuer.example',
      [['identity', 'ProviderUrl'].join('')]: 'https://legacy-shorthand.example',
      KEEP_ME: 'yes',
    });

    expect(env.CSS_BASE_URL).toBe('http://localhost:3000/');
    expect(env.CSS_PORT).toBe('3001');
    expect(env.KEEP_ME).toBe('yes');
    expect(env[`CSS_${['OIDC', 'ISSUER'].join('_')}`]).toBeUndefined();
    expect(env[`CSS_${['IDP', 'URL'].join('_')}`]).toBeUndefined();
    expect(env[`XPOD_${['OIDC', 'ISSUER'].join('_')}`]).toBeUndefined();
    expect(env.oidcIssuer).toBeUndefined();
    expect(env[['identity', 'ProviderUrl'].join('')]).toBeUndefined();
  });

  it('injects external oidcIssuer through CSS package settings for legacy CSS children', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-css-runtime-'));
    const configPath = path.join(runtimeRoot, 'local.json');
    fs.writeFileSync(configPath, '{"@graph":[]}', 'utf-8');

    const runtimeConfig = createCssChildRuntimeConfig({
      configPath,
      runtimeRoot,
      externalOidcIssuer: 'https://id.undefineds.co/',
    });

    expect(runtimeConfig).toEqual({
      configPath: path.join(runtimeRoot, 'css-child-runtime.config.json'),
      cwd: runtimeRoot,
    });
    const parsed = JSON.parse(fs.readFileSync(runtimeConfig.configPath, 'utf-8')) as {
      import?: string[]
      '@graph'?: Array<Record<string, unknown>>
    };
    expect(parsed.import).toEqual(['./local.json']);
    expect(parsed['@graph']).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(runtimeRoot, '.community-solid-server.config.json'), 'utf-8'))).toEqual({
      oidcIssuer: 'https://id.undefineds.co/',
    });
  });

  it('escapes legacy CSS runtime config imports when runtime paths contain spaces', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod css runtime-'));
    const configDir = path.join(runtimeRoot, 'Application Support', '@undefineds.co', 'xpod');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config', 'local.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{"@graph":[]}', 'utf-8');

    const runtimeConfig = createCssChildRuntimeConfig({
      configPath,
      runtimeRoot,
    });

    const parsed = JSON.parse(fs.readFileSync(runtimeConfig.configPath, 'utf-8')) as {
      import?: string[]
    };
    expect(parsed.import).toEqual([
      expect.stringMatching(/^file:\/\//),
    ]);
    expect(parsed.import?.[0]).toContain('Application%20Support');
    expect(parsed.import?.[0]).not.toContain('Application Support');
  });

  it('generates a legacy CSS runtime config without package settings when external oidcIssuer is absent', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-css-runtime-'));
    const configPath = path.join(runtimeRoot, 'local.json');
    fs.writeFileSync(configPath, '{"@graph":[]}', 'utf-8');

    const runtimeConfig = createCssChildRuntimeConfig({ configPath, runtimeRoot });
    expect(runtimeConfig).toEqual({
      configPath: path.join(runtimeRoot, 'css-child-runtime.config.json'),
      cwd: undefined,
    });
    expect(fs.existsSync(path.join(runtimeRoot, '.community-solid-server.config.json'))).toBe(false);
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
