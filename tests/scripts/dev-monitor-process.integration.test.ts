import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer, request } from 'node:http';
import { describe, expect, test } from 'vitest';
import { RepairChildren, RepairRecovery, waitForRepairReady, assertRepairPortAvailable } from '../../scripts/dev-repair';

// Real Bun child processes and OS signals; this checks monitor ownership, not Xpod login.
describe('dev monitor process ownership', () => {
  test('terminates its Bun process group including descendants', async () => {
    await mkdir('.test-data/dev-monitor', { recursive: true });
    const directory = await mkdtemp(path.resolve('.test-data/dev-monitor/process-'));
    const pidFile = path.join(directory, 'pids.json');
    const unexpected: Error[] = [];
    const children = new RepairChildren((error) => unexpected.push(error));
    const code = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    `;
    const child = children.launch('bun', ['-e', code, pidFile], process.cwd(), process.env, true);
    try {
      let pids: number[] = [];
      for (let attempt = 0; attempt < 500; attempt++) {
        try { pids = JSON.parse(await readFile(pidFile, 'utf8')); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
      }
      expect(pids).toHaveLength(2);
      for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();
      await children.stop(child);
      for (const pid of pids) {
        for (let attempt = 0; attempt < 500; attempt++) {
          try { process.kill(pid, 0); } catch { break; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(() => process.kill(pid, 0)).toThrow();
      }
      expect(unexpected).toEqual([]);
    } finally { await children.stopAll(); await rm(directory, { recursive: true, force: true }); }
  }, 15000);

  test('rejects a real Bun wildcard listener before binding a specific address', async () => {
    await mkdir('.test-data/dev-monitor', { recursive: true });
    const directory = await mkdtemp(path.resolve('.test-data/dev-monitor/port-'));
    const portFile = path.join(directory, 'port');
    const children = new RepairChildren(() => {});
    children.launch('bun', ['-e', `
      const server = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: () => new Response('owned') });
      require('node:fs').writeFileSync(process.argv[1], String(server.port));
    `, portFile], process.cwd());
    try {
      let port = 0;
      for (let attempt = 0; attempt < 500; attempt++) {
        try { port = Number(await readFile(portFile, 'utf8')); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
      }
      expect(port).toBeGreaterThan(0);
      await expect(assertRepairPortAvailable(`http://127.0.0.1:${port}`)).rejects.toThrow('Port occupied');
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('owned');
    } finally { await children.stopAll(); await rm(directory, { recursive: true, force: true }); }
  });

  test('reports a real failed build exit without terminating another owned process', async () => {
    const children = new RepairChildren(() => {});
    const service = children.launch('bun', ['-e', 'setInterval(() => {}, 1000)'], process.cwd());
    try {
      const build = children.launch('bun', ['-e', 'process.exit(2)'], process.cwd());
      await expect(children.completed(build)).rejects.toThrow('exited (2)');
      expect(() => process.kill(service.pid!, 0)).not.toThrow();
    } finally { await children.stopAll(); }
  });
});


describe('dev monitor recovery', () => {
  test('restarts only a failed owned service without an edit or a build', async () => {
    const children = new RepairChildren(() => {});
    let failed = children.launch('bun', ['-e', 'setInterval(() => {}, 1000)'], process.cwd());
    const healthy = children.launch('bun', ['-e', 'setInterval(() => {}, 1000)'], process.cwd());
    let launches = 0;
    const recovery = new RepairRecovery(async () => {
      await children.stop(failed);
      failed = children.launch('bun', ['-e', 'setInterval(() => {}, 1000)'], process.cwd());
      launches++;
    }, () => {}, [20, 40]);
    const original = failed.pid;
    failed.once('exit', () => recovery.schedule('vite'));
    try {
      failed.kill('SIGKILL');
      for (let attempt = 0; attempt < 500 && !launches; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(launches).toBe(1);
      expect(failed.pid).not.toBe(original);
      expect(() => process.kill(healthy.pid!, 0)).not.toThrow();
      expect(() => process.kill(failed.pid!, 0)).not.toThrow();
    } finally { recovery.stop(); await children.stopAll(); }
  });

  test('reports a service crash once, including zero exit codes', async () => {
    const errors: Error[] = [];
    const children = new RepairChildren((error) => errors.push(error));
    try {
      const failed = children.launch('bun', ['-e', 'process.exit(2)'], process.cwd(), process.env, true);
      await expect(children.completed(failed)).rejects.toThrow();
      expect(errors).toHaveLength(1);
      const clean = children.launch('bun', ['-e', 'process.exit(0)'], process.cwd(), process.env, true);
      await children.completed(clean);
      expect(errors).toHaveLength(2);
    } finally { await children.stopAll(); }
  });

  test('does not accept a foreign HTTP response when its own process fails to bind', async () => {
    const foreign = createServer((_req, response) => response.end('already running'));
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    const port = (foreign.address() as { port: number }).port;
    const children = new RepairChildren(() => {});
    let listening = false;
    const child = children.launch('node', ['-e', `
      const server = require('node:http').createServer();
      server.on('error', () => process.exit(1));
      server.listen(${port}, '127.0.0.1', () => console.log('owned listener ready'));
    `], process.cwd(), process.env, false, () => { listening = true; });
    try {
      await expect(waitForRepairReady(async () => {
        expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(200);
        if (!listening) throw new Error('Owned listener not ready');
      }, 'Vite', () => child.exitCode !== null || child.signalCode !== null))
        .rejects.toThrow('exited before readiness');
      expect(foreign.listening).toBe(true);
    } finally {
      await children.stopAll();
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  });
});


test('Node Vite survives a rejected real WebSocket upgrade', async () => {
  await mkdir('.test-data/dev-monitor', { recursive: true });
  const directory = await mkdtemp(path.resolve('.test-data/dev-monitor/vite-'));
  const portFile = path.join(directory, 'port');
  const uiRequire = createRequire(path.resolve('ui/package.json'));
  const viteEntry = path.join(path.dirname(uiRequire.resolve('vite/package.json')), 'dist/node/index.js');
  const children = new RepairChildren(() => {});
  const child = children.launch('node', ['--input-type=module', '-e', `
    import { createServer } from ${JSON.stringify(viteEntry)};
    import { createServer as httpServer } from 'node:http';
    import { writeFileSync } from 'node:fs';
    const upstream = httpServer();
    upstream.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n'));
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const probe = httpServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const vite = await createServer({ configFile: false, root: process.argv[1],
      server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/socket': { target: 'http://127.0.0.1:' + upstream.address().port, ws: true } } } });
    await vite.listen();
    writeFileSync(process.argv[2], String(vite.httpServer.address().port));
  `, directory, portFile], process.cwd());
  try {
    let port = 0;
    for (let attempt = 0; attempt < 500; attempt++) {
      try { port = Number(await readFile(portFile, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    expect(port).toBeGreaterThan(0);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${port}/socket`, {
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
      }, (response) => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('upgrade timed out'))); req.end();
    });
    expect(status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/@vite/client`)).status).toBe(200);
    expect(child.exitCode).toBeNull();
  } finally { await children.stopAll(); await rm(directory, { recursive: true, force: true }); }
}, 20000);
