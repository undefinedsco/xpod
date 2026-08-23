import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { registerSettingsRoutes } from '../../src/api/handlers/SettingsHandler';
import { OpenAuthMiddleware } from '../../src/api/middleware/OpenAuthMiddleware';
import { startXpodRuntime, type XpodRuntimeHandle } from '../../src/runtime/XpodRuntime';
import type { ApiRuntimeRunner, CssRuntimeRunner } from '../../src/runtime/runner/types';
import { resolveTestRuntimeTransport } from '../helpers/runtimeTransport';
import { createTestDir } from '../utils/sqlite';

const root = path.resolve(__dirname, '../..');
const openSettingsScript = path.join(root, 'scripts/open-settings.mjs');
const settingsUrlToStaticPath = (urlPath: string): string => path.join(root, 'static/settings', urlPath.replace(/^\/settings\//, ''));

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function waitForOk(
  fetcher: (path: string) => Promise<Response>,
  requestPath: string,
  timeoutMs = 30_000,
): Promise<Response> {
  const start = Date.now();
  let lastStatus = 0;
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetcher(requestPath);
      lastStatus = response.status;
      if (response.ok) {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${requestPath}; lastStatus=${lastStatus}; lastError=${String(lastError)}`);
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function createCssStubRunner(): CssRuntimeRunner {
  return {
    name: 'settings-launch-css-stub',
    start: async(options) => {
      const server = http.createServer((_request, response) => {
        response.statusCode = 404;
        response.end('not found');
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        const socket = options.shorthand.socket;
        if (typeof socket === 'string') {
          server.listen(socket, () => resolve());
          return;
        }
        server.listen(Number(options.shorthand.port), '127.0.0.1', () => resolve());
      });
      return {
        stop: async(): Promise<void> => {
          await closeServer(server);
        },
      } as any;
    },
  };
}

function createSettingsApiStubRunner(): ApiRuntimeRunner {
  return {
    name: 'settings-launch-api-stub',
    start: async(options) => {
      const apiServer = new ApiServer({
        listenEndpoint: options.runtimeHost.createListenEndpoint({
          socketPath: process.env.API_SOCKET_PATH,
          port: process.env.API_PORT ? Number(process.env.API_PORT) : undefined,
          host: '127.0.0.1',
        }),
        runtimeHost: options.runtimeHost,
        authMiddleware: new OpenAuthMiddleware({ context: options.authContext }),
      });
      registerSettingsRoutes(apiServer, { staticDir: path.join(root, 'static/settings') });
      await apiServer.start();
      return {
        config: {} as any,
        container: {} as any,
        stop: async(): Promise<void> => {
          await apiServer.stop();
        },
      };
    },
  };
}

describe('settings launch scripts', () => {
  it('exposes independent dashboard commands without starting a second Xpod host', async () => {
    const pkg = JSON.parse(await readRepoFile('package.json')) as { scripts: Record<string, string> };

    expect(pkg.scripts['settings:dev']).toBe('cd ui && bun run dev:settings');
    expect(pkg.scripts['settings:open']).toBe('node scripts/open-settings.mjs');
    expect(pkg.scripts['settings:test']).toBe('bun run test -- tests/ui/settings-launch.test.ts');
    expect(pkg.scripts['settings:open']).not.toMatch(/\b(run|start|dev|local|cloud)\b/);
  });

  it('canonicalizes safe dashboard URLs and rejects non-browser URLs', async () => {
    const { canonicalizeSettingsUrl } = await import(openSettingsScript);

    expect(canonicalizeSettingsUrl('http://127.0.0.1:6300')).toBe('http://127.0.0.1:6300/settings/models');
    expect(canonicalizeSettingsUrl('https://xpod.local/dashboard/network?debug=1#pane', {
      allowedHosts: 'xpod.local:443',
    })).toBe('https://xpod.local/settings/models');
    expect(() => canonicalizeSettingsUrl('javascript:alert(1)')).toThrow(/http or https/);
    expect(() => canonicalizeSettingsUrl('http://user:pass@localhost:3000/dashboard/models')).toThrow(/credentials/);
    expect(() => canonicalizeSettingsUrl('http://10.0.0.5:3000')).toThrow(/not allowed/);
    expect(() => canonicalizeSettingsUrl('http://169.254.169.254/latest/meta-data')).toThrow(/not allowed/);
    expect(canonicalizeSettingsUrl('http://10.0.0.5:3000', {
      allowedHosts: '10.0.0.5:3000',
    })).toBe('http://10.0.0.5:3000/settings/models');
  });

  it('does not probe non-loopback settings hosts unless explicitly allowlisted', async () => {
    const { openSettingsDashboard } = await import(openSettingsScript);
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }));
    const spawnFn = vi.fn();

    const metadataResult = await openSettingsDashboard({
      env: { XPOD_SETTINGS_URL: 'http://169.254.169.254/latest/meta-data' },
      platform: 'linux',
      fetchFn,
      spawnFn,
    });
    const privateResult = await openSettingsDashboard({
      env: { XPOD_SETTINGS_URL: 'http://10.0.0.5:3000/dashboard/models' },
      platform: 'linux',
      fetchFn,
      spawnFn,
    });

    expect(metadataResult).toMatchObject({ ok: false, code: 'host_not_allowed' });
    expect(privateResult).toMatchObject({ ok: false, code: 'host_not_allowed' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('allows an explicitly configured non-loopback settings host with exact host and port', async () => {
    const { openSettingsDashboard } = await import(openSettingsScript);
    const spawnFn = vi.fn((_command: string, _args: string[], _options: unknown) => ({
      once(event: string, callback: (value?: unknown) => void) {
        if (event === 'close') {
          callback(0);
        }
        return this;
      },
    }));
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }));

    const result = await openSettingsDashboard({
      env: {
        XPOD_SETTINGS_URL: 'http://10.0.0.5:3000/dashboard/models',
        XPOD_SETTINGS_ALLOWED_HOSTS: '10.0.0.5:3000',
      },
      platform: 'linux',
      fetchFn,
      spawnFn,
    });

    expect(result).toMatchObject({
      ok: true,
      url: 'http://10.0.0.5:3000/settings/models',
    });
    expect(fetchFn).toHaveBeenCalledWith('http://10.0.0.5:3000/settings/models', expect.objectContaining({ method: 'HEAD' }));
    expect(spawnFn).toHaveBeenCalled();
  });

  it('opens an existing dashboard through an injectable platform adapter', async () => {
    const { openSettingsDashboard } = await import(openSettingsScript);
    const spawnFn = vi.fn((_command: string, _args: string[], _options: unknown) => ({
      once(event: string, callback: (value?: unknown) => void) {
        if (event === 'close') {
          callback(0);
        }
        return this;
      },
    }));
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }));

    const result = await openSettingsDashboard({
      env: { XPOD_SETTINGS_URL: 'http://127.0.0.1:6300/dashboard/pod' },
      platform: 'linux',
      fetchFn,
      spawnFn,
    });

    expect(result).toMatchObject({
      ok: true,
      url: 'http://127.0.0.1:6300/settings/models',
      command: 'xdg-open',
      args: ['http://127.0.0.1:6300/settings/models'],
    });
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:6300/settings/models', expect.objectContaining({ method: 'HEAD' }));
    expect(spawnFn).toHaveBeenCalledWith('xdg-open', ['http://127.0.0.1:6300/settings/models'], expect.objectContaining({
      detached: true,
      stdio: 'ignore',
    }));
    expect(spawnFn.mock.calls.flatMap((call) => [call[0], ...(call[1] as string[])])).not.toEqual(
      expect.arrayContaining(['bun', 'node', 'dev', 'local', 'cloud']),
    );
  });

  it('times out a hanging GUI open command and kills the child once', async () => {
    const { openSettingsDashboard } = await import(openSettingsScript);
    const kill = vi.fn();
    const unref = vi.fn();
    const child = {
      once() {
        return this;
      },
      kill,
      unref,
    };
    const started = Date.now();

    const result = await openSettingsDashboard({
      env: {
        XPOD_SETTINGS_URL: 'http://localhost:3000',
        XPOD_SETTINGS_OPEN_COMMAND_TIMEOUT_MS: '20',
      },
      platform: 'linux',
      fetchFn: async () => ({ ok: true, status: 200 }),
      spawnFn: vi.fn(() => child),
    });

    expect(Date.now() - started).toBeLessThan(500);
    expect(result).toMatchObject({
      ok: false,
      code: 'open_command_failed',
      reason: 'timeout',
      command: 'xdg-open',
      url: 'http://localhost:3000/settings/models',
    });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('does not report timeout after the GUI command closes successfully', async () => {
    vi.useFakeTimers();
    const { openSettingsDashboard } = await import(openSettingsScript);
    const kill = vi.fn();
    const unref = vi.fn();
    const child = {
      once(event: string, callback: (value?: unknown) => void) {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
        return this;
      },
      kill,
      unref,
    };

    const promise = openSettingsDashboard({
      env: {
        XPOD_SETTINGS_URL: 'http://localhost:3000',
        XPOD_SETTINGS_OPEN_COMMAND_TIMEOUT_MS: '1000',
      },
      platform: 'darwin',
      fetchFn: async () => ({ ok: true, status: 200 }),
      spawnFn: vi.fn(() => child),
    });
    await vi.advanceTimersByTimeAsync(20);
    const result = await promise;
    vi.useRealTimers();

    expect(result).toMatchObject({
      ok: true,
      command: 'open',
      url: 'http://localhost:3000/settings/models',
    });
    expect(kill).not.toHaveBeenCalled();
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('returns structured errors when the platform GUI command fails', async () => {
    const { openSettingsDashboard } = await import(openSettingsScript);
    const spawnFn = vi.fn(() => ({
      once(event: string, callback: (value?: unknown) => void) {
        if (event === 'close') {
          callback(1);
        }
        return this;
      },
    }));

    const result = await openSettingsDashboard({
      env: { XPOD_SETTINGS_URL: 'http://localhost:3000' },
      platform: 'darwin',
      fetchFn: async () => ({ ok: true, status: 200 }),
      spawnFn,
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'open_command_failed',
      command: 'open',
      exitCode: 1,
      url: 'http://localhost:3000/settings/models',
    });
  });
});

describe('settings static launch smoke', () => {
  let runtime: XpodRuntimeHandle;
  let socketRoot = '';
  let settingsHtml = '';
  let settingsScriptPath = '';

  beforeAll(async () => {
    const transport = resolveTestRuntimeTransport();
    socketRoot = transport === 'socket' ? fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-settings-')) : '';
    settingsHtml = await readRepoFile('static/settings/settings.html');
    const scriptMatch = settingsHtml.match(/src="(\/settings\/assets\/settings-[^"]+\.js)"/);
    expect(scriptMatch?.[1]).toBeTruthy();
    settingsScriptPath = scriptMatch![1];
    expect(fs.existsSync(settingsUrlToStaticPath(settingsScriptPath))).toBe(true);

    runtime = await startXpodRuntime({
      mode: 'local',
      open: true,
      transport,
      runtimeRoot: createTestDir('settings-launch'),
      ...(socketRoot ? {
        gatewaySocketPath: path.join(socketRoot, 'gateway.sock'),
        cssSocketPath: path.join(socketRoot, 'css.sock'),
        apiSocketPath: path.join(socketRoot, 'api.sock'),
      } : {}),
      logLevel: 'warn',
      cssRunner: createCssStubRunner(),
      apiRunner: createSettingsApiStubRunner(),
      env: {
        XPOD_LOCAL_AUTO_PROVISION: 'false',
        CSS_ALLOWED_HOSTS: 'localhost,127.0.0.1',
        XPOD_GATEWAY_INTERNAL_CLIENT_ID: 'settings-launch-client',
        XPOD_GATEWAY_INTERNAL_CLIENT_SECRET: 'settings-launch-secret',
        XPOD_GATEWAY_LOCATOR_SECRET: 'settings-launch-locator-secret',
        XPOD_GATEWAY_LOCATOR_KEY_ID: 'settings-launch-locator',
      },
    });

    await waitForOk(runtime.fetch, '/settings/models');
  }, 90_000);

  afterAll(async () => {
    await runtime?.stop();
    if (socketRoot) {
      fs.rmSync(socketRoot, { recursive: true, force: true });
    }
  });

  it('serves the current settings bundle for settings deep links', async () => {
    for (const route of ['/settings/models', '/settings/pod', '/settings/network', '/settings/services']) {
      const response = await runtime.fetch(route);
      expect(response.status, route).toBe(200);
      expect(response.headers.get('content-type'), route).toContain('text/html');
      await expect(response.text(), route).resolves.toContain(settingsScriptPath);
    }
  });

  it('serves referenced settings assets from the packaged static directory', async () => {
    const response = await runtime.fetch(settingsScriptPath);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/javascript');
    await expect(response.text()).resolves.toContain('createRoot');
  });
});
