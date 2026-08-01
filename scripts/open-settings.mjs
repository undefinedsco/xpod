#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'http://localhost:3000';

class SettingsUrlHostError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingsUrlHostError';
    this.code = 'host_not_allowed';
  }
}

function dashboardInputFromEnv(env) {
  return env.XPOD_SETTINGS_URL
    ?? env.XPOD_DASHBOARD_URL
    ?? env.CSS_BASE_URL
    ?? env.XPOD_BASE_URL
    ?? (env.XPOD_PORT || env.PORT ? `http://localhost:${env.XPOD_PORT ?? env.PORT}` : DEFAULT_BASE_URL);
}

function normalizeHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function effectivePort(url) {
  if (url.port) {
    return url.port;
  }
  return url.protocol === 'https:' ? '443' : '80';
}

function isLoopbackHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === 'localhost' || host === '::1') {
    return true;
  }

  const parts = host.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function parseAllowedHosts(value = '') {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      let parsed;
      try {
        parsed = new URL(`http://${entry}`);
      } catch {
        throw new SettingsUrlHostError(`Invalid XPOD_SETTINGS_ALLOWED_HOSTS entry: ${entry}`);
      }
      if (!parsed.port) {
        throw new SettingsUrlHostError(`XPOD_SETTINGS_ALLOWED_HOSTS entries must include an explicit port: ${entry}`);
      }
      if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new SettingsUrlHostError(`Invalid XPOD_SETTINGS_ALLOWED_HOSTS entry: ${entry}`);
      }
      return {
        host: normalizeHostname(parsed.hostname),
        port: parsed.port,
      };
    });
}

function assertAllowedSettingsHost(url, allowedHosts) {
  if (isLoopbackHost(url.hostname)) {
    return;
  }

  const host = normalizeHostname(url.hostname);
  const port = effectivePort(url);
  const allowed = parseAllowedHosts(allowedHosts);
  if (allowed.some((entry) => entry.host === host && entry.port === port)) {
    return;
  }

  throw new SettingsUrlHostError(
    `Settings host ${host}:${port} is not allowed. Default settings launch only permits localhost, 127.0.0.0/8, and ::1; set XPOD_SETTINGS_ALLOWED_HOSTS=host:port to opt in to a non-loopback host. Hostname allowlists are operator opt-in and should account for DNS rebinding risk.`,
  );
}

export function canonicalizeSettingsUrl(input = DEFAULT_BASE_URL, options = {}) {
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
  assertAllowedSettingsHost(url, options.allowedHosts ?? '');

  url.pathname = '/settings/models';
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

function waitForChild(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      child.removeListener?.('error', onError);
      child.removeListener?.('close', onClose);
    };

    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const onError = (error) => settle({ type: 'error', error });
    const onClose = (code, signal) => settle({ type: 'close', code, signal });

    child.once('error', onError);
    child.once('close', onClose);

    timer = setTimeout(() => {
      try {
        child.kill?.();
      } catch {
        // Best effort: platform open commands may have already exited.
      }
      child.unref?.();
      settle({ type: 'timeout' });
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function openSettingsDashboard(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fetchFn = options.fetchFn ?? fetch;
  const spawnFn = options.spawnFn ?? spawn;
  let url;

  try {
    url = canonicalizeSettingsUrl(options.url ?? dashboardInputFromEnv(env), {
      allowedHosts: env.XPOD_SETTINGS_ALLOWED_HOSTS,
    });
  } catch (error) {
    return {
      ok: false,
      code: error instanceof SettingsUrlHostError ? error.code : 'invalid_url',
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
  const openCommandTimeoutMs = Number(env.XPOD_SETTINGS_OPEN_COMMAND_TIMEOUT_MS ?? 7000);
  try {
    const child = spawnFn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    const result = await waitForChild(child, openCommandTimeoutMs);
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
    if (result.type === 'timeout') {
      return {
        ok: false,
        code: 'open_command_failed',
        reason: 'timeout',
        message: `Open command timed out after ${openCommandTimeoutMs}ms`,
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
