import { describe, expect, it, vi } from 'vitest';
import type { App } from '@solid/community-server';
import type { AuthContext } from '../../src/api/auth/AuthContext';
import type { ApiServiceHandle } from '../../src/api/runtime';
import { Supervisor } from '../../src/supervisor/Supervisor';
import {
  createOpenAuthContext,
  startApiRuntime,
  startCssRuntime,
  startGatewayRuntime,
} from '../../src/runtime/lifecycle';
import type { RuntimeBootstrapState } from '../../src/runtime/bootstrap';
import type { RuntimeHost } from '../../src/runtime/host/types';
import type {
  ApiRuntimeRunner,
  CssRuntimeRunner,
  GatewayRuntimeHandle,
  GatewayRuntimeRunner,
} from '../../src/runtime/runner/types';

describe('runtime lifecycle helpers', () => {
  it('should delegate CSS app startup to the injected runner', async() => {
    const app = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as App;
    const cssRunner: CssRuntimeRunner = {
      name: 'fake-css-runner',
      start: vi.fn().mockResolvedValue(app),
    };
    const host = {
      waitForPortReady: vi.fn().mockResolvedValue(undefined),
    } as Pick<RuntimeHost, 'waitForPortReady'> as RuntimeHost;
    const state = {
      mode: 'local',
      transport: 'port',
      logLevel: 'warn',
      cssAuthMode: 'acp',
      ports: { css: 6111 },
      sockets: {},
      baseUrl: 'http://127.0.0.1:6100/',
    } as RuntimeBootstrapState;

    const result = await startCssRuntime({
      state,
      host,
      runtimeShorthand: { redisClient: 'localhost:6379' },
      supervisor: new Supervisor({ handleProcessSignals: false }),
      open: false,
      createCssRuntimeConfig: (): string => '/tmp/runtime-css.json',
      cssRunner,
    });

    expect(result).toBe(app);
    expect(cssRunner.start).toHaveBeenCalledWith({
      configPath: '/tmp/runtime-css.json',
      packageRoot: expect.stringContaining('/xpod'),
      logLevel: 'warn',
      shorthand: {
        port: 6111,
        redisClient: 'localhost:6379',
      },
    });
    expect(host.waitForPortReady).toHaveBeenCalledWith(6111, '127.0.0.1');
  });

  it('should delegate API service startup to the injected runner', async() => {
    const apiService = {
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as ApiServiceHandle;
    const apiRunner: ApiRuntimeRunner = {
      name: 'fake-api-runner',
      start: vi.fn().mockResolvedValue(apiService),
    };
    const host = {} as RuntimeHost;
    const state = {
      mode: 'local',
      transport: 'socket',
      apiOpen: true,
      ports: { api: 6112 },
      sockets: { api: '/tmp/xpod-api.sock' },
      baseUrl: 'http://localhost/',
    } as RuntimeBootstrapState;
    const authContext: AuthContext = {
      type: 'solid',
      webId: 'http://localhost/test/profile/card#me',
      accountId: 'test-account',
      displayName: 'Test User',
    };

    const result = await startApiRuntime({
      state,
      host,
      supervisor: new Supervisor({ handleProcessSignals: false }),
      authContext,
      apiRunner,
    });

    expect(result).toBe(apiService);
    expect(apiRunner.start).toHaveBeenCalledWith({
      open: true,
      authContext: createOpenAuthContext('http://localhost/', authContext),
      runtimeHost: host,
    });
  });

  it('should delegate gateway startup to the injected runner', async() => {
    const gateway = {
      stop: vi.fn().mockResolvedValue(undefined),
    } as GatewayRuntimeHandle;
    const gatewayRunner: GatewayRuntimeRunner = {
      name: 'fake-gateway-runner',
      start: vi.fn().mockResolvedValue(gateway),
    };
    const host = {} as RuntimeHost;
    const supervisor = new Supervisor({ handleProcessSignals: false });
    const state = {
      mode: 'local',
      transport: 'socket',
      bindHost: '127.0.0.1',
      ports: {
        gateway: 6110,
        css: 6111,
        api: 6112,
      },
      sockets: {
        gateway: '/tmp/xpod-gateway.sock',
        css: '/tmp/xpod-css.sock',
        api: '/tmp/xpod-api.sock',
      },
      baseUrl: 'http://localhost/',
    } as RuntimeBootstrapState;

    const result = await startGatewayRuntime({
      state,
      host,
      supervisor,
      shutdownHandler: async(): Promise<void> => undefined,
      gatewayRunner,
    });

    expect(result).toBe(gateway);
    expect(gatewayRunner.start).toHaveBeenCalledWith({
      port: 6110,
      bindHost: '127.0.0.1',
      socketPath: '/tmp/xpod-gateway.sock',
      shutdownHandler: expect.any(Function),
      baseUrl: 'http://localhost/',
      runtimeHost: host,
      supervisor,
      targets: {
        css: { socketPath: '/tmp/xpod-css.sock' },
        api: { socketPath: '/tmp/xpod-api.sock' },
      },
    });
  });
});
