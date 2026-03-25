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
    }, state);

    expect(runtimeEnv.CSS_BASE_URL).toBe('http://127.0.0.1:5710/');
    expect(runtimeEnv.API_PORT).toBe('5712');
    expect(shorthand.edition).toBe('server');
    expect(shorthand.nodeId).toBe('node-1');
    expect(shorthand.edgeNodesEnabled).toBe(true);
    expect(shorthand.centerRegistrationEnabled).toBe(true);
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
      '../package/config/runtime-open.json',
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
      '../../config/runtime-open.json',
    ]);
  });
});
