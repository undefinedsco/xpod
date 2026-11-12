import { describe, expect, it, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  RuntimeManager,
  packagedModuleEnvironment,
  resolveRuntimeLaunchCommand,
  type RuntimeChild,
} from '../src/runtime-manager';

class FakeChild extends EventEmitter implements RuntimeChild {
  readonly pid = 1234;
  killed = false;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.emit('exit', signal === 'SIGKILL' ? 1 : 0, signal ?? null);
    return true;
  }
}

describe('RuntimeManager', () => {
  it('reuses a reachable externally managed runtime without spawning', async () => {
    let spawns = 0;
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/service/status')) {
          return Response.json([
            { name: 'css', status: 'running' },
            { name: 'api', status: 'running' },
          ]);
        }
        return new Response('', { status: 200 });
      },
      resolveLaunch: () => ({ command: 'xpod', args: ['start'] }),
      spawnImpl: () => { spawns += 1; return new FakeChild(); },
    });

    await manager.ensureRunning();

    expect(manager.snapshot()).toMatchObject({ state: 'running', ownership: 'external' });
    expect(spawns).toBe(0);
  });

  it('reports gateway reachability without spawning a runtime', async () => {
    let spawns = 0;
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/service/status')) {
          return Response.json([
            { name: 'css', status: 'running' },
            { name: 'api', status: 'running' },
          ]);
        }
        return new Response('', { status: 200 });
      },
      resolveLaunch: () => ({ command: 'xpod', args: ['start'] }),
      spawnImpl: () => { spawns += 1; return new FakeChild(); },
    });

    expect(await manager.isReachable()).toBe(true);
    expect(spawns).toBe(0);
    expect(manager.snapshot()).toMatchObject({ state: 'stopped', ownership: 'none' });
  });

  it('waits for a runtime that is already starting instead of launching a competing one', async () => {
    let probes = 0;
    let spawns = 0;
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/service/status')) {
          probes += 1;
          return probes >= 3
            ? Response.json([
              { name: 'css', status: 'running' },
              { name: 'api', status: 'running' },
            ])
            : new Response('[]', { status: 503 });
        }
        return new Response('', { status: 200 });
      },
      resolveLaunch: () => ({ command: 'xpod', args: ['start'] }),
      spawnImpl: () => { spawns += 1; return new FakeChild(); },
      pollIntervalMs: 0,
      startupTimeoutMs: 50,
    });

    expect(await manager.waitUntilReachable(500)).toBe(true);
    expect(spawns).toBe(0);
  });

  it('gives up waiting for an unreachable gateway without spawning', async () => {
    let spawns = 0;
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000',
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
      resolveLaunch: () => ({ command: 'xpod', args: ['start'] }),
      spawnImpl: () => { spawns += 1; return new FakeChild(); },
      pollIntervalMs: 0,
      startupTimeoutMs: 10,
    });

    expect(await manager.waitUntilReachable(30)).toBe(false);
    expect(spawns).toBe(0);
  });

  it('starts one owned runtime and reaches running state after readiness succeeds', async () => {
    let probes = 0;
    let spawns = 0;
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/service/status')) {
          probes += 1;
          return probes >= 2
            ? Response.json([
              { name: 'css', status: 'running' },
              { name: 'api', status: 'running' },
            ])
            : new Response('[]', { status: 503 });
        }
        return new Response('', { status: 200 });
      },
      resolveLaunch: () => ({ command: 'xpod', args: ['start'] }),
      spawnImpl: () => { spawns += 1; return new FakeChild(); },
      pollIntervalMs: 0,
      startupTimeoutMs: 50,
    });

    await manager.ensureRunning();
    await manager.ensureRunning();

    expect(manager.snapshot()).toMatchObject({ state: 'running', ownership: 'desktop', pid: 1234 });
    expect(spawns).toBe(1);
  });

  it('does not declare readiness while the product shell route still returns a gateway error', async () => {
    let shellProbes = 0;
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/service/status')) {
          return Response.json([
            { name: 'css', status: 'running' },
            { name: 'api', status: 'running' },
          ]);
        }
        if (url.endsWith('/status/overview')) {
          shellProbes += 1;
          return new Response('', { status: shellProbes >= 2 ? 200 : 502 });
        }
        return new Response('', { status: 200 });
      },
      resolveLaunch: () => ({ command: 'xpod', args: ['start'] }),
      spawnImpl: () => new FakeChild(),
      pollIntervalMs: 0,
      startupTimeoutMs: 50,
    });

    await manager.ensureRunning();

    expect(shellProbes).toBeGreaterThanOrEqual(2);
    expect(manager.snapshot()).toMatchObject({ state: 'running', ownership: 'desktop' });
  });

  it('does not reuse a runtime when service status reports css or api unhealthy', async () => {
    let spawns = 0;
    const requestedPaths: string[] = [];
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000',
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        requestedPaths.push(url.pathname);
        if (url.pathname === '/service/status') {
          return Response.json([
            { name: 'css', status: 'crashed' },
            { name: 'api', status: 'running' },
          ]);
        }
        if (url.pathname === '/status/overview') return new Response('', { status: 200 });
        if (url.pathname === '/.account/') return new Response('', { status: 200 });
        return new Response('', { status: 404 });
      },
      resolveLaunch: () => ({ command: 'xpod', args: ['start'] }),
      spawnImpl: () => {
        spawns += 1;
        return new FakeChild();
      },
      pollIntervalMs: 0,
      startupTimeoutMs: 10,
    });

    await expect(manager.ensureRunning()).rejects.toThrow('Xpod runtime did not become ready');

    expect(spawns).toBe(1);
    expect(requestedPaths).toContain('/service/status');
    expect(manager.snapshot()).toMatchObject({ state: 'failed', ownership: 'desktop' });
  });

  it('does not reuse a runtime when the same-origin account route is unavailable', async () => {
    let spawns = 0;
    const requestedPaths: string[] = [];
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000',
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        requestedPaths.push(url.pathname);
        if (url.pathname === '/service/status') {
          return Response.json([
            { name: 'css', status: 'running' },
            { name: 'api', status: 'running' },
          ]);
        }
        if (url.pathname === '/status/overview') return new Response('', { status: 200 });
        if (url.pathname === '/.account/') return new Response('', { status: 502 });
        return new Response('', { status: 404 });
      },
      resolveLaunch: () => ({ command: 'xpod', args: ['start'] }),
      spawnImpl: () => {
        spawns += 1;
        return new FakeChild();
      },
      pollIntervalMs: 0,
      startupTimeoutMs: 10,
    });

    await expect(manager.ensureRunning()).rejects.toThrow('Xpod runtime did not become ready');

    expect(spawns).toBe(1);
    expect(requestedPaths).toContain('/.account/');
    expect(manager.snapshot()).toMatchObject({ state: 'failed', ownership: 'desktop' });
  });

  it('pins the child runtime base URL and port to the desktop target', async () => {
    let childEnv: NodeJS.ProcessEnv | undefined;
    let probes = 0;
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:4188',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/service/status')) {
          probes += 1;
          return probes >= 2
            ? Response.json([
              { name: 'css', status: 'running' },
              { name: 'api', status: 'running' },
            ])
            : new Response('[]', { status: 503 });
        }
        return new Response('', { status: 200 });
      },
      resolveLaunch: () => ({
        command: 'xpod',
        args: ['start'],
        env: { CSS_BASE_URL: 'http://stale.example/', XPOD_PORT: '9999' },
      }),
      spawnImpl: (_command, _args, options) => {
        childEnv = options.env;
        return new FakeChild();
      },
      pollIntervalMs: 0,
      startupTimeoutMs: 50,
    });

    await manager.ensureRunning();

    expect(childEnv?.CSS_BASE_URL).toBe('http://127.0.0.1:4188/');
    expect(childEnv?.XPOD_PORT).toBe('4188');
  });

  it('reports an actionable failure when no runtime command is available', async () => {
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000',
      fetchImpl: async () => new Response('', { status: 503 }),
      resolveLaunch: () => undefined,
      spawnImpl: () => new FakeChild(),
    });

    await expect(manager.ensureRunning()).rejects.toThrow('Xpod runtime is not installed');
    expect(manager.snapshot()).toMatchObject({ state: 'failed', ownership: 'none' });
  });

  it('fails immediately when the runtime process cannot be spawned', async () => {
    const child = new FakeChild();
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000',
      fetchImpl: async () => new Response('', { status: 503 }),
      resolveLaunch: () => ({ command: 'missing-xpod', args: ['start'] }),
      spawnImpl: () => {
        queueMicrotask(() => child.emit('error', new Error('spawn missing-xpod ENOENT')));
        return child;
      },
      startupTimeoutMs: 10_000,
    });

    await expect(manager.ensureRunning()).rejects.toThrow('spawn missing-xpod ENOENT');
    expect(manager.snapshot()).toMatchObject({ state: 'failed' });
  });

  it('stops only the child process owned by the desktop shell', async () => {
    let ready = false;
    const child = new FakeChild();
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/service/status')) {
          return ready
            ? Response.json([
              { name: 'css', status: 'running' },
              { name: 'api', status: 'running' },
            ])
            : new Response('[]', { status: 503 });
        }
        return new Response('', { status: 200 });
      },
      resolveLaunch: () => ({ command: 'xpod', args: ['start'] }),
      spawnImpl: () => { ready = true; return child; },
      pollIntervalMs: 0,
      startupTimeoutMs: 50,
    });

    await manager.ensureRunning();
    await manager.stopOwned();

    expect(child.killed).toBe(true);
    expect(manager.snapshot()).toMatchObject({ state: 'stopped', ownership: 'none' });
  });
});

describe('resolveRuntimeLaunchCommand', () => {
  it('prefers an explicit runtime command', () => {
    expect(resolveRuntimeLaunchCommand({
      env: { XPOD_RUNTIME_COMMAND: '/opt/xpod/bin/xpod' },
      resourcesPath: '/Applications/Xpod.app/Contents/Resources',
      pathExists: () => false,
    })).toEqual({ command: '/opt/xpod/bin/xpod', args: ['start'] });
  });

  it('uses a packaged runtime before falling back to PATH', () => {
    expect(resolveRuntimeLaunchCommand({
      env: {},
      resourcesPath: '/Applications/Xpod.app/Contents/Resources',
      pathExists: (value) => [
        '/Applications/Xpod.app/Contents/Resources/runtime/xpod',
        '/Applications/Xpod.app/Contents/Resources/runtime/qlever/bin/xpod_qlever_local_runtime',
      ].includes(value),
      execPath: '/Applications/Xpod.app/Contents/MacOS/Xpod',
    })).toEqual({
      command: '/Applications/Xpod.app/Contents/Resources/runtime/xpod',
      args: ['start'],
      env: {
        XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: '/Applications/Xpod.app/Contents/Resources/runtime/qlever/bin/xpod_qlever_local_runtime',
      },
    });
  });

  it('does not start an incomplete packaged runtime without QLever', () => {
    expect(resolveRuntimeLaunchCommand({
      env: {},
      resourcesPath: '/Applications/Xpod.app/Contents/Resources',
      pathExists: (value) => value === '/Applications/Xpod.app/Contents/Resources/runtime/xpod',
      execPath: '/Applications/Xpod.app/Contents/MacOS/Xpod',
    })).toBeUndefined();
  });

  it('runs packaged JS CLI with bundled Bun when the single runtime binary is absent', () => {
    expect(resolveRuntimeLaunchCommand({
      env: {},
      resourcesPath: '/Applications/Xpod.app/Contents/Resources',
      pathExists: (value) =>
        value === '/Applications/Xpod.app/Contents/Resources/runtime/node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs' ||
        value === '/Applications/Xpod.app/Contents/Resources/runtime/bin/bun',
      execPath: '/Applications/Xpod.app/Contents/MacOS/Xpod',
      resolveBunCommand: () => '/usr/local/bin/bun',
    })).toEqual({
      command: '/Applications/Xpod.app/Contents/Resources/runtime/bin/bun',
      args: ['/Applications/Xpod.app/Contents/Resources/runtime/node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs', 'start'],
    });
  });

  it('runs packaged JS CLI with system Bun before using Electron as Node', () => {
    expect(resolveRuntimeLaunchCommand({
      env: {},
      resourcesPath: '/Applications/Xpod.app/Contents/Resources',
      pathExists: (value) => value === '/Applications/Xpod.app/Contents/Resources/runtime/node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs',
      execPath: '/Applications/Xpod.app/Contents/MacOS/Xpod',
      resolveBunCommand: () => '/usr/local/bin/bun',
    })).toEqual({
      command: '/usr/local/bin/bun',
      args: ['/Applications/Xpod.app/Contents/Resources/runtime/node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs', 'start'],
    });
  });

  it('unpackaged use preserves the normal CLI launcher Node/Bun contract', () => {
    const root = '/development/runtime/node_modules/@undefineds.co/xpod-cli/dist';
    expect(resolveRuntimeLaunchCommand({ env: {}, resourcesPath: '/development',
      pathExists: value => value === `${root}/xpod.mjs` || value === `${root}/bin/xpod`,
      resolveBunCommand: () => undefined,
    })).toEqual({ command: `${root}/bin/xpod`, args: ['start'] });
  });

  it('packaged apps require their own Bun even when a system Bun exists', () => {
    expect(resolveRuntimeLaunchCommand({ env: {}, packaged: true,
      resourcesPath: '/Applications/Xpod.app/Contents/Resources',
      pathExists: value => value.endsWith('/dist/xpod.mjs'),
      resolveBunCommand: () => '/usr/local/bin/bun',
    })).toBeUndefined();
  });

  it('rejects the packaged CLI when Bun is absent instead of using incompatible Electron Node', () => {
    expect(resolveRuntimeLaunchCommand({
      env: {},
      resourcesPath: '/Applications/Xpod.app/Contents/Resources',
      pathExists: (value) => value === '/Applications/Xpod.app/Contents/Resources/runtime/node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs',
      execPath: '/Applications/Xpod.app/Contents/MacOS/Xpod',
      resolveBunCommand: () => undefined,
    })).toBeUndefined();
  });

  it('uses the local desktop runtime for unpackaged development launches before falling back to PATH', () => {
    expect(resolveRuntimeLaunchCommand({
      env: {},
      resourcesPath: '/Electron.app/Contents/Resources',
      moduleDir: '/Users/ganlu/develop/xpod/desktop/dist',
      pathExists: (value) => value === '/Users/ganlu/develop/xpod/desktop/runtime/xpod',
    })).toEqual({
      command: '/Users/ganlu/develop/xpod/desktop/runtime/xpod',
      args: ['start'],
    });
  });

  it('rejects a missing packaged CLI instead of using PATH', () => {
    expect(resolveRuntimeLaunchCommand({ env: {}, packaged: true,
      resourcesPath: '/Applications/Xpod.app/Contents/Resources',
      pathExists: value => value.endsWith('/runtime/xpod'),
    })).toBeUndefined();
  });

  it('keeps PATH fallback only after packaged and local runtimes are unavailable', () => {
    expect(resolveRuntimeLaunchCommand({
      env: {},
      resourcesPath: '/Electron.app/Contents/Resources',
      moduleDir: '/Users/ganlu/develop/xpod/desktop/dist',
      pathExists: () => false,
    })).toEqual({ command: 'xpod', args: ['start'] });
  });
});

describe('owned runtime recovery', () => {
  function fixture(autoRestart: boolean) {
    const children: FakeChild[] = [];
    const environments: NodeJS.ProcessEnv[] = [];
    let ready = false;
    let directory = '/old/data';
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000', autoRestart, restartDelayMs: 1,
      resolveLaunch: () => ({ command: 'xpod', args: ['start'], env: { CSS_ROOT_FILE_PATH: '/stale/data' } }),
      resolveEnvironment: () => ({ CSS_ROOT_FILE_PATH: directory }),
      fetchImpl: async (input) => String(input).endsWith('/service/status')
        ? Response.json(ready ? [{ name: 'css', status: 'running' }, { name: 'api', status: 'running' }] : []) : new Response(''),
      spawnImpl: (_command, _args, options) => {
        environments.push(options.env);
        const child = new FakeChild(); children.push(child); ready = true;
        child.once('exit', () => { ready = false; });
        return child;
      }, pollIntervalMs: 1, startupTimeoutMs: 100,
    });
    return { manager, children, environments, setDirectory: (value: string) => { directory = value; } };
  }
  test('recovers an unexpectedly exited owned process, then respects manual stop', async () => {
    const { manager, children } = fixture(true);
    await manager.ensureRunning(); children[0]!.emit('exit', 1, null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(children).toHaveLength(2);
    expect(manager.snapshot().state).toBe('running');
    await manager.stopOwned();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(children).toHaveLength(2); expect(manager.snapshot().state).toBe('stopped');
  });
  test('disabled policy and stop during restart delay do not relaunch', async () => {
    const disabled = fixture(false);
    await disabled.manager.ensureRunning(); disabled.children[0]!.emit('exit', 1, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disabled.children).toHaveLength(1);
    const stopped = fixture(true);
    await stopped.manager.ensureRunning(); stopped.children[0]!.emit('exit', 1, null);
    await stopped.manager.stopOwned();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped.children).toHaveLength(1);
  });
  test('restart uses freshly saved data directory instead of old launch environment', async () => {
    const { manager, environments, setDirectory } = fixture(false);
    await manager.ensureRunning(); setDirectory('/new/data'); await manager.restart();
    expect(environments.map((env) => env.CSS_ROOT_FILE_PATH)).toEqual(['/old/data', '/new/data']);
    await manager.stopOwned();
  });
});

  it('passes the owned module root and read-only seed to a packaged runtime', async () => {
    // The installed bundle must stay immutable: the mutable store lives under the
    // OWNED userData root, and the bundle only supplies a read-only seed.
    let captured: NodeJS.ProcessEnv | undefined;
    let probes = 0;
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000',
      packaged: true,
      resourcesPath: '/bundle/Resources',
      ownedDataRoot: '/owned/userData',
      // Report unreachable FIRST so a real spawn happens (that is what this test
      // inspects), then become ready so the launch resolves promptly.
      fetchImpl: async (input) => {
        if (!String(input).endsWith('/service/status')) return new Response('', { status: 200 });
        probes += 1;
        return probes === 1
          ? new Response('', { status: 503 })
          : Response.json([{ name: 'css', status: 'running' }, { name: 'api', status: 'running' }]);
      },
      resolveLaunch: () => ({ command: '/bundle/Resources/runtime/bin/bun', args: ['/bundle/Resources/xpod.mjs', 'start'] }),
      spawnImpl: (_command, _args, options) => { captured = options.env; return new FakeChild(); },
    });
    await manager.ensureRunning().catch(() => undefined);
    expect(captured?.XPOD_MODULES_ROOT).toBe(path.join('/owned/userData', 'modules'));
    expect(captured?.XPOD_MODULES_SEED).toBe(path.join('/bundle/Resources', 'runtime', 'modules'));
    expect(captured?.XPOD_MODULES_OFFLINE).toBe('1');
    // The mutable root must not sit inside the bundle.
    expect(String(captured?.XPOD_MODULES_ROOT).startsWith('/bundle/')).toBe(false);
  });

  it('stays testable when process.resourcesPath is unavailable', async () => {
    // Node test processes have no Electron resourcesPath; construction must not
    // throw and an unpackaged manager must not inject module variables.
    let captured: NodeJS.ProcessEnv | undefined;
    const manager = new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000',
      fetchImpl: async (input) => String(input).endsWith('/service/status')
        ? Response.json([{ name: 'css', status: 'running' }, { name: 'api', status: 'running' }])
        : new Response('', { status: 200 }),
      resolveLaunch: () => ({ command: 'xpod', args: ['start'] }),
      spawnImpl: (_command, _args, options) => { captured = options.env; return new FakeChild(); },
    });
    await manager.ensureRunning().catch(() => undefined);
    expect(captured?.XPOD_MODULES_ROOT).toBeUndefined();
    expect(captured?.XPOD_MODULES_SEED).toBeUndefined();
  });


describe('RuntimeManager packaged module context', () => {
  const packagedManager = (options: Record<string, unknown>, onSpawn: (args: unknown[]) => void) =>
    new RuntimeManager({
      targetOrigin: 'http://127.0.0.1:3000',
      packaged: true,
      resolveLaunch: () => ({ command: '/bundle/runtime/bin/bun', args: ['/bundle/dist/xpod.mjs', 'start'] }),
      fetchImpl: async () => { throw new Error('no gateway'); },
      spawnImpl: (...args: unknown[]) => { onSpawn(args); return new FakeChild(); },
      ...options,
    } as never);

  it('passes the OWNED root and the READ-ONLY seed to the packaged child', async () => {
    // Capture the child environment from the spawn call itself: the module
    // context is decided before the child is created, so no gateway handshake is
    // needed (a fake child never becomes ready, which would otherwise time out).
    const env = packagedModuleEnvironment({
      packaged: true,
      ownedDataRoot: '/Users/someone/Library/Application Support/Xpod',
      resourcesPath: '/Applications/Xpod.app/Contents/Resources',
    });
    expect(env.XPOD_MODULES_ROOT).toBe('/Users/someone/Library/Application Support/Xpod/modules');
    expect(env.XPOD_MODULES_SEED).toBe('/Applications/Xpod.app/Contents/Resources/runtime/modules');
    expect(env.XPOD_MODULES_OFFLINE).toBe('1');
  });

  it('refuses to spawn a packaged runtime without an owned data root', async () => {
    let spawns = 0;
    const previous = process.env.XPOD_DESKTOP_USER_DATA_DIR;
    delete process.env.XPOD_DESKTOP_USER_DATA_DIR;
    try {
      const manager = packagedManager({ resourcesPath: '/Applications/Xpod.app/Contents/Resources' },
        () => { spawns += 1; });
      await expect(manager.ensureRunning()).rejects.toThrow(/userData/);
      expect(spawns).toBe(0);
    } finally {
      if (previous !== undefined) process.env.XPOD_DESKTOP_USER_DATA_DIR = previous;
    }
  });

  it('refuses to spawn a packaged runtime without a bundle resources root', async () => {
    let spawns = 0;
    const previous = process.env.XPOD_DESKTOP_USER_DATA_DIR;
    delete process.env.XPOD_DESKTOP_USER_DATA_DIR;
    try {
      const manager = new RuntimeManager({
        targetOrigin: 'http://127.0.0.1:3000',
        packaged: true,
        resolveLaunch: () => ({ command: '/bundle/runtime/bin/bun', args: ['start'] }),
        fetchImpl: async () => { throw new Error('no gateway'); },
        spawnImpl: () => { spawns += 1; return new FakeChild(); },
        ownedDataRoot: '/tmp/xpod-owned',
      } as never);
      await expect(manager.ensureRunning()).rejects.toThrow(/resources/);
      expect(spawns).toBe(0);
    } finally {
      if (previous !== undefined) process.env.XPOD_DESKTOP_USER_DATA_DIR = previous;
    }
  });

  it('an unpackaged developer launch is unaffected by the packaged module context', () => {
    expect(packagedModuleEnvironment({ packaged: false })).toEqual({});
  });
});
