import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRuntimeBootstrap, type RuntimeBootstrapState } from '../../src/runtime/bootstrap';
import { createRuntimeEnvironmentSession } from '../../src/runtime/environment';
import { nodeRuntimeHost } from '../../src/runtime/host/node/NodeRuntimeHost';
import type { RuntimePlatform } from '../../src/runtime/platform/types';

describe('runtime environment session', () => {
  it('should apply and restore runtime env deterministically', async() => {
    const previous = process.env.CSS_BASE_URL;
    const state = await resolveRuntimeBootstrap('env-test', {
      mode: 'local',
      transport: 'port',
      runtimeRoot: '.test-data/runtime-environment',
      bindHost: '127.0.0.1',
      gatewayPort: 5810,
      cssPort: 5811,
      apiPort: 5812,
    }, nodeRuntimeHost);

    const session = createRuntimeEnvironmentSession(state, {
      mode: 'local',
      transport: 'port',
    });

    expect(process.env.CSS_BASE_URL).toBe('http://127.0.0.1:5810/');
    expect(session.shorthand.edition).toBe('local');

    session.restore();
    expect(process.env.CSS_BASE_URL).toBe(previous);

    session.restore();
    expect(process.env.CSS_BASE_URL).toBe(previous);
  });

  it('should apply and restore env through an injected platform', () => {
    const envStore: Record<string, string | undefined> = {
      EXISTING_FLAG: 'keep-me',
    };
    const platform: RuntimePlatform = {
      name: 'fake-platform',
      baseEnv: {
        CSS_REDIS_CLIENT: 'redis://base-env',
      },
      createRuntimeId: (): string => 'platform-id',
      cwd: (): string => '/sandbox',
      joinPath: (...segments: string[]): string => path.posix.join(...segments),
      resolvePath: (...segments: string[]): string => path.posix.resolve(...segments),
      dirname: (filePath: string): string => path.posix.dirname(filePath),
      fileExists: (filePath: string): boolean => filePath === '/sandbox/.env.runtime',
      readTextFile: (): string => 'CSS_ALLOWED_HOSTS=pod.local\nXPOD_NODE_ID=node-from-file\n',
      writeTextFile: (): void => undefined,
      ensureDir: (): void => undefined,
      getEnv: (key: string): string | undefined => envStore[key],
      setEnv: (key: string, value: string | undefined): void => {
        if (value === undefined) {
          delete envStore[key];
          return;
        }
        envStore[key] = value;
      },
      fetch: async(): Promise<Response> => new Response(null, { status: 204 }),
    };
    const state = {
      id: 'env-platform',
      host: nodeRuntimeHost,
      mode: 'local',
      transport: 'port',
      bindHost: '127.0.0.1',
      runtimeRoot: '/runtime-root',
      rootFilePath: '/runtime-root/data',
      sparqlEndpoint: 'sqlite:/runtime-root/quadstore.sqlite',
      identityDbUrl: 'sqlite:/runtime-root/identity.sqlite',
      usageDbUrl: 'sqlite:/runtime-root/usage.sqlite',
      cssAuthMode: 'acp',
      apiOpen: false,
      logLevel: 'warn',
      baseUrl: 'http://127.0.0.1:5810/',
      envFilePath: '/sandbox/.env.runtime',
      ports: {
        gateway: 5810,
        css: 5811,
        api: 5812,
      },
      sockets: {},
    } as RuntimeBootstrapState;

    const session = createRuntimeEnvironmentSession(state, {
      mode: 'local',
      transport: 'port',
    }, platform);

    expect(session.env.CSS_ALLOWED_HOSTS).toBe('pod.local');
    expect(envStore.CSS_BASE_URL).toBe('http://127.0.0.1:5810/');
    expect(session.shorthand.redisClient).toBe('redis://base-env');
    expect(session.shorthand.nodeId).toBe('node-from-file');

    session.restore();
    expect(envStore.CSS_BASE_URL).toBeUndefined();
    expect(envStore.EXISTING_FLAG).toBe('keep-me');
  });
});
