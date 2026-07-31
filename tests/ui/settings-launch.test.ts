import fs from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { startXpodRuntime, type XpodRuntimeHandle } from '../../src/runtime/XpodRuntime';
import { resolveTestRuntimeTransport } from '../helpers/runtimeTransport';
import { createTestDir } from '../utils/sqlite';

const root = path.resolve(__dirname, '../..');
const openSettingsScript = path.join(root, 'scripts/open-settings.mjs');
const dashboardUrlToStaticPath = (urlPath: string): string => path.join(root, 'static/dashboard', urlPath.replace(/^\/dashboard\//, ''));

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

describe('settings launch scripts', () => {
  it('exposes independent dashboard commands without starting a second Xpod host', async () => {
    const pkg = JSON.parse(await readRepoFile('package.json')) as { scripts: Record<string, string> };

    expect(pkg.scripts['settings:dev']).toBe('cd ui && bun run dev:dashboard');
    expect(pkg.scripts['settings:open']).toBe('node scripts/open-settings.mjs');
    expect(pkg.scripts['settings:test']).toBe('bun run test -- tests/ui/settings-launch.test.ts');
    expect(pkg.scripts['settings:open']).not.toMatch(/\b(run|start|dev|local|cloud)\b/);
  });

  it('canonicalizes safe dashboard URLs and rejects non-browser URLs', async () => {
    const { canonicalizeSettingsUrl } = await import(openSettingsScript);

    expect(canonicalizeSettingsUrl('http://127.0.0.1:6300')).toBe('http://127.0.0.1:6300/dashboard/models');
    expect(canonicalizeSettingsUrl('https://xpod.local/dashboard/network?debug=1#pane')).toBe('https://xpod.local/dashboard/models');
    expect(() => canonicalizeSettingsUrl('javascript:alert(1)')).toThrow(/http or https/);
    expect(() => canonicalizeSettingsUrl('http://user:pass@localhost:3000/dashboard/models')).toThrow(/credentials/);
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
      url: 'http://127.0.0.1:6300/dashboard/models',
      command: 'xdg-open',
      args: ['http://127.0.0.1:6300/dashboard/models'],
    });
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:6300/dashboard/models', expect.objectContaining({ method: 'HEAD' }));
    expect(spawnFn).toHaveBeenCalledWith('xdg-open', ['http://127.0.0.1:6300/dashboard/models'], expect.objectContaining({
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
      url: 'http://localhost:3000/dashboard/models',
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
      url: 'http://localhost:3000/dashboard/models',
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
      url: 'http://localhost:3000/dashboard/models',
    });
  });
});

describe('settings dashboard static launch smoke', () => {
  let runtime: XpodRuntimeHandle;
  let dashboardHtml = '';
  let dashboardScriptPath = '';

  beforeAll(async () => {
    dashboardHtml = await readRepoFile('static/dashboard/dashboard.html');
    const scriptMatch = dashboardHtml.match(/src="(\/dashboard\/assets\/dashboard-[^"]+\.js)"/);
    expect(scriptMatch?.[1]).toBeTruthy();
    dashboardScriptPath = scriptMatch![1];
    expect(fs.existsSync(dashboardUrlToStaticPath(dashboardScriptPath))).toBe(true);

    runtime = await startXpodRuntime({
      mode: 'local',
      open: true,
      transport: resolveTestRuntimeTransport('port'),
      runtimeRoot: createTestDir('settings-launch'),
      logLevel: 'warn',
      env: {
        XPOD_LOCAL_AUTO_PROVISION: 'false',
        CSS_ALLOWED_HOSTS: 'localhost,127.0.0.1',
        XPOD_GATEWAY_INTERNAL_CLIENT_ID: 'settings-launch-client',
        XPOD_GATEWAY_INTERNAL_CLIENT_SECRET: 'settings-launch-secret',
        XPOD_GATEWAY_LOCATOR_SECRET: 'settings-launch-locator-secret',
        XPOD_GATEWAY_LOCATOR_KEY_ID: 'settings-launch-locator',
        XPOD_SECRET_CELL_KEY_ID: 'settings-launch',
        XPOD_SECRET_CELL_KEY: Buffer.alloc(32, 11).toString('base64'),
      },
    });

    await waitForOk(runtime.fetch, '/dashboard/models');
  }, 90_000);

  afterAll(async () => {
    await runtime?.stop();
  });

  it('serves the current dashboard bundle for settings deep links', async () => {
    for (const route of ['/dashboard/models', '/dashboard/pod', '/dashboard/network', '/dashboard/services']) {
      const response = await runtime.fetch(route);
      expect(response.status, route).toBe(200);
      expect(response.headers.get('content-type'), route).toContain('text/html');
      await expect(response.text(), route).resolves.toContain(dashboardScriptPath);
    }
  });

  it('serves referenced dashboard assets from the packaged static directory', async () => {
    const response = await runtime.fetch(dashboardScriptPath);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/javascript');
    await expect(response.text()).resolves.toContain('createRoot');
  });
});
