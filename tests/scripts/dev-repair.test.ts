import { describe, expect, test } from 'vitest';
import { RepairRecovery, repairViteRuntime, repairOptions, repairDesktopEnv, repairOrigin, repairViteArgs, repairGatewayArgs, repairChange, RepairQueue, assertRepairPortAvailable } from '../../scripts/dev-repair';

describe('dev repair launcher', () => {
  test('preserves Vite dependency cache across fixed-origin service recovery', () => {
    expect(repairViteRuntime).toBe('node');
    expect(repairViteArgs).not.toContain('--force');
    expect(repairViteArgs).toContain('--strictPort');
    expect(repairViteArgs[repairViteArgs.indexOf('--port') + 1]).toBe(new URL(repairOrigin).port);
  });
  test('uses one stable origin and an explicit transport override', () => {
    expect(repairOptions([])).toEqual({ gateway: 'http://127.0.0.1:3000', desktop: false, env: '.env.local', config: undefined, mode: 'local', extra: [] });
    expect(repairOptions(['--desktop', '--gateway', 'http://localhost:3030/'])).toEqual({ gateway: 'http://localhost:3030', desktop: true, env: '.env.local', config: undefined, mode: 'local', extra: [] });
    for (const argv of [['--gateway'], ['--other'], ['--gateway', repairOrigin], ['--gateway', 'http://host/path'], ['--gateway', 'ftp://host']]) {
      expect(() => repairOptions(argv)).toThrow();
    }
  });
  test('isolates desktop session storage from the normal profile', () => {
    const env = repairDesktopEnv({ CSS_BASE_URL: 'https://canonical.example/', XPOD_DESKTOP_USER_DATA_DIR: '/production' }, '/repo');
    expect(env.XPOD_DESKTOP_USER_DATA_DIR).toBe('/repo/.test-data/dev-repair/desktop-profile');
    expect(env.XPOD_DESKTOP_URL).toBe(`${repairOrigin}/ai-connections`);
    expect(env.CSS_BASE_URL).toBe('https://canonical.example/');
  });
});


describe('dev monitor scheduling', () => {
  test('preserves CLI profiles and keeps canonical identity out of transport args', () => {
    const options = repairOptions(['--mode', 'cloud', '--gateway', 'http://localhost:3030', '--', '--seedConfig', 'config/seed.dev.json']);
    expect(options.env).toBe('.env.cloud');
    expect(repairGatewayArgs(options)).toEqual(['--no-env-file', 'src/cli/index.ts', 'start', '--env', '.env.cloud', '--mode', 'cloud', '--seedConfig', 'config/seed.dev.json', '--host', 'localhost', '--port', '3030', '--foreground']);
    expect(() => repairOptions(['--', '--port=1234'])).toThrow();
  });
  test('watches runtime inputs and excludes generated outputs and UI HMR', () => {
    for (const file of ['src/runtime/Proxy.ts', 'config/local.json', 'templates/auth.ejs']) expect(repairChange(file)).toBe('server');
    for (const file of ['packages/solid-sdk/src/index.ts', 'bun.lock', 'patches/auth.patch']) expect(repairChange(file)).toBe('packages');
    expect(repairChange('desktop/src/main.ts')).toBe('desktop');
    for (const file of ['ui/src/main.tsx', 'static/app/main.js', 'packages/solid-sdk/dist/index.js', '.test-data/test.ts', 'desktop/dist/main.js', 'packages/shared-ui/tsconfig.tsbuildinfo']) expect(repairChange(file)).toBeUndefined();
  });
  test('drains edits made during a build without overlapping builds', async () => {
    const calls: string[][] = [];
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const queue = new RepairQueue(async (changes) => { calls.push([...changes]); if (calls.length === 1) await blocked; }, () => {}, 10000);
    queue.mark('server');
    const done = queue.drain();
    queue.mark('packages');
    queue.mark('desktop');
    unblock();
    await done;
    queue.stop();
    expect(calls).toEqual([['server'], ['packages', 'desktop']]);
  });
  test('failed work waits for another edit and retries all failed inputs', async () => {
    const calls: string[][] = [];
    const errors: unknown[] = [];
    const queue = new RepairQueue(async (changes) => { calls.push([...changes]); if (calls.length === 1) throw new Error('bad source'); }, (error) => errors.push(error), 10000);
    queue.mark('packages');
    await queue.drain();
    expect(calls).toHaveLength(1);
    queue.mark('desktop');
    await queue.drain();
    queue.stop();
    expect(calls).toEqual([['packages'], ['packages', 'desktop']]);
    expect(errors).toHaveLength(1);
    queue.mark('server');
    await queue.drain();
    expect(calls).toHaveLength(2);
  });
  test('rejects an occupied real TCP port without disturbing its owner', async () => {
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    try {
      await expect(assertRepairPortAvailable(`http://127.0.0.1:${address.port}`)).rejects.toThrow('Port occupied');
      expect(server.listening).toBe(true);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    await expect(assertRepairPortAvailable(`http://127.0.0.1:${address.port}`)).resolves.toBeUndefined();
  });
});


describe('dev service recovery scheduling', () => {
  test('does not turn a service recovery into a retry of a failed package build', async () => {
    const calls: string[][] = [];
    const queue = new RepairQueue(async (changes) => {
      calls.push([...changes]);
      if (changes.has('packages')) throw new Error('bad source');
    }, () => {}, 10000);
    try {
      queue.mark('packages'); await queue.drain();
      queue.mark('recover-vite'); await queue.drain();
      expect(calls).toEqual([['packages'], ['recover-vite']]);
    } finally { queue.stop(); }
  });

  test('caps retries, coalesces crash notifications and cancels pending recovery on shutdown', async () => {
    let attempts = 0;
    const messages: string[] = [];
    const recovery = new RepairRecovery(() => { attempts++; throw new Error('port occupied'); },
      (message) => messages.push(message), [1, 2]);
    recovery.schedule('vite'); recovery.schedule('vite');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(attempts).toBe(2);
    expect(messages.some((message) => message.includes('exhausted'))).toBe(true);
    recovery.reset('vite'); recovery.schedule('vite'); recovery.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(2);
  });
});
