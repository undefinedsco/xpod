import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildRuntimeEnv, buildRuntimeShorthand, createCssRuntimeConfig, resolveRuntimeBootstrap } from '../../src/runtime/bootstrap';
import { normalizeDatabaseUrl } from '../../src/runtime/database-url';
import { nodeRuntimeHost } from '../../src/runtime/host/node/NodeRuntimeHost';
import type { RuntimeHost } from '../../src/runtime/host/types';
import type { RuntimePlatform } from '../../src/runtime/platform/types';
import { PACKAGE_ROOT } from '../../src/runtime/package-root';

function createWindowsJoinPath(packageRoot: string) {
  return (...segments: string[]): string => {
    const normalizedSegments = segments.map((segment, index) => {
      if (index === 0 && segment === PACKAGE_ROOT) {
        return packageRoot;
      }
      return segment;
    });
    return path.win32.join(...normalizedSegments);
  };
}

const ACP_AUTH_IMPORTS = [
  'css:config/ldp/authorization/acp.json',
  'css:config/util/auxiliary/acr.json',
];
const ACL_AUTH_IMPORTS = [
  'css:config/ldp/authorization/webacl.json',
  'css:config/util/auxiliary/acl.json',
];
const ALLOW_ALL_AUTH_IMPORTS = [
  'css:config/ldp/authorization/allow-all.json',
  'css:config/util/auxiliary/empty.json',
];
const XPOD_COMPONENTS_CONTEXT = 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/components/context.jsonld';

describe('runtime bootstrap helpers', () => {
  it('should trim whitespace before resolving database paths', () => {
    const resolvePath = vi.fn((value: string) => `/sandbox/${value}`);

    expect(normalizeDatabaseUrl('  relative/identity.sqlite  ', { resolvePath })).toBe('sqlite:/sandbox/relative/identity.sqlite');
    expect(resolvePath).toHaveBeenCalledWith('relative/identity.sqlite');
  });

  it('should canonicalize supported database URL schemes', () => {
    expect(normalizeDatabaseUrl('  SQLITE:/tmp/quadstore.sqlite  ')).toBe('sqlite:/tmp/quadstore.sqlite');
    expect(normalizeDatabaseUrl('PostgreSQL://db.example/identity')).toBe('postgresql://db.example/identity');
    expect(normalizeDatabaseUrl('POSTGRES://db.example/usage')).toBe('postgres://db.example/usage');
    expect(normalizeDatabaseUrl('MySQL://db.example/other')).toBe('mysql://db.example/other');
  });

  it('should resolve Windows drive absolute and relative paths as files', () => {
    const resolvePath = vi.fn((value: string) => `resolved:${value}`);

    expect(normalizeDatabaseUrl('C:\\data\\identity.sqlite', { resolvePath })).toBe('sqlite:resolved:C:\\data\\identity.sqlite');
    expect(normalizeDatabaseUrl('C:relative\\identity.sqlite', { resolvePath })).toBe('sqlite:resolved:C:relative\\identity.sqlite');
    expect(resolvePath).toHaveBeenNthCalledWith(1, 'C:\\data\\identity.sqlite');
    expect(resolvePath).toHaveBeenNthCalledWith(2, 'C:relative\\identity.sqlite');
  });

  it('should normalize relative and absolute database paths', async() => {
    const state = await resolveRuntimeBootstrap('database-url-paths', {
      mode: 'local',
      transport: 'socket',
      runtimeRoot: '.test-data/runtime-bootstrap/database-url-paths',
      sparqlEndpoint: 'relative/quadstore.sqlite',
      identityDbUrl: path.resolve('.test-data/runtime-bootstrap/database-url-paths/identity.sqlite'),
      usageDbUrl: 'mysql://db.example/usage',
    }, nodeRuntimeHost);

    expect(state.sparqlEndpoint).toBe(`sqlite:${path.resolve('relative/quadstore.sqlite')}`);
    expect(state.identityDbUrl).toBe(`sqlite:${path.resolve('.test-data/runtime-bootstrap/database-url-paths/identity.sqlite')}`);
    expect(state.usageDbUrl).toBe('mysql://db.example/usage');
  });

  it('should preserve supported explicit database URLs', async() => {
    const urls = [
      'sqlite:/tmp/quadstore.sqlite',
      'postgres://db.example/identity',
      'postgresql://db.example/usage',
      'mysql://db.example/other',
    ];

    for (const [index, url] of urls.entries()) {
      const state = await resolveRuntimeBootstrap(`database-url-explicit-${index}`, {
        mode: 'local',
        transport: 'socket',
        runtimeRoot: `.test-data/runtime-bootstrap/database-url-explicit-${index}`,
        sparqlEndpoint: url,
      }, nodeRuntimeHost);

      expect(state.sparqlEndpoint).toBe(url);
    }
  });

  it('should reject unknown database URL schemes', async() => {
    await expect(resolveRuntimeBootstrap('database-url-unknown-scheme', {
      mode: 'local',
      transport: 'socket',
      runtimeRoot: '.test-data/runtime-bootstrap/database-url-unknown-scheme',
      sparqlEndpoint: 'redis://db.example/quadstore',
    }, nodeRuntimeHost)).rejects.toThrow(/Unsupported database URL scheme/);
  });

  it('should reject empty database URLs', async() => {
    await expect(resolveRuntimeBootstrap('database-url-empty', {
      mode: 'local',
      transport: 'socket',
      runtimeRoot: '.test-data/runtime-bootstrap/database-url-empty',
      sparqlEndpoint: '',
    }, nodeRuntimeHost)).rejects.toThrow(/Database URL must not be empty/);
  });

  it('should resolve socket runtime bootstrap layout', async() => {
    const state = await resolveRuntimeBootstrap('test-id', {
      mode: 'local',
      transport: 'socket',
      runtimeRoot: '.test-data/runtime-bootstrap/socket',
      gatewayPort: 5610,
      cssPort: 5611,
      apiPort: 5612,
    }, nodeRuntimeHost);

    expect(state.transport).toBe('socket');
    expect(state.baseUrl).toBe('http://localhost/');
    expect(state.sockets.gateway).toContain('gateway.sock');
    expect(state.sockets.api).toContain('api.sock');
    expect(state.ports.gateway).toBeUndefined();
  });

  it('should build env and shorthand from bootstrap state', async() => {
    const state = await resolveRuntimeBootstrap('test-port', {
      mode: 'cloud',
      transport: 'port',
      runtimeRoot: '.test-data/runtime-bootstrap/port',
      bindHost: '127.0.0.1',
      gatewayPort: 5710,
      cssPort: 5711,
      apiPort: 5712,
      open: true,
    }, nodeRuntimeHost);

    const runtimeEnv = buildRuntimeEnv(state, {
      mode: 'cloud',
      transport: 'port',
      edgeNodesEnabled: true,
      centerRegistrationEnabled: true,
    }, {
      XPOD_NODE_ID: 'node-1',
      XPOD_NODE_TOKEN: 'node-token',
      XPOD_SIGNAL_ENDPOINT: 'https://cluster.example/api/signal',
      XPOD_P2P_ENABLED: 'true',
      XPOD_P2P_TARGET_BASE_URL: 'http://127.0.0.1:3000/',
      XPOD_P2P_LABEL: 'xpod-p2p-http',
      XPOD_P2P_ACCEPT_INTERVAL_MS: '1500',
      XPOD_P2P_CONNECT_TIMEOUT_MS: '7000',
      XPOD_P2P_WINNER_SELECTION_WINDOW_MS: '50',
      XPOD_ACME_MODE: 'cluster',
      XPOD_ACME_EMAIL: 'ops@example.com',
      XPOD_ACME_DOMAINS: 'node-1.example.com,node-1-alt.example.com',
      XPOD_ACME_DIRECTORY_URL: 'https://acme.example/directory',
      XPOD_ACME_ACCOUNT_KEY_PATH: '/tmp/account.key',
      XPOD_ACME_CERTIFICATE_KEY_PATH: '/tmp/tls.key',
      XPOD_ACME_CERTIFICATE_PATH: '/tmp/tls.crt',
      XPOD_ACME_FULL_CHAIN_PATH: '/tmp/fullchain.pem',
      XPOD_ACME_RENEW_BEFORE_DAYS: '20',
      XPOD_ACME_DNS_PROPAGATION_DELAY_MS: '5000',
      XPOD_ACME_POST_DEPLOY_COMMAND: 'systemctl,reload,caddy',
    });

    const shorthand = buildRuntimeShorthand(runtimeEnv, {
      mode: 'cloud',
      edgeNodesEnabled: true,
      centerRegistrationEnabled: true,
    }, state, {});

    expect(runtimeEnv.CSS_BASE_URL).toBe('http://localhost:5710/');
    expect(runtimeEnv.API_PORT).toBe('5712');
    expect(shorthand.edition).toBe('server');
    expect(shorthand.nodeId).toBe('node-1');
    expect(shorthand.nodeToken).toBe('node-token');
    expect(shorthand.signalEndpoint).toBe('https://cluster.example/api/signal');
    expect(shorthand.p2pEnabled).toBe('true');
    expect(shorthand.p2pTargetBaseUrl).toBe('http://127.0.0.1:3000/');
    expect(shorthand.p2pLabel).toBe('xpod-p2p-http');
    expect(shorthand.p2pAcceptIntervalMs).toBe('1500');
    expect(shorthand.p2pConnectTimeoutMs).toBe('7000');
    expect(shorthand.p2pWinnerSelectionWindowMs).toBe('50');
    expect(shorthand.acmeMode).toBe('cluster');
    expect(shorthand.acmeEmail).toBe('ops@example.com');
    expect(shorthand.acmeDomains).toBe('node-1.example.com,node-1-alt.example.com');
    expect(shorthand.acmeDirectoryUrl).toBe('https://acme.example/directory');
    expect(shorthand.acmeAccountKeyPath).toBe('/tmp/account.key');
    expect(shorthand.acmeCertificateKeyPath).toBe('/tmp/tls.key');
    expect(shorthand.acmeCertificatePath).toBe('/tmp/tls.crt');
    expect(shorthand.acmeFullChainPath).toBe('/tmp/fullchain.pem');
    expect(shorthand.acmeRenewBeforeDays).toBe('20');
    expect(shorthand.acmePropagationDelayMs).toBe('5000');
    expect(shorthand.acmePostDeployCommand).toBe('systemctl,reload,caddy');
    expect(shorthand.edgeNodesEnabled).toBe(true);
    expect(shorthand.centerRegistrationEnabled).toBe(true);
    expect(shorthand.emailConfigHost).toBe('');
    expect(shorthand.emailConfigPort).toBe('587');
    expect(shorthand.emailConfigAuthUser).toBe('');
    expect(shorthand.emailConfigAuthPass).toBe('');
  });

  it('passes seedConfig through runtime shorthand for seeded local acceptance', async() => {
    const state = await resolveRuntimeBootstrap('test-seed-config', {
      mode: 'local',
      transport: 'port',
      runtimeRoot: '.test-data/runtime-bootstrap/seed-config',
      bindHost: '127.0.0.1',
      gatewayPort: 5790,
      cssPort: 5791,
      apiPort: 5792,
      seedConfig: 'config/seed.dev.json',
    }, nodeRuntimeHost);

    const runtimeEnv = buildRuntimeEnv(state, { mode: 'local', seedConfig: 'config/seed.dev.json' });
    const shorthand = buildRuntimeShorthand(runtimeEnv, {
      mode: 'local',
      seedConfig: 'config/seed.dev.json',
    }, state, {});

    expect(shorthand.seedConfig).toBe('config/seed.dev.json');
  });

  it('should generate isolated gateway admin proxy secrets and inject them into runtime env', async() => {
    const firstState = await resolveRuntimeBootstrap('test-admin-proxy-secret-a', {
      mode: 'local',
      transport: 'port',
      runtimeRoot: '.test-data/runtime-bootstrap/admin-proxy-secret-a',
      bindHost: '127.0.0.1',
      gatewayPort: 5750,
      cssPort: 5751,
      apiPort: 5752,
    }, nodeRuntimeHost);
    const secondState = await resolveRuntimeBootstrap('test-admin-proxy-secret-b', {
      mode: 'local',
      transport: 'port',
      runtimeRoot: '.test-data/runtime-bootstrap/admin-proxy-secret-b',
      bindHost: '127.0.0.1',
      gatewayPort: 5760,
      cssPort: 5761,
      apiPort: 5762,
    }, nodeRuntimeHost);

    expect(firstState.gatewayAdminProxyAuthSecret).toEqual(expect.any(String));
    expect(secondState.gatewayAdminProxyAuthSecret).toEqual(expect.any(String));
    expect(firstState.gatewayAdminProxyAuthSecret).not.toBe(secondState.gatewayAdminProxyAuthSecret);

    const runtimeEnv = buildRuntimeEnv(firstState, {
      mode: 'local',
      env: {
        XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET: 'caller-supplied-secret',
      },
    });

    expect(runtimeEnv.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET).toBe(firstState.gatewayAdminProxyAuthSecret);
    expect(runtimeEnv.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET).not.toBe('caller-supplied-secret');
  });

  it('should resolve auth mode from runtime env and prefer explicit options', async() => {
    const envState = await resolveRuntimeBootstrap('test-auth-env', {
      mode: 'local',
      transport: 'port',
      runtimeRoot: '.test-data/runtime-bootstrap/auth-env',
      bindHost: '127.0.0.1',
      gatewayPort: 5720,
      cssPort: 5721,
      apiPort: 5722,
      env: {
        CSS_AUTH_MODE: 'wac',
      },
    }, nodeRuntimeHost);

    expect(envState.cssAuthMode).toBe('acl');

    const explicitState = await resolveRuntimeBootstrap('test-auth-option', {
      mode: 'local',
      transport: 'port',
      runtimeRoot: '.test-data/runtime-bootstrap/auth-option',
      bindHost: '127.0.0.1',
      gatewayPort: 5730,
      cssPort: 5731,
      apiPort: 5732,
      authMode: 'acp',
      env: {
        CSS_AUTH_MODE: 'acl',
      },
    }, nodeRuntimeHost);

    expect(explicitState.cssAuthMode).toBe('acp');
  });

  it('should write only CSS_AUTH_MODE into runtime env', async() => {
    const state = await resolveRuntimeBootstrap('test-auth-env-write', {
      mode: 'local',
      transport: 'port',
      runtimeRoot: '.test-data/runtime-bootstrap/auth-env-write',
      bindHost: '127.0.0.1',
      gatewayPort: 5740,
      cssPort: 5741,
      apiPort: 5742,
      authMode: 'acl',
    }, nodeRuntimeHost);

    const runtimeEnv = buildRuntimeEnv(state, {
      mode: 'local',
      env: {
        XPOD_AUTH_MODE: 'acp',
      },
    });

    expect(runtimeEnv.CSS_AUTH_MODE).toBe('acl');
    expect(runtimeEnv.XPOD_AUTH_MODE).toBeUndefined();
  });

  it('should use oidcIssuer for local SP mode', async() => {
    const state = await resolveRuntimeBootstrap('test-oidc-issuer', {
      mode: 'local',
      transport: 'port',
      runtimeRoot: '.test-data/runtime-bootstrap/oidc-issuer',
      bindHost: '127.0.0.1',
      gatewayPort: 5810,
      cssPort: 5811,
      apiPort: 5812,
    }, nodeRuntimeHost);

    const runtimeEnv = buildRuntimeEnv(state, {
      mode: 'local',
      env: {
        oidcIssuer: 'http://cloud.example',
        XPOD_CLOUD_API_ENDPOINT: 'http://api.example',
      },
    });
    const shorthand = buildRuntimeShorthand(runtimeEnv, { mode: 'local' }, state, {});

    expect(runtimeEnv.CSS_TOKEN_ENDPOINT).toBe('http://cloud.example/.oidc/token');
    expect(shorthand.oidcIssuer).toBe('http://cloud.example');
  });

  it('should not infer oidcIssuer from cloud API endpoint', async() => {
    const state = await resolveRuntimeBootstrap('test-cloud-api-only', {
      mode: 'local',
      transport: 'port',
      runtimeRoot: '.test-data/runtime-bootstrap/cloud-api-only',
      bindHost: '127.0.0.1',
      gatewayPort: 5820,
      cssPort: 5821,
      apiPort: 5822,
    }, nodeRuntimeHost);

    const runtimeEnv = buildRuntimeEnv(state, {
      mode: 'local',
      env: {
        XPOD_CLOUD_API_ENDPOINT: 'http://api.example',
      },
    });
    const shorthand = buildRuntimeShorthand(runtimeEnv, { mode: 'local' }, state, {});

    expect(runtimeEnv.CSS_TOKEN_ENDPOINT).toBe('http://localhost:5820/.oidc/token');
    expect(shorthand.oidcIssuer).toBeUndefined();
  });

  it('should expose CSS_SEED_CONFIG as the CSS seedConfig shorthand', async() => {
    const state = await resolveRuntimeBootstrap('test-seed-config', {
      mode: 'local',
      transport: 'port',
      runtimeRoot: '.test-data/runtime-bootstrap/seed-config',
      bindHost: '127.0.0.1',
      gatewayPort: 5830,
      cssPort: 5831,
      apiPort: 5832,
    }, nodeRuntimeHost);

    const runtimeEnv = buildRuntimeEnv(state, {
      mode: 'local',
      env: {
        CSS_SEED_CONFIG: '/workspace/config/seed.dev.json',
      },
    });
    const shorthand = buildRuntimeShorthand(runtimeEnv, { mode: 'local' }, state, {});

    expect(shorthand.seedConfig).toBe('/workspace/config/seed.dev.json');
  });

  it('should resolve runtime paths and log level via injected platform', async() => {
    const ensureDir = vi.fn();
    const host = {
      resolveTransport: vi.fn().mockReturnValue('port'),
      allocatePorts: vi.fn().mockResolvedValue({
        gateway: 5910,
        css: 5911,
        api: 5912,
      }),
    } as Pick<RuntimeHost, 'resolveTransport' | 'allocatePorts'> as RuntimeHost;
    const platform: RuntimePlatform = {
      name: 'fake-platform',
      baseEnv: {},
      createRuntimeId: (): string => 'fake-id',
      cwd: (): string => '/sandbox',
      joinPath: (...segments: string[]): string => path.posix.join(...segments),
      resolvePath: (...segments: string[]): string => path.posix.resolve(...segments),
      dirname: (filePath: string): string => path.posix.dirname(filePath),
      fileExists: (): boolean => true,
      readTextFile: (): string => '',
      writeTextFile: (): void => undefined,
      ensureDir,
      getEnv: (key: string): string | undefined => key === 'CSS_LOGGING_LEVEL' ? 'error' : undefined,
      setEnv: (): void => undefined,
      fetch: async(): Promise<Response> => new Response(null, { status: 204 }),
    };

    const state = await resolveRuntimeBootstrap('platform-id', {
      mode: 'local',
    }, host, platform);

    expect(state.runtimeRoot).toBe('/sandbox/.test-data/xpod-runtime/platform-id');
    expect(state.rootFilePath).toBe('/sandbox/.test-data/xpod-runtime/platform-id/data');
    expect(state.sparqlEndpoint).toBe('sqlite:/sandbox/.test-data/xpod-runtime/platform-id/quadstore.sqlite');
    expect(state.rdfIndexPath).toBe('/sandbox/.test-data/xpod-runtime/platform-id/rdf-index.sqlite');
    expect(state.logLevel).toBe('error');
    expect(ensureDir).toHaveBeenCalledWith('/sandbox/.test-data/xpod-runtime/platform-id');
    expect(ensureDir).toHaveBeenCalledWith('/sandbox/.test-data/xpod-runtime/platform-id/data');
  });

  it('should write Components config imports as relative paths on Windows paths', () => {
    const writeTextFile = vi.fn();
    const readTextFile = vi.fn();
    const ensureDir = vi.fn();
    const joinPath = createWindowsJoinPath('D:\\package');
    const runtimeConfigPath = createCssRuntimeConfig({
      id: 'same-drive',
      mode: 'local',
      runtimeRoot: 'D:\\runtime',
      cssAuthMode: 'acp',
    } as any, true, {
      dirname: (filePath: string): string => path.win32.dirname(filePath),
      ensureDir,
      joinPath,
      readTextFile,
      writeTextFile,
    });

    expect(runtimeConfigPath).toBe(`D:\\runtime\\css-runtime.config.json`);
    expect(ensureDir).not.toHaveBeenCalled();
    expect(writeTextFile).toHaveBeenCalledTimes(1);

    const [, content] = writeTextFile.mock.calls[0];
    const parsed = JSON.parse(content);
    expect(parsed['@context']).toContain(XPOD_COMPONENTS_CONTEXT);
    expect(parsed.import).toEqual([
      '../package/config/local.json',
      ...ACP_AUTH_IMPORTS,
    ]);
  });

  it('should write ACL authorization config imports when auth mode is acl', () => {
    const writeTextFile = vi.fn();
    const runtimeConfigPath = createCssRuntimeConfig({
      id: 'acl-mode',
      mode: 'cloud',
      runtimeRoot: '/runtime',
      cssAuthMode: 'acl',
    } as any, false, {
      dirname: (filePath: string): string => path.posix.dirname(filePath),
      ensureDir: vi.fn(),
      joinPath: (...segments: string[]): string => {
        if (segments[0] === PACKAGE_ROOT) {
          return path.posix.join('/package', ...segments.slice(1));
        }
        return path.posix.join(...segments);
      },
      readTextFile: vi.fn(),
      writeTextFile,
    });

    expect(runtimeConfigPath).toBe('/runtime/css-runtime.config.json');
    const [, content] = writeTextFile.mock.calls[0];
    const parsed = JSON.parse(content);
    expect(parsed.import).toEqual([
      '../package/config/cloud.json',
      ...ACL_AUTH_IMPORTS,
    ]);
  });

  it('should write allow-all authorization config imports for open runtime mode', () => {
    const writeTextFile = vi.fn();
    const runtimeConfigPath = createCssRuntimeConfig({
      id: 'open-mode',
      mode: 'local',
      runtimeRoot: '/runtime',
      cssAuthMode: 'allow-all',
    } as any, true, {
      dirname: (filePath: string): string => path.posix.dirname(filePath),
      ensureDir: vi.fn(),
      joinPath: (...segments: string[]): string => {
        if (segments[0] === PACKAGE_ROOT) {
          return path.posix.join('/package', ...segments.slice(1));
        }
        return path.posix.join(...segments);
      },
      readTextFile: vi.fn(),
      writeTextFile,
    });

    expect(runtimeConfigPath).toBe('/runtime/css-runtime.config.json');
    const [, content] = writeTextFile.mock.calls[0];
    const parsed = JSON.parse(content);
    expect(parsed.import).toEqual([
      '../package/config/local.json',
      ...ALLOW_ALL_AUTH_IMPORTS,
    ]);
  });

  it('should copy package config without spaces when component context is available', () => {
    const writes = new Map<string, string>();
    const writeTextFile = vi.fn((filePath: string, content: string) => {
      writes.set(filePath, content);
    });
    const readTextFile = vi.fn((filePath: string): string => {
      const byPath: Record<string, unknown> = {
        '/package/config/local.json': {
          '@context': [
            'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld',
            'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/components/context.jsonld',
          ],
          '@graph': [
            {
              '@id': 'urn:test:SolidRdfDataAccessor',
              '@type': 'SolidRdfDataAccessor',
              rdfEngine: {
                '@id': 'urn:undefineds:xpod:SolidRdfEngine',
              },
            },
          ],
        },
        '/package/dist/components/context.jsonld': {
          '@context': [
            {},
            {
              SolidRdfDataAccessor: {
                '@id': 'urn:test:SolidRdfDataAccessor',
                '@context': {
                  rdfEngine: {
                    '@id': 'urn:test:SolidRdfDataAccessor_rdfEngine',
                  },
                },
              },
            },
          ],
        },
      };
      return JSON.stringify(byPath[filePath] ?? {});
    });
    const runtimeConfigPath = createCssRuntimeConfig({
      id: 'package-context',
      mode: 'local',
      runtimeRoot: '/runtime',
      cssAuthMode: 'acp',
    } as any, true, {
      dirname: (filePath: string): string => path.posix.dirname(filePath),
      ensureDir: vi.fn(),
      joinPath: (...segments: string[]): string => {
        if (segments[0] === PACKAGE_ROOT) {
          return path.posix.join('/package', ...segments.slice(1));
        }
        return path.posix.join(...segments);
      },
      readTextFile,
      writeTextFile,
    });

    expect(runtimeConfigPath).toBe('/runtime/css-runtime.config.json');
    const parsed = JSON.parse(writes.get(runtimeConfigPath) ?? '{}');
    expect(parsed.import).toEqual([
      './config/local.json',
      ...ACP_AUTH_IMPORTS,
    ]);

    const rewrittenLocal = JSON.parse(writes.get('/runtime/config/local.json') ?? '{}');
    expect(rewrittenLocal['@graph']?.[0]?.['SolidRdfDataAccessor:_rdfEngine']).toEqual({
      '@id': 'urn:undefineds:xpod:SolidRdfEngine',
    });
    expect(rewrittenLocal['@graph']?.[0]?.rdfEngine).toBeUndefined();
  });

  it('preserves full InternalPodDataHttpHandler type and parameter IRIs when runtime context is older than the package config', () => {
    const writes = new Map<string, string>();
    const writeTextFile = vi.fn((filePath: string, content: string) => {
      writes.set(filePath, content);
    });
    const readTextFile = vi.fn((filePath: string): string => {
      const byPath: Record<string, unknown> = {
        '/package/config/local.json': {
          '@context': [
            'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld',
            'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/components/context.jsonld',
          ],
          import: ['./xpod.base.json'],
        },
        '/package/config/xpod.base.json': JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'config/xpod.base.json'), 'utf8')),
        '/package/dist/components/context.jsonld': {
          '@context': [
            {},
            {
              SolidRdfDataAccessor: {
                '@id': 'undefineds:dist/storage/accessors/SolidRdfDataAccessor.jsonld#SolidRdfDataAccessor',
                '@context': {},
              },
            },
          ],
        },
      };
      return JSON.stringify(byPath[filePath] ?? {});
    });

    createCssRuntimeConfig({
      id: 'older-published-context',
      mode: 'local',
      runtimeRoot: '/runtime',
      cssAuthMode: 'acp',
    } as any, true, {
      dirname: (filePath: string): string => path.posix.dirname(filePath),
      ensureDir: vi.fn(),
      joinPath: (...segments: string[]): string => {
        if (segments[0] === PACKAGE_ROOT) {
          return path.posix.join('/package', ...segments.slice(1));
        }
        return path.posix.join(...segments);
      },
      readTextFile,
      writeTextFile,
    });

    const rewrittenBase = JSON.parse(writes.get('/runtime/config/xpod.base.json') ?? '{}');
    const handler = rewrittenBase['@graph']?.find((entry: Record<string, unknown>) =>
      entry['@id'] === 'urn:undefineds:xpod:InternalPodDataHttpHandler');
    expect(handler?.['@type']).toBe(
      'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/dist/http/InternalPodDataHttpHandler.jsonld#InternalPodDataHttpHandler',
    );
    expect(handler?.['@context']?.resourceStore).toBe(
      'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/dist/http/InternalPodDataHttpHandler.jsonld#InternalPodDataHttpHandler_options_resourceStore',
    );
    expect(handler?.['@context']?.patchBodyParser).toBe(
      'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/dist/http/InternalPodDataHttpHandler.jsonld#InternalPodDataHttpHandler_options_patchBodyParser',
    );
    expect(handler?.resourceStore).toEqual({ '@id': 'urn:solid-server:default:ResourceStore' });
    expect(handler?.patchBodyParser).toEqual({ '@id': 'urn:solid-server:default:PatchBodyParser' });
    expect(handler?.gatewayAdminProxyAuthSecret).toBeUndefined();
    expect(handler?.['InternalPodDataHttpHandler:_options_resourceStore']).toBeUndefined();
    expect(handler?.['InternalPodDataHttpHandler:_options_patchBodyParser']).toBeUndefined();
  });

  it('should escape Components config imports when runtime paths contain spaces', () => {
    const writes = new Map<string, string>();
    const writeTextFile = vi.fn((filePath: string, content: string) => {
      writes.set(filePath, content);
    });
    const ensureDir = vi.fn();
    const joinPath = (...segments: string[]): string => {
      if (segments[0] === PACKAGE_ROOT) {
        return path.posix.join('/Users/alice/Application Support/node_modules/@undefineds.co/xpod', ...segments.slice(1));
      }
      return path.posix.join(...segments);
    };
    const readTextFile = vi.fn((filePath: string): string => {
      const byPath: Record<string, unknown> = {
        '/Users/alice/Application Support/node_modules/@undefineds.co/xpod/config/local.json': {
          '@context': [
            'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld',
            'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/components/context.jsonld',
          ],
          import: ['./main.json', './xpod.base.json', './terminal.json', './extensions.local.initializer.json'],
        },
        '/Users/alice/Application Support/node_modules/@undefineds.co/xpod/config/main.json': {
          '@context': 'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld',
          import: ['css:config/app/main/default.json'],
        },
        '/Users/alice/Application Support/node_modules/@undefineds.co/xpod/config/xpod.base.json': {
          '@context': [
            'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld',
            'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/components/context.jsonld',
          ],
          import: ['./cli.json', './resolver.json'],
          '@graph': [
            {
              '@id': 'urn:test:LiteralValue',
              '@type': 'Literal',
              value: 0,
            },
            {
              '@id': 'urn:test:PodResourcesGenerator',
              '@type': 'StaticFolderGenerator',
              templateFolder: './templates/pod',
            },
            {
              '@id': 'urn:test:AuthHtml',
              '@type': 'ReactAppViewHandler',
              htmlFile: './static/app/auth.html',
            },
            {
              '@id': 'urn:test:SparqlQuadstoreResourceStore',
              '@type': 'SparqlUpdateResourceStore',
              identifierStrategy: {
                '@id': 'urn:solid-server:default:IdentifierStrategy',
              },
              accessor: {
                '@id': 'urn:undefineds:xpod:MixDataAccessor',
              },
            },
          ],
        },
        '/Users/alice/Application Support/node_modules/@undefineds.co/xpod/dist/components/context.jsonld': {
          '@context': [
            {},
            {
              SparqlUpdateResourceStore: {
                '@id': 'urn:test:SparqlUpdateResourceStore',
                '@context': {
                  identifierStrategy: {
                    '@id': 'urn:test:SparqlUpdateResourceStore_options_identifierStrategy',
                  },
                  accessor: {
                    '@id': 'urn:test:SparqlUpdateResourceStore_options_accessor',
                  },
                },
              },
            },
          ],
        },
        '/Users/alice/Application Support/node_modules/@undefineds.co/xpod/config/cli.json': {},
        '/Users/alice/Application Support/node_modules/@undefineds.co/xpod/config/resolver.json': {},
        '/Users/alice/Application Support/node_modules/@undefineds.co/xpod/config/terminal.json': {},
        '/Users/alice/Application Support/node_modules/@undefineds.co/xpod/config/extensions.local.initializer.json': {},
      };
      return JSON.stringify(byPath[filePath] ?? {});
    });
    const runtimeConfigPath = createCssRuntimeConfig({
      id: 'space-path',
      mode: 'local',
      runtimeRoot: '/Users/alice/Application Support/@linx/local/runtimes/xpod',
      cssAuthMode: 'acp',
    } as any, true, {
      dirname: (filePath: string): string => path.posix.dirname(filePath),
      ensureDir,
      joinPath,
      readTextFile,
      writeTextFile,
    });

    expect(runtimeConfigPath).toBe('/Users/alice/Application Support/@linx/local/runtimes/xpod/css-runtime.config.json');
    expect(writeTextFile).toHaveBeenCalledTimes(8);

    const parsed = JSON.parse(writes.get(runtimeConfigPath) ?? '{}');
    expect(parsed.import).toEqual([
      'file:///Users/alice/Application%20Support/@linx/local/runtimes/xpod/config/local.json',
      ...ACP_AUTH_IMPORTS,
    ]);

    const rewrittenLocal = JSON.parse(writes.get('/Users/alice/Application Support/@linx/local/runtimes/xpod/config/local.json') ?? '{}');
    expect(rewrittenLocal.import).toEqual([
      'file:///Users/alice/Application%20Support/@linx/local/runtimes/xpod/config/main.json',
      'file:///Users/alice/Application%20Support/@linx/local/runtimes/xpod/config/xpod.base.json',
      'file:///Users/alice/Application%20Support/@linx/local/runtimes/xpod/config/terminal.json',
      'file:///Users/alice/Application%20Support/@linx/local/runtimes/xpod/config/extensions.local.initializer.json',
    ]);
    expect(rewrittenLocal['@context']).toContainEqual({
      '@base': 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/config/',
    });

    const rewrittenBase = JSON.parse(writes.get('/Users/alice/Application Support/@linx/local/runtimes/xpod/config/xpod.base.json') ?? '{}');
    expect(rewrittenBase.import).toEqual([
      'file:///Users/alice/Application%20Support/@linx/local/runtimes/xpod/config/cli.json',
      'file:///Users/alice/Application%20Support/@linx/local/runtimes/xpod/config/resolver.json',
    ]);
    expect(rewrittenBase['@graph']?.[1]?.templateFolder).toBe('/Users/alice/Application Support/node_modules/@undefineds.co/xpod/templates/pod');
    expect(rewrittenBase['@graph']?.[2]?.htmlFile).toBe('/Users/alice/Application Support/node_modules/@undefineds.co/xpod/static/app/auth.html');
    expect(rewrittenBase['@graph']?.[3]?.['SparqlUpdateResourceStore:_options_identifierStrategy']).toEqual({
      '@id': 'urn:solid-server:default:IdentifierStrategy',
    });
    expect(rewrittenBase['@graph']?.[3]?.['SparqlUpdateResourceStore:_options_accessor']).toEqual({
      '@id': 'urn:undefineds:xpod:MixDataAccessor',
    });
    expect(rewrittenBase['@graph']?.[3]?.identifierStrategy).toBeUndefined();
    expect(rewrittenBase['@graph']?.[3]?.accessor).toBeUndefined();
    expect(rewrittenBase['@context']).toContainEqual({
      '@base': 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/config/',
    });

    const rewrittenMain = JSON.parse(writes.get('/Users/alice/Application Support/@linx/local/runtimes/xpod/config/main.json') ?? '{}');
    expect(rewrittenMain['@context']).toContainEqual({
      '@base': 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/config/',
    });
  });

  it('should write Components config imports from a package-local runtime dir on Windows cross-drive paths', () => {
    const writeTextFile = vi.fn();
    const readTextFile = vi.fn();
    const ensureDir = vi.fn();
    const joinPath = createWindowsJoinPath('D:\\package');
    const runtimeConfigPath = createCssRuntimeConfig({
      id: 'cross-drive',
      mode: 'local',
      runtimeRoot: 'C:\\runtime',
      cssAuthMode: 'acp',
    } as any, true, {
      dirname: (filePath: string): string => path.win32.dirname(filePath),
      ensureDir,
      joinPath,
      readTextFile,
      writeTextFile,
    });

    expect(runtimeConfigPath).toBe('D:\\package\\.xpod-runtime\\cross-drive\\css-runtime.config.json');
    expect(ensureDir).toHaveBeenCalledWith('D:\\package\\.xpod-runtime\\cross-drive');
    expect(writeTextFile).toHaveBeenCalledTimes(1);

    const [, content] = writeTextFile.mock.calls[0];
    const parsed = JSON.parse(content);
    expect(parsed.import).toEqual([
      '../../config/local.json',
      ...ACP_AUTH_IMPORTS,
    ]);
  });

  it('should detect slash-prefixed Windows cross-drive runtime roots', () => {
    const writeTextFile = vi.fn();
    const readTextFile = vi.fn();
    const ensureDir = vi.fn();
    const joinPath = createWindowsJoinPath('D:\\package');
    const runtimeConfigPath = createCssRuntimeConfig({
      id: 'cross-drive-slash-prefixed',
      mode: 'local',
      runtimeRoot: '/C:/runtime',
      cssAuthMode: 'acp',
    } as any, true, {
      dirname: (filePath: string): string => path.win32.dirname(filePath),
      ensureDir,
      joinPath,
      readTextFile,
      writeTextFile,
    });

    expect(runtimeConfigPath).toBe('D:\\package\\.xpod-runtime\\cross-drive-slash-prefixed\\css-runtime.config.json');
    expect(ensureDir).toHaveBeenCalledWith('D:\\package\\.xpod-runtime\\cross-drive-slash-prefixed');
    expect(writeTextFile).toHaveBeenCalledTimes(1);

    const [, content] = writeTextFile.mock.calls[0];
    const parsed = JSON.parse(content);
    expect(parsed.import).toEqual([
      '../../config/local.json',
      ...ACP_AUTH_IMPORTS,
    ]);
  });

  it('should normalize slash-prefixed Windows package roots before writing runtime config', () => {
    const writeTextFile = vi.fn();
    const readTextFile = vi.fn();
    const ensureDir = vi.fn();
    const joinPath = createWindowsJoinPath('/D:/package');
    const runtimeConfigPath = createCssRuntimeConfig({
      id: 'slash-prefixed-package-root',
      mode: 'local',
      runtimeRoot: 'C:\\runtime',
      cssAuthMode: 'acp',
    } as any, true, {
      dirname: (filePath: string): string => path.win32.dirname(filePath),
      ensureDir,
      joinPath,
      readTextFile,
      writeTextFile,
    });

    expect(runtimeConfigPath).toBe('D:\\package\\.xpod-runtime\\slash-prefixed-package-root\\css-runtime.config.json');
    expect(ensureDir).toHaveBeenCalledWith('D:\\package\\.xpod-runtime\\slash-prefixed-package-root');
    expect(writeTextFile).toHaveBeenCalledTimes(1);

    const [, content] = writeTextFile.mock.calls[0];
    const parsed = JSON.parse(content);
    expect(parsed.import).toEqual([
      '../../config/local.json',
      ...ACP_AUTH_IMPORTS,
    ]);
  });
});
