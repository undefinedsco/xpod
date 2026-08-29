import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  RuntimeManager,
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
    })).toEqual({ command: '/opt/xpod/bin/xpod', args: ['start', '--foreground'] });
  });

  it('uses a packaged runtime before falling back to PATH', () => {
    expect(resolveRuntimeLaunchCommand({
      env: {},
      resourcesPath: '/Applications/Xpod.app/Contents/Resources',
      pathExists: (value) => value === '/Applications/Xpod.app/Contents/Resources/runtime/xpod',
      execPath: '/Applications/Xpod.app/Contents/MacOS/Xpod',
    })).toEqual({
      command: '/Applications/Xpod.app/Contents/Resources/runtime/xpod',
      args: ['start', '--foreground'],
    });
  });

  it('runs packaged JS CLI with bundled Bun when the single runtime binary is absent', () => {
    expect(resolveRuntimeLaunchCommand({
      env: {},
      resourcesPath: '/Applications/Xpod.app/Contents/Resources',
      pathExists: (value) =>
        value === '/Applications/Xpod.app/Contents/Resources/runtime/bin/xpod.js' ||
        value === '/Applications/Xpod.app/Contents/Resources/runtime/bin/bun',
      execPath: '/Applications/Xpod.app/Contents/MacOS/Xpod',
      resolveBunCommand: () => '/usr/local/bin/bun',
    })).toEqual({
      command: '/Applications/Xpod.app/Contents/Resources/runtime/bin/bun',
      args: ['/Applications/Xpod.app/Contents/Resources/runtime/bin/xpod.js', 'start', '--foreground'],
    });
  });

  it('runs packaged JS CLI with system Bun before using Electron as Node', () => {
    expect(resolveRuntimeLaunchCommand({
      env: {},
      resourcesPath: '/Applications/Xpod.app/Contents/Resources',
      pathExists: (value) => value === '/Applications/Xpod.app/Contents/Resources/runtime/bin/xpod.js',
      execPath: '/Applications/Xpod.app/Contents/MacOS/Xpod',
      resolveBunCommand: () => '/usr/local/bin/bun',
    })).toEqual({
      command: '/usr/local/bin/bun',
      args: ['/Applications/Xpod.app/Contents/Resources/runtime/bin/xpod.js', 'start', '--foreground'],
    });
  });

  it('keeps Electron-as-Node only as the packaged JS CLI fallback when Bun is absent', () => {
    expect(resolveRuntimeLaunchCommand({
      env: {},
      resourcesPath: '/Applications/Xpod.app/Contents/Resources',
      pathExists: (value) => value === '/Applications/Xpod.app/Contents/Resources/runtime/bin/xpod.js',
      execPath: '/Applications/Xpod.app/Contents/MacOS/Xpod',
      resolveBunCommand: () => undefined,
    })).toEqual({
      command: '/Applications/Xpod.app/Contents/MacOS/Xpod',
      args: ['/Applications/Xpod.app/Contents/Resources/runtime/bin/xpod.js', 'start', '--foreground'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('uses the local desktop runtime for unpackaged development launches before falling back to PATH', () => {
    expect(resolveRuntimeLaunchCommand({
      env: {},
      resourcesPath: '/Electron.app/Contents/Resources',
      moduleDir: '/Users/ganlu/develop/xpod/desktop/dist',
      pathExists: (value) => value === '/Users/ganlu/develop/xpod/desktop/runtime/xpod',
    })).toEqual({
      command: '/Users/ganlu/develop/xpod/desktop/runtime/xpod',
      args: ['start', '--foreground'],
    });
  });

  it('keeps PATH fallback only after packaged and local runtimes are unavailable', () => {
    expect(resolveRuntimeLaunchCommand({
      env: {},
      resourcesPath: '/Electron.app/Contents/Resources',
      moduleDir: '/Users/ganlu/develop/xpod/desktop/dist',
      pathExists: () => false,
    })).toEqual({ command: 'xpod', args: ['start', '--foreground'] });
  });
});
