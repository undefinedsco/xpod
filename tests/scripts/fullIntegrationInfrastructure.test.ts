import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { allocateFullInfrastructure, createFullInfrastructure, composePortsOverride, parseDockerPublishedTcpPorts, readDockerPublishedTcpPorts, hasWritableRedis, hasTcpService, probeMinio, commandExitCode } from '../helpers/fullIntegrationInfrastructure';

const servers: net.Server[] = [];
afterEach(async() => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
describe('owned full integration infrastructure configuration', () => {
  it('settles an S3 request whose peer closes before returning HTTP headers', async() => {
    const server = net.createServer(socket => socket.on('data', () => socket.end()));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Listener not bound');
    expect((await probeMinio(address.port, 50)).ok).toBe(false);
  });
  it('aborts the actual S3 HTTP transport and closes its pending request at the probe deadline', async() => {
    let closed = false; let requests = 0;
    const server = http.createServer(() => {requests++;});
    server.on('connection', socket => socket.once('close', () => {closed = true;}));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Listener not bound');
    expect((await probeMinio(address.port, 50)).ok).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(requests).toBeGreaterThan(0); expect(closed).toBe(true);
  });
  it('settles and tears down its own stalled readonly command', async() => {
    expect(await commandExitCode(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 50)).toBe(1);
  });
  it('reports an unfinished actual Bun run as failure and executes owned cleanup', async() => {
    const helper = path.resolve('tests/helpers/fullIntegrationInfrastructure.ts');
    const source = `import {runIntegrationWithCompletionGuard} from ${JSON.stringify(helper)}; runIntegrationWithCompletionGuard(()=>new Promise(()=>{}),async()=>{console.log("owned-cleanup");}).catch(()=>process.exitCode=1);`;
    const result = await new Promise<{code:number|null;output:string}>(resolve => {
      const child = spawn('bun', ['-e', source], {stdio:['ignore','pipe','pipe']}); let output = '';
      const deadline = setTimeout(() => child.kill('SIGTERM'), 1500);
      child.stdout.on('data', data => {output += String(data);}); child.stderr.on('data', data => {output += String(data);});
      child.once('close', code => {clearTimeout(deadline); resolve({code,output});});
    });
    expect(result.code).toBe(1); expect(result.output).toContain('owned-cleanup'); expect(result.output).toContain('Incomplete run');
  });
  it('settles a Redis readiness FIN without a response instead of abandoning the run', async() => {
    const server = net.createServer(socket => {socket.on('data', () => undefined); socket.end();});
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Listener not bound');
    expect(await hasWritableRedis(address.port, '127.0.0.1', 50)).toBe(false);
    expect(await hasTcpService(address.port, '127.0.0.1', 50)).toBe(true);
  });
  it('settles a silent Redis readiness connection at its total deadline', async() => {
    const server = net.createServer(socket => socket.on('data', () => undefined));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Listener not bound');
    expect(await hasWritableRedis(address.port, '127.0.0.1', 50)).toBe(false);
  });
  it('reserves published TCP host ports and ranges, excluding exposed ports and UDP', () => {
    expect([...parseDockerPublishedTcpPorts('0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp\n127.0.0.1:18000-18002->9000-9002/tcp, 6379/tcp, 0.0.0.0:19000->9000/udp')]).toEqual([5432, 18000, 18001, 18002]);
  });
  it('uses compatible default endpoints and unique owned identity even with the same requested prefix', () => {
    const ports = { postgres: 5432, redis: 6379, objectStore: 9000 };
    const a = createFullInfrastructure(ports, { projectPrefix: 'xpod-full-test', runPrefix: 'same-run' });
    const b = createFullInfrastructure(ports, { projectPrefix: 'xpod-full-test', runPrefix: 'same-run' });
    expect(a.projectName).not.toBe(b.projectName);
    expect(a.runtimeRoot).not.toBe(b.runtimeRoot);
    expect(a.pgUrl).toBe('postgres://xpod:xpod@127.0.0.1:5432/xpod');
    expect(a.redisAddress).toBe('127.0.0.1:6379');
    expect(a.objectStoreEndpoint).toBe('http://127.0.0.1:9000');
    expect(a.testEnv.XPOD_FULL_PG_URL).toBe(a.pgUrl);
    expect(a.testEnv.SOLID_ENV_FILE).toBe(path.join(a.runtimeRoot, 'full.env'));
    expect(a.composeArgs).toContain(a.overridePath);
  });
  it('replaces rather than appends published ports and binds only this run loopback', () => {
    const yaml = composePortsOverride({ postgres: 15432, redis: 16379, objectStore: 19000 });
    expect(yaml.match(/ports: !override/g)).toHaveLength(3);
    expect(yaml).toContain('127.0.0.1:15432:5432');
    expect(yaml).toContain('127.0.0.1:16379:6379');
    expect(yaml).toContain('127.0.0.1:19000:9000');
    expect(yaml).not.toContain('"5432:5432"');
  });
  it('allocates around live listeners and already reserved runtime ports without contacting their services', async() => {
    const occupied: number[] = [];
    for (let index = 0; index < 3; index++) {
      const server = net.createServer(() => { throw new Error('Foreign listener must not receive a readiness request'); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      servers.push(server); const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Listener did not bind');
      occupied.push(address.port);
    }
    const reserved = new Set(occupied.map(port => port + 1));
    const ports = await allocateFullInfrastructure(reserved, { postgres: occupied[0], redis: occupied[1], objectStore: occupied[2] });
    for (const port of Object.values(ports)) {
      expect(occupied).not.toContain(port);
      expect(occupied.map(value => value + 1)).not.toContain(port);
      expect(reserved.has(port)).toBe(true);
    }
    expect(new Set(Object.values(ports)).size).toBe(3);
  });
});
describe('owned bounded Docker inventory lifetime', () => {
  const fakeDockerDirs: string[] = [];
  const originalPath = process.env.PATH;
  const installFakeDocker = (script: string): void => {
    const base = path.resolve('.test-data/full-integration-infra');
    fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, 'case-'));
    fs.writeFileSync(path.join(dir, 'docker'), script, { mode: 0o755 });
    fakeDockerDirs.push(dir);
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ''}`;
  };
  afterEach(() => {
    process.env.PATH = originalPath;
    for (const dir of fakeDockerDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  it('rejects a hung Docker CLI at its trusted deadline instead of blocking the full gate', async() => {
    installFakeDocker('#!/bin/sh\nexec /bin/sleep 30\n');
    const started = Date.now();
    await expect(readDockerPublishedTcpPorts()).rejects.toThrow(/timed out/u);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(4900);
    expect(elapsed).toBeLessThan(10000);
  }, 10000);
  it('rejects a nonzero Docker CLI without accepting empty reservations', async() => {
    installFakeDocker('#!/bin/sh\nprintf "0.0.0.0:5432->5432/tcp\\n"\nexit 3\n');
    await expect(readDockerPublishedTcpPorts()).rejects.toThrow(/Unable to read/u);
  }, 10000);
  it('does not settle on a stdout FIN while the Docker process is still alive', async() => {
    installFakeDocker('#!/bin/sh\nprintf "0.0.0.0:5432->5432/tcp\\n"\nexec 1>&-\nexec /bin/sleep 30\n');
    await expect(readDockerPublishedTcpPorts()).rejects.toThrow(/timed out/u);
  }, 10000);
  it('escalates to SIGKILL for a Docker CLI that ignores SIGTERM', async() => {
    installFakeDocker('#!/bin/sh\ntrap "" TERM\nexec /bin/sleep 30\n');
    const started = Date.now();
    await expect(readDockerPublishedTcpPorts()).rejects.toThrow(/timed out/u);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(5400);
    expect(elapsed).toBeLessThan(10000);
  }, 10000);
  it('rejects before decoding or retaining stdout beyond the one mebibyte cap', async() => {
    installFakeDocker('#!/bin/sh\nhead -c 2000000 /dev/zero | tr "\\0" "a"\n');
    await expect(readDockerPublishedTcpPorts()).rejects.toThrow(/byte limit/u);
  }, 10000);
  it('rejects when the leader exits but a descendant keeps our stdout pipe open', async() => {
    installFakeDocker('#!/bin/sh\ntrap "exit 0" TERM\n/bin/sleep 6 &\nwait\n');
    const started = Date.now();
    await expect(readDockerPublishedTcpPorts()).rejects.toThrow(/timed out/u);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(4900);
    expect(elapsed).toBeLessThan(10000);
  }, 10000);
  it('rejects a nonzero reaped leader whose descendant keeps our stdout pipe open, without waiting for close', async() => {
    const base = path.resolve('.test-data/full-integration-infra');
    fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, 'case-'));
    const pidFile = path.join(dir, 'descendant.pid');
    // The leader exits 3 immediately; the backgrounded sleep inherits the stdout pipe and holds it open,
    // so `close` is delayed. The direct child is already reaped and its code is known.
    fs.writeFileSync(path.join(dir, 'docker'),
      `#!/bin/sh\n/bin/sleep 60 &\necho $! > "${pidFile}"\nprintf "0.0.0.0:5432->5432/tcp\\n"\nexit 3\n`, { mode: 0o755 });
    fakeDockerDirs.push(dir);
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ''}`;
    try {
      const started = Date.now();
      await expect(readDockerPublishedTcpPorts()).rejects.toThrow(/Unable to read/u);
      // A known nonzero exit must settle promptly, not after the 5000ms inventory deadline.
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      // Safe cleanup of ONLY this fixture's backgrounded descendant (never a foreign process).
      for (let attempt = 0; attempt < 50 && !fs.existsSync(pidFile); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* descendant already gone */ } }
      }
    }
  }, 10000);
});
