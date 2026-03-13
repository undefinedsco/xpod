import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@solid/community-server';
import type { ApiServiceHandle } from '../../src/api/runtime';
import type { RuntimeDriver } from '../../src/runtime/driver/types';
import type { RuntimeHost } from '../../src/runtime/host/types';
import type { RuntimePlatform } from '../../src/runtime/platform/types';
import type { GatewayRuntimeHandle } from '../../src/runtime/runner/types';

const mocked = vi.hoisted(() => ({
  createCssRuntimeConfigMock: vi.fn(() => '/tmp/runtime-css.json'),
  initRuntimeLoggerMock: vi.fn(),
  resolveRuntimeBootstrapMock: vi.fn(),
  createRuntimeEnvironmentSessionMock: vi.fn(),
  registerManagedRuntimeServicesMock: vi.fn(),
  startCssRuntimeMock: vi.fn(),
  startApiRuntimeMock: vi.fn(),
  startGatewayRuntimeMock: vi.fn(),
  stopRuntimeServicesMock: vi.fn(),
  closeAllIdentityConnectionsMock: vi.fn(),
  getLoggerForMock: vi.fn(() => ({ warn: vi.fn(), info: vi.fn() })),
}));

vi.mock('../../src/runtime/bootstrap', () => ({
  createCssRuntimeConfig: mocked.createCssRuntimeConfigMock,
  initRuntimeLogger: mocked.initRuntimeLoggerMock,
  resolveRuntimeBootstrap: mocked.resolveRuntimeBootstrapMock,
}));

vi.mock('../../src/runtime/environment', () => ({
  createRuntimeEnvironmentSession: mocked.createRuntimeEnvironmentSessionMock,
}));

vi.mock('../../src/runtime/lifecycle', () => ({
  registerManagedRuntimeServices: mocked.registerManagedRuntimeServicesMock,
  startCssRuntime: mocked.startCssRuntimeMock,
  startApiRuntime: mocked.startApiRuntimeMock,
  startGatewayRuntime: mocked.startGatewayRuntimeMock,
  stopRuntimeServices: mocked.stopRuntimeServicesMock,
}));

vi.mock('../../src/identity/drizzle/db', () => ({
  closeAllIdentityConnections: mocked.closeAllIdentityConnectionsMock,
}));

vi.mock('global-logger-factory', () => ({
  getLoggerFor: mocked.getLoggerForMock,
}));

import { startXpodRuntime } from '../../src/runtime/XpodRuntime';

function createPlatform(id = 'runtime-test-id'): RuntimePlatform {
  return {
    name: 'test-platform',
    baseEnv: {},
    createRuntimeId: vi.fn(() => id),
    cwd: vi.fn(() => process.cwd()),
    joinPath: vi.fn((...segments: string[]) => segments.join('/')),
    resolvePath: vi.fn((...segments: string[]) => segments.join('/')),
    dirname: vi.fn((filePath: string) => filePath),
    fileExists: vi.fn(() => false),
    readTextFile: vi.fn(() => ''),
    writeTextFile: vi.fn(),
    ensureDir: vi.fn(),
    getEnv: vi.fn(),
    setEnv: vi.fn(),
    fetch: vi.fn(),
  };
}

describe('startXpodRuntime driver resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocked.resolveRuntimeBootstrapMock.mockResolvedValue({
      mode: 'local',
      transport: 'port',
      logLevel: 'warn',
      bindHost: '127.0.0.1',
      baseUrl: 'http://127.0.0.1:6100/',
      cssAuthMode: 'acp',
      apiOpen: true,
      ports: { gateway: 6100, css: 6101, api: 6102 },
      sockets: {},
    });
    mocked.createRuntimeEnvironmentSessionMock.mockReturnValue({
      shorthand: { redisClient: 'localhost:6379' },
      restore: vi.fn(),
    });
    mocked.startCssRuntimeMock.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as App);
    mocked.startApiRuntimeMock.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as ApiServiceHandle);
    mocked.startGatewayRuntimeMock.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(undefined),
    } as GatewayRuntimeHandle);
    mocked.stopRuntimeServicesMock.mockResolvedValue(undefined);
  });

  it('uses driver defaults when host/platform/runners are omitted', async() => {
    const host = {
      registerSocketOrigins: vi.fn(async(): Promise<void> => undefined),
    } as unknown as RuntimeHost;
    const platform = createPlatform();
    const cssRunner = { name: 'driver-css', start: vi.fn() };
    const apiRunner = { name: 'driver-api', start: vi.fn() };
    const gatewayRunner = { name: 'driver-gateway', start: vi.fn() };
    const driver: RuntimeDriver = {
      name: 'driver-test',
      host,
      platform,
      cssRunner,
      apiRunner,
      gatewayRunner,
    };

    const runtime = await startXpodRuntime({ driver });

    expect(mocked.resolveRuntimeBootstrapMock).toHaveBeenCalledWith(
      'runtime-test-id',
      expect.objectContaining({ driver }),
      host,
      platform,
    );
    expect(mocked.startCssRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      host,
      cssRunner,
    }));
    expect(mocked.startApiRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      host,
      apiRunner,
    }));
    expect(mocked.startGatewayRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      host,
      gatewayRunner,
    }));
    expect(runtime.id).toBe('runtime-test-id');
    await runtime.stop();
    expect(mocked.stopRuntimeServicesMock).toHaveBeenCalledTimes(1);
  });

  it('prefers explicit overrides over driver defaults', async() => {
    const driverHost = {
      registerSocketOrigins: vi.fn(async(): Promise<void> => undefined),
    } as unknown as RuntimeHost;
    const overrideHost = {
      registerSocketOrigins: vi.fn(async(): Promise<void> => undefined),
    } as unknown as RuntimeHost;
    const driverPlatform = createPlatform('driver-id');
    const overridePlatform = createPlatform('override-id');
    const driver: RuntimeDriver = {
      name: 'driver-test',
      host: driverHost,
      platform: driverPlatform,
      cssRunner: { name: 'driver-css', start: vi.fn() },
      apiRunner: { name: 'driver-api', start: vi.fn() },
      gatewayRunner: { name: 'driver-gateway', start: vi.fn() },
    };
    const cssRunner = { name: 'override-css', start: vi.fn() };
    const apiRunner = { name: 'override-api', start: vi.fn() };
    const gatewayRunner = { name: 'override-gateway', start: vi.fn() };

    await startXpodRuntime({
      driver,
      host: overrideHost,
      platform: overridePlatform,
      cssRunner,
      apiRunner,
      gatewayRunner,
    });

    expect(mocked.resolveRuntimeBootstrapMock).toHaveBeenCalledWith(
      'override-id',
      expect.objectContaining({ driver }),
      overrideHost,
      overridePlatform,
    );
    expect(mocked.startCssRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      host: overrideHost,
      cssRunner,
    }));
    expect(mocked.startApiRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      host: overrideHost,
      apiRunner,
    }));
    expect(mocked.startGatewayRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      host: overrideHost,
      gatewayRunner,
    }));
  });
});
