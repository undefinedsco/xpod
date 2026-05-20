import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { EmbeddedInngestService } from '../../src/api/runs/EmbeddedInngestService';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

describe('EmbeddedInngestService', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('stays disabled when cloud Inngest is not configured', async () => {
    const service = new EmbeddedInngestService({
      edition: 'cloud',
      apiBaseUrl: 'https://api.xpod.example',
      databaseUrl: 'postgres://db/xpod',
    });

    const config = await service.start();

    expect(config).toEqual({
      enabled: false,
      durableDelivery: false,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('stays disabled when local Inngest is not configured', async () => {
    const service = new EmbeddedInngestService({
      edition: 'local',
      apiBaseUrl: 'http://127.0.0.1:3001',
      databaseUrl: 'sqlite:./identity.sqlite',
    });

    const config = await service.start();

    expect(config).toEqual({
      enabled: false,
      durableDelivery: false,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses a deployment-provided cloud Inngest URL without spawning per API replica', async () => {
    const service = new EmbeddedInngestService({
      edition: 'cloud',
      apiBaseUrl: 'https://api.xpod.example',
      databaseUrl: 'postgres://db/xpod',
      redisUrl: 'redis://redis:6379',
      baseUrl: 'http://xpod-inngest:8288',
      eventKey: 'cluster-event-key',
      signingKey: 'cluster-signing-key',
    });

    const config = await service.start();

    expect(config).toEqual({
      enabled: true,
      durableDelivery: true,
      baseUrl: 'http://xpod-inngest:8288',
      eventKey: 'cluster-event-key',
      signingKey: 'cluster-signing-key',
      functionEndpoint: 'https://api.xpod.example/api/inngest',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects managed cloud Inngest without explicit signing secrets', async () => {
    const service = new EmbeddedInngestService({
      edition: 'cloud',
      apiBaseUrl: 'https://api.xpod.example',
      databaseUrl: 'postgres://db/xpod',
      baseUrl: 'http://xpod-inngest:8288',
    });

    await expect(service.start()).rejects.toThrow('Managed/cloud Inngest requires explicit eventKey and signingKey');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns local Inngest when explicitly configured for local single-node mode', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn((signal?: string) => {
      child.emit('exit', signal === 'SIGTERM' ? 0 : 1, signal);
      return true;
    });
    spawnMock.mockReturnValueOnce(child);

    const service = new EmbeddedInngestService({
      edition: 'local',
      apiBaseUrl: 'http://127.0.0.1:3001',
      databaseUrl: 'sqlite:./identity.sqlite',
      mode: 'spawn',
      binaryPath: 'node',
      baseUrl: 'http://127.0.0.1:8288',
      eventKey: 'local-event-key',
      signingKey: 'local-signing-key',
    });

    await service.start();
    await service.stop();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0];
    const portIndex = args.indexOf('--port');
    expect(command).toBe('node');
    expect(portIndex).toBeGreaterThan(-1);
    const port = args[portIndex + 1];
    expect(port).toMatch(/^\d+$/);
    expect(args).toEqual([
      'dev',
      '--no-discovery',
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '-u',
      'http://127.0.0.1:3001/api/inngest',
    ]);
    expect(options).toEqual(expect.objectContaining({
      env: expect.objectContaining({
        INNGEST_BASE_URL: 'http://127.0.0.1:8288',
        INNGEST_EVENT_KEY: 'local-event-key',
        INNGEST_SIGNING_KEY: 'local-signing-key',
      }),
    }));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('keeps local runtime usable without durable delivery when the Inngest CLI wrapper is not installed', async () => {
    const service = new EmbeddedInngestService({
      edition: 'local',
      apiBaseUrl: 'http://127.0.0.1:3001',
      databaseUrl: 'sqlite:./identity.sqlite',
      mode: 'spawn',
      binaryPath: '/not-found/inngest',
      baseUrl: 'http://127.0.0.1:8288',
    });

    const config = await service.start();

    expect(config).toEqual({
      enabled: true,
      durableDelivery: false,
      baseUrl: 'http://127.0.0.1:8288',
      eventKey: 'xpod-local-event-key',
      signingKey: 'signkey-test-xpod-local-signing-key',
      functionEndpoint: 'http://127.0.0.1:3001/api/inngest',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
