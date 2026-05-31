import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildRuntimeEnv, buildRuntimeShorthand, createCssRuntimeConfig, resolveRuntimeBootstrap } from '../../src/runtime/bootstrap';
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

describe('runtime bootstrap helpers', () => {
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
    });

    const shorthand = buildRuntimeShorthand(runtimeEnv, {
      mode: 'cloud',
      edgeNodesEnabled: true,
      centerRegistrationEnabled: true,
    }, state, {});

    expect(runtimeEnv.CSS_BASE_URL).toBe('http://127.0.0.1:5710/');
    expect(runtimeEnv.API_PORT).toBe('5712');
    expect(shorthand.edition).toBe('server');
    expect(shorthand.nodeId).toBe('node-1');
    expect(shorthand.edgeNodesEnabled).toBe(true);
    expect(shorthand.centerRegistrationEnabled).toBe(true);
    expect(shorthand.emailConfigHost).toBe('');
    expect(shorthand.emailConfigPort).toBe('587');
    expect(shorthand.emailConfigAuthUser).toBe('');
    expect(shorthand.emailConfigAuthPass).toBe('');
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

    expect(runtimeEnv.CSS_TOKEN_ENDPOINT).toBe('http://127.0.0.1:5820/.oidc/token');
    expect(shorthand.oidcIssuer).toBeUndefined();
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
      writeTextFile,
    });

    expect(runtimeConfigPath).toBe(`D:\\runtime\\css-runtime.config.json`);
    expect(ensureDir).not.toHaveBeenCalled();
    expect(writeTextFile).toHaveBeenCalledTimes(1);

    const [, content] = writeTextFile.mock.calls[0];
    const parsed = JSON.parse(content);
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

  it('should escape Components config imports when runtime paths contain spaces', () => {
    const writeTextFile = vi.fn();
    const ensureDir = vi.fn();
    const joinPath = (...segments: string[]): string => {
      if (segments[0] === PACKAGE_ROOT) {
        return path.posix.join('/Users/alice/Application Support/@undefineds.co/xpod', ...segments.slice(1));
      }
      return path.posix.join(...segments);
    };
    const runtimeConfigPath = createCssRuntimeConfig({
      id: 'space-path',
      mode: 'local',
      runtimeRoot: '/Users/alice/Application Support/@linx/local/runtimes/xpod',
      cssAuthMode: 'acp',
    } as any, true, {
      dirname: (filePath: string): string => path.posix.dirname(filePath),
      ensureDir,
      joinPath,
      writeTextFile,
    });

    expect(runtimeConfigPath).toBe('/Users/alice/Application Support/@linx/local/runtimes/xpod/css-runtime.config.json');
    expect(writeTextFile).toHaveBeenCalledTimes(1);

    const [, content] = writeTextFile.mock.calls[0];
    const parsed = JSON.parse(content);
    expect(parsed.import).toEqual([
      'file:///Users/alice/Application%20Support/@undefineds.co/xpod/config/local.json',
      ...ACP_AUTH_IMPORTS,
    ]);
  });

  it('should write Components config imports from a package-local runtime dir on Windows cross-drive paths', () => {
    const writeTextFile = vi.fn();
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
