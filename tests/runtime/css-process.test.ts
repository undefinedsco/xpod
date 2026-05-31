import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApiChildEnv, buildCssArgs, buildCssChildEnv, createCssChildRuntimeConfig } from '../../src/runtime/css-process';

const ACP_AUTH_IMPORTS = [
  'css:config/ldp/authorization/acp.json',
  'css:config/util/auxiliary/acr.json',
];
const ACL_AUTH_IMPORTS = [
  'css:config/ldp/authorization/webacl.json',
  'css:config/util/auxiliary/acl.json',
];

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
    const env = buildCssChildEnv('http://localhost:3000/', 3001, 'https://id.undefineds.co', undefined, {
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

  it('passes normalized auth mode to CSS and API child processes', () => {
    const cssEnv = buildCssChildEnv('http://localhost:3000/', 3001, undefined, 'wac', {});
    expect(cssEnv.CSS_AUTH_MODE).toBe('acl');

    const apiEnv = buildApiChildEnv({
      apiPort: 3002,
      mainPort: 3000,
      cssPort: 3001,
      baseUrl: 'http://localhost:3000/',
      authMode: 'acp',
      baseEnv: {
        XPOD_AUTH_MODE: 'acl',
      },
    });

    expect(apiEnv.CSS_AUTH_MODE).toBe('acp');
    expect(apiEnv.XPOD_AUTH_MODE).toBeUndefined();
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
    expect(parsed.import).toEqual(['./local.json', ...ACP_AUTH_IMPORTS]);
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
    fs.writeFileSync(configPath, JSON.stringify({
      import: ['./main.json', './xpod.base.json'],
      '@graph': [],
    }), 'utf-8');
    fs.writeFileSync(path.join(path.dirname(configPath), 'main.json'), JSON.stringify({
      import: ['css:config/app/main/default.json'],
    }), 'utf-8');
    fs.writeFileSync(path.join(path.dirname(configPath), 'xpod.base.json'), JSON.stringify({
      import: ['./resolver.json'],
    }), 'utf-8');
    fs.writeFileSync(path.join(path.dirname(configPath), 'resolver.json'), '{}', 'utf-8');

    const runtimeConfig = createCssChildRuntimeConfig({
      configPath,
      runtimeRoot,
    });

    const parsed = JSON.parse(fs.readFileSync(runtimeConfig.configPath, 'utf-8')) as {
      import?: string[]
    };
    expect(parsed.import).toEqual([
      expect.stringMatching(/^file:\/\//),
      ...ACP_AUTH_IMPORTS,
    ]);
    expect(parsed.import?.[0]).toContain('/config/local.json');
    expect(parsed.import?.[0]).toContain('xpod%20css%20runtime-');
    expect(parsed.import?.[0]).not.toContain('xpod css runtime-');

    const rewrittenLocalPath = path.join(runtimeRoot, 'config', 'local.json');
    const rewrittenLocal = JSON.parse(fs.readFileSync(rewrittenLocalPath, 'utf-8')) as {
      import?: string[]
    };
    expect(rewrittenLocal.import).toEqual([
      expect.stringContaining('/config/main.json'),
      expect.stringContaining('/config/xpod.base.json'),
    ]);
    expect(rewrittenLocal.import?.[0]).toContain('xpod%20css%20runtime-');
    expect(rewrittenLocal.import?.[0]).not.toContain('xpod css runtime-');

    const rewrittenBase = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'config', 'xpod.base.json'), 'utf-8')) as {
      import?: string[]
    };
    expect(rewrittenBase.import).toEqual([
      expect.stringContaining('/config/resolver.json'),
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'config', 'main.json'), 'utf-8')).import).toEqual([
      'css:config/app/main/default.json',
    ]);
  });

  it('injects ACL authorization imports into legacy CSS runtime configs', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-css-runtime-'));
    const configPath = path.join(runtimeRoot, 'cloud.json');
    fs.writeFileSync(configPath, '{"@graph":[]}', 'utf-8');

    const runtimeConfig = createCssChildRuntimeConfig({
      configPath,
      runtimeRoot,
      authMode: 'wac',
    });
    const parsed = JSON.parse(fs.readFileSync(runtimeConfig.configPath, 'utf-8')) as {
      import?: string[]
    };

    expect(parsed.import).toEqual(['./cloud.json', ...ACL_AUTH_IMPORTS]);
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
