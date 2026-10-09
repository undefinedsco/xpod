import net from 'node:net';
import path from 'node:path';
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { resolveFullRuntimePorts, resolveReadyFullRuntimePorts, resolveFullInfrastructurePorts, fullInfrastructureConnections, createFullInfrastructureOverlay } from '../../scripts/run-integration-full';
import { getEphemeralLoopbackPort, getFreePortForWildcard, isFreePortForWildcard } from '../../src/runtime/port-finder';

describe('full integration port planning', () => {
  it('uses the release PostgreSQL candidate in the resolved Compose stack', () => {
    const image = `ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:${'1'.repeat(64)}`;
    const result = spawnSync('docker', ['compose', '-f', 'docker-compose.cluster.yml',
      '-f', 'docker-compose.cluster.integration.yml', 'config', '--format', 'json'], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, XPOD_FULL_POSTGRES_IMAGE: image },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).services.postgres.image).toBe(image);
  });

  it('reserves every ingress together with future instance service ports', async () => {
    const plans = Object.values(await resolveFullRuntimePorts());
    const selected = plans.flatMap(plan => [plan.gateway, plan.css, plan.api, 'ingress' in plan ? plan.ingress : undefined]);
    expect(selected.every(port => typeof port === 'number' && port > 0)).toBe(true);
    expect(new Set(selected).size).toBe(16);
    for (const port of selected) {
      if (typeof port !== 'number') throw new Error('Missing planned ingress port');
      expect(await isFreePortForWildcard(port)).toBe(true);
    }
  });

  it('avoids an occupied infrastructure listener and reserves infrastructure with all runtime ports', async () => {
    const listener = net.createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('Missing occupied test listener');
      const reserved = new Set<number>();
      const infrastructure = await resolveFullInfrastructurePorts(reserved, {
        postgres: address.port, redis: address.port, minio: address.port,
      });
      const runtimes = Object.values(await resolveFullRuntimePorts(reserved));
      const selected = [...Object.values(infrastructure), ...runtimes.flatMap(plan => [plan.gateway, plan.css, plan.api, plan.ingress])];
      expect(selected).not.toContain(address.port);
      expect(new Set(selected).size).toBe(19);
      expect(reserved.size).toBe(19);
      for (const port of selected) expect(await isFreePortForWildcard(port)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    }
  });

  it('uses a real OS-selected port for every dynamic service axis', async () => {
    const picked: number[] = [];
    const plans = await resolveFullRuntimePorts(new Set(), {}, {
      async ephemeral() { const port = await getEphemeralLoopbackPort(); picked.push(port); return port; },
      isFree: isFreePortForWildcard,
      async preferred() { throw new Error('Dynamic planning must not scan a preferred range'); },
    });
    const selected = Object.values(plans).flatMap(plan => [plan.gateway, plan.css, plan.api, plan.ingress]);
    expect(selected).toHaveLength(16);
    expect(new Set(selected).size).toBe(16);
    expect(selected.every(port => picked.includes(port) && port > 0)).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, 65536])('rejects invalid explicit runtime preference %s before allocation', async preferred => {
    await expect(resolveFullRuntimePorts(new Set(), { cloud: preferred })).rejects.toThrow('Invalid preferred runtime port for cloud');
  });

  it('keeps explicit preferred-and-scan behavior alongside dynamic runtimes', async () => {
    const preferred = await getFreePortForWildcard(30000);
    if (preferred > 65524) throw new Error('No room for the occupied preferred-port fixture');
    const listener = net.createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(preferred, '127.0.0.1', resolve);
    });
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('Missing occupied listener');
      const base = address.port;
      const reserved = new Set([base + 10, base + 11]);
      const plans = await resolveFullRuntimePorts(reserved, { cloud: base });
      expect(plans.cloud.gateway).toBeGreaterThan(base);
      expect(plans.cloud.css).toBeGreaterThan(base + 11);
      expect(plans.cloud.api).toBeGreaterThan(base + 11);
      expect(plans.cloud.ingress).toBeGreaterThanOrEqual(plans.cloud.gateway + 3);
      const selected = Object.values(plans).flatMap(plan => [plan.gateway, plan.css, plan.api, plan.ingress]);
      expect(new Set(selected).size).toBe(16);
      expect(selected).not.toContain(base);
      expect(selected).not.toContain(base + 10);
      expect(selected).not.toContain(base + 11);
    } finally { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
  });

  it('reselects OS candidates already reserved or occupied on a service address', async () => {
    const listener = net.createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('Missing occupied listener');
      const reservedPort = await getEphemeralLoopbackPort();
      const candidates = [reservedPort, address.port];
      const plans = await resolveFullRuntimePorts(new Set([reservedPort]), {}, {
        async ephemeral() { return candidates.shift() ?? await getEphemeralLoopbackPort(); },
        isFree: isFreePortForWildcard,
        async preferred() { throw new Error('Unexpected preferred allocation'); },
      });
      const selected = Object.values(plans).flatMap(plan => [plan.gateway, plan.css, plan.api, plan.ingress]);
      expect(selected).not.toContain(reservedPort);
      expect(selected).not.toContain(address.port);
      expect(new Set(selected).size).toBe(16);
    } finally { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
  });

  it('waits for readiness before selecting real runtime ports and preserves its failure cause', async () => {
    let ready = false;
    const plans = await resolveReadyFullRuntimePorts(new Set(), async () => { ready = true; }, {}, {
      async ephemeral() { expect(ready).toBe(true); return getEphemeralLoopbackPort(); },
      isFree: isFreePortForWildcard,
      async preferred() { throw new Error('Unexpected preferred allocation'); },
    });
    expect(Object.values(plans).flatMap(plan => [plan.gateway, plan.css, plan.api, plan.ingress])).toHaveLength(16);
    const cause = new Error('controlled readiness failure');
    await expect(resolveReadyFullRuntimePorts(new Set(), async () => { throw cause; }, {}, {
      async ephemeral() { throw new Error('Must not allocate before readiness'); },
      isFree: isFreePortForWildcard,
      async preferred() { throw new Error('Must not allocate before readiness'); },
    })).rejects.toBe(cause);
  });

  it('derives all connections from owned ports and rejects a foreign PG connection', () => {
    const infrastructure = { postgres: 25432, redis: 26379, minio: 29000 };
    const connections = fullInfrastructureConnections(infrastructure);
    expect(new URL(connections.postgresUrl).port).toBe('25432');
    expect(connections.redisUrl).toBe('redis://localhost:26379');
    expect(connections.minioUrl).toBe('http://localhost:29000');
    expect(() => fullInfrastructureConnections(infrastructure, 'postgres://localhost:5432/xpod')).toThrow(/owned/i);
    expect(() => fullInfrastructureConnections(infrastructure, 'postgres://foreign.example:25432/xpod')).toThrow(/owned/i);
    expect(() => fullInfrastructureConnections(infrastructure, 'invalid')).toThrow(/owned/i);
    expect(fullInfrastructureConnections(infrastructure, connections.postgresUrl).postgresUrl).toBe(connections.postgresUrl);
  });

  it('keeps the generated Compose port overlay private and removes it during cleanup', async () => {
    const root = path.resolve('.test-data/full-infra-port-plan');
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, 'overlay-'));
    try {
      const overlay = await createFullInfrastructureOverlay({ postgres: 25432, redis: 26379, minio: 29000 }, directory);
      try {
        expect((await stat(path.dirname(overlay.path))).mode & 0o777).toBe(0o700);
        expect((await stat(overlay.path)).mode & 0o777).toBe(0o600);
      } finally {
        await overlay.cleanup();
      }
      await expect(access(overlay.path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not start the full runner when Bun imports its helpers', async () => {
    const root = path.resolve('.test-data/full-infra-port-plan');
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, 'import-'));
    try {
      const docker = path.join(directory, 'docker');
      await writeFile(docker, '#!/bin/sh\nprintf invoked > "$0.invoked"\nexit 91\n', { mode: 0o700 });
      const script = path.resolve('scripts/run-integration-full.ts');
      const imported = spawnSync('bun', ['-e', `await import(${JSON.stringify(script)}); console.log('import-only');`], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}` },
      });
      expect(imported.status).toBe(0);
      expect(imported.stdout.trim()).toBe('import-only');
      await expect(access(`${docker}.invoked`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);
});
