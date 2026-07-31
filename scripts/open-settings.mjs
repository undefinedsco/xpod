#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'http://localhost:3000';

function dashboardInputFromEnv(env) {
  return env.XPOD_SETTINGS_URL
    ?? env.XPOD_DASHBOARD_URL
    ?? env.CSS_BASE_URL
    ?? env.XPOD_BASE_URL
    ?? (env.XPOD_PORT || env.PORT ? `http://localhost:${env.XPOD_PORT ?? env.PORT}` : DEFAULT_BASE_URL);
}

export function canonicalizeSettingsUrl(input = DEFAULT_BASE_URL) {
  let url;
  try {
    url = new URL(input);
  } catch (error) {
    throw new Error(`Invalid settings URL: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Settings URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('Settings URL must not include credentials');
  }

  url.pathname = '/dashboard/models';
  url.search = '';
  url.hash = '';
  return url.href;
}

export function resolvePlatformOpenCommand(platform, url) {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', url] };
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    return { command: 'xdg-open', args: [url] };
  }
  throw new Error(`Unsupported platform for opening a browser: ${platform}`);
}

function waitForChild(child) {
  return new Promise((resolve) => {
    child.once('error', (error) => resolve({ type: 'error', error }));
    child.once('close', (code, signal) => resolve({ type: 'close', code, signal }));
  });
}

export async function openSettingsDashboard(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fetchFn = options.fetchFn ?? fetch;
  const spawnFn = options.spawnFn ?? spawn;
  let url;

  try {
    url = canonicalizeSettingsUrl(options.url ?? dashboardInputFromEnv(env));
  } catch (error) {
    return {
      ok: false,
      code: 'invalid_url',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const response = await fetchFn(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(Number(env.XPOD_SETTINGS_OPEN_TIMEOUT_MS ?? 3000)),
    });
    if (!response.ok) {
      return {
        ok: false,
        code: 'dashboard_unavailable',
        message: `Dashboard host returned HTTP ${response.status}`,
        status: response.status,
        url,
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: 'dashboard_unavailable',
      message: error instanceof Error ? error.message : String(error),
      url,
    };
  }

  let resolved;
  try {
    resolved = resolvePlatformOpenCommand(platform, url);
  } catch (error) {
    return {
      ok: false,
      code: 'unsupported_platform',
      message: error instanceof Error ? error.message : String(error),
      url,
    };
  }

  const { command, args } = resolved;
  try {
    const child = spawnFn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    const result = await waitForChild(child);
    if (result.type === 'error') {
      return {
        ok: false,
        code: 'open_command_failed',
        message: result.error instanceof Error ? result.error.message : String(result.error),
        command,
        args,
        url,
      };
    }
    if (result.code && result.code !== 0) {
      return {
        ok: false,
        code: 'open_command_failed',
        message: `Open command exited with code ${result.code}`,
        command,
        args,
        exitCode: result.code,
        signal: result.signal,
        url,
      };
    }
    child.unref?.();
    return {
      ok: true,
      url,
      command,
      args,
    };
  } catch (error) {
    return {
      ok: false,
      code: 'open_command_failed',
      message: error instanceof Error ? error.message : String(error),
      command,
      args,
      url,
    };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await openSettingsDashboard({ url: process.argv[2] });
  const output = `${JSON.stringify(result)}\n`;
  if (result.ok) {
    process.stdout.write(output);
    process.exit(0);
  }
  process.stderr.write(output);
  process.exit(1);
}
