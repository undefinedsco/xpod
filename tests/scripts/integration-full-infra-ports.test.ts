import net from 'node:net';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { EventEmitter } from 'node:events';

const { startRuntime, spawn, socket, objectProbe } = vi.hoisted(() => ({
  startRuntime: vi.fn(), spawn: vi.fn(), socket: vi.fn(), objectProbe: vi.fn(),
}));
vi.mock('../../src/runtime/XpodRuntime', () => ({ startXpodRuntime: startRuntime }));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('node:net', async importOriginal => ({ default: { ...await importOriginal<typeof import('node:net')>(), Socket: socket } }));
vi.mock('../../tests/helpers/dockerObjectStore', async importOriginal => ({
  ...await importOriginal<typeof import('../../tests/helpers/dockerObjectStore')>(), probeObjectStore: objectProbe,
}));
import { hasHealthyComposeInfra, selectFullInfrastructurePorts, startFullRuntimes, waitForInfraServices } from '../../scripts/run-integration-full';
import { findGatewayIngressPort, requireFreePortForWildcard, getEphemeralLoopbackPort } from '../../src/runtime/port-finder';
import { reservedPorts } from '../../src/runtime/port-reservations';
import { resolveFullIntegrationInfra } from '../helpers/fullIntegrationInfra';

const ports = {
  cloud: { gateway: 6300, css: 6310, api: 6311 },
  cloudB: { gateway: 6400, css: 6410, api: 6411 },
  local: { gateway: 5737, css: 5747, api: 5748 },
  standalone: { gateway: 5739, css: 5749, api: 5750 },
};
function clearEnv(key: string): void {
  // Vitest 1's stubEnv(undefined) is a literal string on this Bun-backed runner.
  vi.stubEnv(key, '');
  delete process.env[key];
}

describe('Full infrastructure host-port authority', () => {
  afterEach(() => { vi.unstubAllEnvs(); startRuntime.mockReset(); spawn.mockReset(); socket.mockReset(); objectProbe.mockReset(); });

  it('keeps default runtime endpoints', async () => {
    for (const key of ['XPOD_FULL_POSTGRES_PORT', 'XPOD_FULL_REDIS_PORT', 'XPOD_FULL_OBJECT_STORE_PORT', 'XPOD_FULL_PG_URL']) clearEnv(key);
    startRuntime.mockResolvedValue({ stop: vi.fn() });
    await startFullRuntimes(ports, 'fixture-command');
    expect(startRuntime.mock.calls[0][0]).toMatchObject({
      identityDbUrl: 'postgres://xpod:xpod@localhost:5432/xpod',
      env: { CSS_REDIS_CLIENT: 'localhost:6379', CSS_MINIO_ENDPOINT: 'http://localhost:9000' },
    });
  });

  it('uses alternate ports for both Cloud nodes without starting real runtimes', async () => {
    vi.stubEnv('XPOD_FULL_POSTGRES_PORT', '15432');
    vi.stubEnv('XPOD_FULL_REDIS_PORT', '16379');
    vi.stubEnv('XPOD_FULL_OBJECT_STORE_PORT', '19000');
    clearEnv('XPOD_FULL_PG_URL');
    startRuntime.mockResolvedValue({ stop: vi.fn() });
    await startFullRuntimes(ports, 'fixture-command');
    for (const [options] of startRuntime.mock.calls.slice(0, 2)) {
      expect(options).toMatchObject({
        identityDbUrl: 'postgres://xpod:xpod@localhost:15432/xpod',
        sparqlEndpoint: 'postgres://xpod:xpod@localhost:15432/xpod',
        env: { CSS_REDIS_CLIENT: 'localhost:16379', CSS_MINIO_ENDPOINT: 'http://localhost:19000' },
      });
    }
  });

  it('publishes selected host ports while keeping container listeners fixed', async () => {
    const source = await readFile('docker-compose.cluster.yml', 'utf8');
    const selected: Record<string, string> = { XPOD_FULL_POSTGRES_PORT: '15432', XPOD_FULL_REDIS_PORT: '16379', XPOD_FULL_OBJECT_STORE_PORT: '19000' };
    const compose = parse(source.replace(/\$\{(XPOD_FULL_\w+):-([^}]+)\}/gu, (_, key: string, fallback: string) => selected[key] ?? fallback));
    expect(compose.services.postgres.ports).toEqual(['15432:5432']);
    expect(compose.services.redis.ports).toEqual(['16379:6379']);
    expect(compose.services.minio.ports).toEqual(['19000:9000']);
    expect(compose.services.minio.environment.VGW_ARGS).toBe('--port :9000');
  });

  it.each(['', '0', '65536', '-1', '01', '1.5', ' 5432', '5432x'])('rejects invalid host port %j before startup or probes', async raw => {
    vi.stubEnv('XPOD_FULL_POSTGRES_PORT', raw);
    await expect(startFullRuntimes(ports, 'fixture-command')).rejects.toThrow('Invalid XPOD_FULL_POSTGRES_PORT');
    expect(startRuntime).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
    expect(objectProbe).not.toHaveBeenCalled();
  });

  it('rejects duplicate ports and PG endpoint conflicts without exposing credentials', () => {
    expect(() => resolveFullIntegrationInfra({ XPOD_FULL_REDIS_PORT: '5432' })).toThrow('must be distinct');
    for (const url of ['postgres://user:private@localhost:5432/custom', 'postgres://user:private@foreign.invalid:15432/custom', 'invalid-private',
      'postgres://user:private@localhost:15432/custom?host=foreign.invalid', 'postgres://user:private@localhost:15432/custom?port=5432',
      'postgres://user:private@localhost:15432/custom?host=localhost&host=foreign.invalid',
      'postgres://user:private@localhost:15432/custom?port=15432&port=5432']) {
      let error: Error | undefined;
      try { resolveFullIntegrationInfra({ XPOD_FULL_POSTGRES_PORT: '15432', XPOD_FULL_PG_URL: url }); } catch (cause) { error = cause as Error; }
      expect(error).toBeDefined();
      expect(error!.message).not.toContain('private');
    }
  });

  it('makes the implicit PostgreSQL port explicit instead of inheriting PGPORT', () => {
    expect(resolveFullIntegrationInfra({ XPOD_FULL_PG_URL: 'postgres://custom:fixture@localhost/custom' }).postgresUrl)
      .toBe('postgres://custom:fixture@localhost:5432/custom');
  });

  it('preserves a matching custom loopback PG URL and propagates the same authority to PG consumers', async () => {
    const url = 'postgresql://custom:fixture@127.0.0.1:15432/custom_db?application_name=full';
    const infra = resolveFullIntegrationInfra({ XPOD_FULL_POSTGRES_PORT: '15432', XPOD_FULL_PG_URL: url });
    expect(infra.postgresUrl).toBe(url);
    expect(infra.hostEnv.XPOD_FULL_POSTGRES_PORT).toBe('15432');
    for (const name of ['DockerCluster', 'CloudQuotaBusinessToken']) {
      const source = await readFile(`tests/integration/${name}.integration.test.ts`, 'utf8');
      expect(source).toContain('resolveFullIntegrationInfra().postgresUrl');
      expect(source).not.toMatch(/port:\s*5432/u);
      expect(source).toMatch(/new Client\(\{\s*connectionString:/u);
    }
    vi.stubEnv('XPOD_FULL_POSTGRES_PORT', '15432'); vi.stubEnv('XPOD_FULL_PG_URL', url);
    startRuntime.mockResolvedValue({ stop: vi.fn() });
    await startFullRuntimes(ports, 'fixture-command');
    expect(startRuntime.mock.calls[0][0].identityDbUrl).toBe(infra.postgresUrl);
  });

  it.each(['reuse', 'startup'])('does not probe or write foreign services when %s publications differ', async entry => {
    spawn.mockImplementation((_command, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
      child.stdout = new EventEmitter();
      queueMicrotask(() => {
        if (args.includes('port')) child.stdout.emit('data', Buffer.from('0.0.0.0:1\n'));
        child.emit('close', 0);
      });
      return child;
    });
    if (entry === 'reuse') expect(await hasHealthyComposeInfra()).toBe(false);
    else await expect(waitForInfraServices(1, 0)).rejects.toThrow('host publications do not match');
    expect(socket).not.toHaveBeenCalled(); expect(objectProbe).not.toHaveBeenCalled();
    expect(spawn.mock.calls.some(([, args]) => args.includes('SET'))).toBe(false);
  });
  it('protects pending explicit listeners from the real ingress allocator and restores foreign env', async () => {
    vi.stubEnv('XPOD_RESERVED_PORTS', '4599,4600');
    const base = await getEphemeralLoopbackPort();
    const planned = { ...ports, local: { gateway: base, css: base + 10, api: base + 11 }, standalone: { gateway: base + 3, css: base + 12, api: base + 13 } };
    let ingress: number | undefined;
    startRuntime.mockImplementation(async options => {
      if (options.gatewayPort === base) {
        ingress = await findGatewayIngressPort(base);
        expect(ingress).not.toBe(planned.standalone.gateway);
        expect(await requireFreePortForWildcard(planned.standalone.gateway)).toBe(planned.standalone.gateway);
        const listener = net.createServer();
        try {
          await new Promise<void>((resolve, reject) => {
            listener.once('error', reject);
            listener.listen(planned.standalone.gateway, '127.0.0.1', resolve);
          });
          expect((listener.address() as net.AddressInfo).port).toBe(planned.standalone.gateway);
        } finally {
          if (listener.listening) await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
        }
      }
      if (options.gatewayPort === base) expect(reservedPorts().has(planned.standalone.gateway)).toBe(true);
      if (options.gatewayPort === base) expect(options.env.XPOD_RESERVED_PORTS).toContain('4599,4600');
      return { stop: vi.fn() };
    });
    await startFullRuntimes(planned, 'fixture-command');
    expect(ingress).toBeDefined();
    expect(process.env.XPOD_RESERVED_PORTS).toBe('4599,4600');
  });

  it.each([undefined, '', '4599,4600'])('restores exact previous reservation %j after startup and cleanup fail', async old => {
    if (old === undefined) clearEnv('XPOD_RESERVED_PORTS'); else vi.stubEnv('XPOD_RESERVED_PORTS', old);
    const primary = new Error('startup primary');
    const stop = vi.fn(async () => { throw new Error('cleanup secondary'); });
    startRuntime.mockResolvedValueOnce({ stop }).mockRejectedValueOnce(primary);
    await expect(startFullRuntimes(ports, 'fixture-command')).rejects.toBe(primary);
    expect(stop).toHaveBeenCalledOnce();
    expect(process.env.XPOD_RESERVED_PORTS).toBe(old);
  });

  it('keeps foreign file reservations unchanged when startup fails', async () => {
    await mkdir('.test-data', { recursive: true });
    const directory = await mkdtemp('.test-data/full-infra-port-reservations-');
    const file = `${directory}/4666.json`;
    const bytes = JSON.stringify({ port: 4666, owner: 'foreign-fixture-owner', group: 'foreign-fixture', reservedAt: new Date().toISOString() });
    try {
      await writeFile(file, bytes, { mode: 0o600 });
      vi.stubEnv('XPOD_PORT_RESERVATION_DIR', directory);
      const primary = new Error('primary');
      startRuntime.mockImplementation(async () => {
        expect(reservedPorts().has(4666)).toBe(true);
        throw primary;
      });
      await expect(startFullRuntimes(ports, 'fixture-command')).rejects.toBe(primary);
      expect(await readFile(file, 'utf8')).toBe(bytes);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['XPOD_FULL_POSTGRES_PORT', 'XPOD_FULL_REDIS_PORT', 'XPOD_FULL_OBJECT_STORE_PORT'])('rejects owned reuse conflicting with explicit %s before authenticated probes', async key => {
    for (const name of ['XPOD_FULL_POSTGRES_PORT', 'XPOD_FULL_REDIS_PORT', 'XPOD_FULL_OBJECT_STORE_PORT', 'XPOD_FULL_PG_URL']) clearEnv(name);
    vi.stubEnv(key, '25499');
    spawn.mockImplementation((_command, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
      child.stdout = new EventEmitter();
      queueMicrotask(() => {
        const service = args[args.indexOf('port') + 1];
        child.stdout.emit('data', Buffer.from(`127.0.0.1:${({ postgres: 25432, redis: 26379, minio: 29000 } as Record<string, number>)[service]}\n`));
        child.emit('close', 0);
      });
      return child;
    });
    await expect(selectFullInfrastructurePorts(true, new Set())).rejects.toThrow('Explicit infrastructure port conflicts');
    expect(process.env[key]).toBe('25499');
    expect(spawn.mock.calls.every(([, args]) => args.includes('port'))).toBe(true);
    expect(socket).not.toHaveBeenCalled(); expect(objectProbe).not.toHaveBeenCalled(); expect(startRuntime).not.toHaveBeenCalled();
  });

  it('preserves a matching explicit owned port and derives only unset owned publications', async () => {
    for (const key of ['XPOD_FULL_POSTGRES_PORT', 'XPOD_FULL_REDIS_PORT', 'XPOD_FULL_OBJECT_STORE_PORT', 'XPOD_FULL_PG_URL']) clearEnv(key);
    vi.stubEnv('XPOD_FULL_POSTGRES_PORT', '25432');
    spawn.mockImplementation((_command, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter }; child.stdout = new EventEmitter();
      queueMicrotask(() => {
        const service = args[args.indexOf('port') + 1];
        child.stdout.emit('data', Buffer.from(`127.0.0.1:${({ postgres: 25432, redis: 26379, minio: 29000 } as Record<string, number>)[service]}\n`));
        child.emit('close', 0);
      }); return child;
    });
    const reserved = new Set<number>();
    expect(await selectFullInfrastructurePorts(true, reserved)).toEqual({ postgres: 25432, redis: 26379, minio: 29000 });
    expect(reserved).toEqual(new Set([25432, 26379, 29000]));
    expect(process.env.XPOD_FULL_POSTGRES_PORT).toBe('25432'); expect(process.env.XPOD_FULL_REDIS_PORT).toBeUndefined();
    expect(socket).not.toHaveBeenCalled(); expect(objectProbe).not.toHaveBeenCalled();
  });

});
