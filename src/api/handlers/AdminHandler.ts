/**
 * Admin API Handler
 * Provides configuration management, restart functionality, and log streaming
 */

import type { ServerResponse } from 'node:http';
import type { ApiServer, RouteHandler } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import fs from 'fs';
import path from 'path';
import { createReadStream, statSync } from 'fs';
import { createInterface } from 'readline';
import { PACKAGE_ROOT } from '../../runtime';

const CONFIG_DIR = path.resolve(PACKAGE_ROOT, 'config');

function getEnvFilePath(): string {
  const envPath = process.env.XPOD_ENV_PATH;
  if (envPath && envPath.trim()) {
    return path.resolve(envPath);
  }
  return path.resolve(process.cwd(), '.env.local');
}

interface ConfigFile {
  name: string;
  path: string;
  exists: boolean;
}

interface EnvConfig {
  [key: string]: string;
}

/**
 * Read .env.local file and parse it
 */
function readEnvFile(filePath: string): EnvConfig {
  const config: EnvConfig = {};
  if (!fs.existsSync(filePath)) {
    return config;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Remove quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    config[key] = value;
  }
  return config;
}

/**
 * Write .env.local file
 */
function writeEnvFile(filePath: string, config: EnvConfig): void {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    // Quote values that contain spaces or special characters
    const needsQuotes = /[\s"'=]/.test(value);
    const quotedValue = needsQuotes ? `"${value}"` : value;
    lines.push(`${key}=${quotedValue}`);
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

/**
 * List available config files
 */
function listConfigFiles(): ConfigFile[] {
  const files: ConfigFile[] = [];
  const configFiles = ['local.json', 'cloud.json', 'main.json', 'xpod.base.json'];

  for (const name of configFiles) {
    const filePath = path.join(CONFIG_DIR, name);
    files.push({
      name,
      path: filePath,
      exists: fs.existsSync(filePath),
    });
  }
  return files;
}

/**
 * Send JSON response helper
 */

function isPrivateIp(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true;
  if (host.startsWith('127.')) return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  const m = host.match(/^172\.(\d+)\./);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

async function fetchPublicIp(): Promise<string | null> {
  const endpoints = [
    'https://api.ipify.org?format=json',
    'https://ifconfig.me/ip',
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) {
        continue;
      }
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await res.json() as { ip?: string };
        const ip = json.ip?.trim();
        if (ip) {
          return ip;
        }
      } else {
        const ip = (await res.text()).trim();
        if (ip) {
          return ip;
        }
      }
    } catch {
      // ignore and try next endpoint
    }
  }

  return null;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/**
 * Parse JSON body from request
 */
function parseJsonBody(req: AuthenticatedRequest): Promise<{ env?: EnvConfig }> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function registerAdminRoutes(server: ApiServer): void {
  const logger = console;

  // GET /api/admin/status - Get xpod status
  const statusHandler: RouteHandler = async (
    _req: AuthenticatedRequest,
    res: ServerResponse,
  ) => {
    try {
      const envFilePath = getEnvFilePath();
      const env = readEnvFile(envFilePath);
      const configs = listConfigFiles();

      sendJson(res, 200, {
        status: 'running',
        pid: process.pid,
        ppid: process.ppid,
        uptime: process.uptime(),
        env: {
          CSS_BASE_URL: env.CSS_BASE_URL || process.env.CSS_BASE_URL,
          CSS_EDITION: env.CSS_EDITION || process.env.CSS_EDITION,
          CSS_PORT: env.CSS_PORT || process.env.CSS_PORT,
        },
        configs,
      });
    } catch (error) {
      logger.error('[Admin] Status error:', error);
      sendJson(res, 500, { error: 'Failed to get status' });
    }
  };

  // GET /api/admin/config - Get current configuration
  const getConfigHandler: RouteHandler = async (
    _req: AuthenticatedRequest,
    res: ServerResponse,
  ) => {
    try {
      const envFilePath = getEnvFilePath();
      const env = readEnvFile(envFilePath);
      sendJson(res, 200, {
        env,
        configFiles: listConfigFiles(),
      });
    } catch (error) {
      logger.error('[Admin] Get config error:', error);
      sendJson(res, 500, { error: 'Failed to read configuration' });
    }
  };

  // PUT /api/admin/config - Update configuration
  const updateConfigHandler: RouteHandler = async (
    req: AuthenticatedRequest,
    res: ServerResponse,
  ) => {
    try {
      // Parse body from raw request
      const body = await parseJsonBody(req);

      if (body.env) {
        // Merge with existing config
        const envFilePath = getEnvFilePath();
        const currentEnv = readEnvFile(envFilePath);
        const newEnv = { ...currentEnv, ...body.env };

        // Remove keys set to null or empty string
        for (const [key, value] of Object.entries(newEnv)) {
          if (value === null || value === '') {
            delete newEnv[key];
          }
        }

        writeEnvFile(envFilePath, newEnv);
        logger.log('[Admin] Configuration updated');
      }

      sendJson(res, 200, {
        success: true,
        message: 'Configuration updated. Restart required for changes to take effect.',
      });
    } catch (error) {
      logger.error('[Admin] Update config error:', error);
      sendJson(res, 500, { error: 'Failed to update configuration' });
    }
  };

  // POST /api/admin/restart - Trigger xpod restart
  const restartHandler: RouteHandler = async (
    _req: AuthenticatedRequest,
    res: ServerResponse,
  ) => {
    try {
      const ppid = process.ppid;

      if (!ppid) {
        sendJson(res, 500, { error: 'Cannot determine parent process' });
        return;
      }

      logger.log(`[Admin] Sending SIGUSR1 to parent process (pid: ${ppid})`);

      // Send response before triggering restart
      sendJson(res, 200, {
        success: true,
        message: 'Restart signal sent. Server will restart shortly.',
      });

      // Give time for response to be sent, then signal parent
      setTimeout(() => {
        try {
          process.kill(ppid, 'SIGUSR1');
        } catch (err) {
          logger.error('[Admin] Failed to send restart signal:', err);
        }
      }, 100);
    } catch (error) {
      logger.error('[Admin] Restart error:', error);
      sendJson(res, 500, { error: 'Failed to trigger restart' });
    }
  };

  // Log buffer for recent logs (in-memory)
  const logBuffer: Array<{
    timestamp: string;
    level: string;
    source: string;
    message: string;
  }> = [];
  const MAX_LOG_BUFFER = 1000;

  // Capture stdout/stderr logs
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  function addLog(level: string, source: string, message: string): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      source,
      message: message.trim(),
    };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_BUFFER) {
      logBuffer.shift();
    }
  }

  // Intercept stdout
  process.stdout.write = (chunk: any, ...args: any[]): boolean => {
    const message = chunk.toString();
    addLog('info', 'xpod', message);
    return originalStdoutWrite(chunk, ...args);
  };

  // Intercept stderr
  process.stderr.write = (chunk: any, ...args: any[]): boolean => {
    const message = chunk.toString();
    addLog('error', 'xpod', message);
    return originalStderrWrite(chunk, ...args);
  };

  // GET /api/admin/logs - Get recent logs
  const getLogsHandler: RouteHandler = async (
    req: AuthenticatedRequest,
    res: ServerResponse,
  ) => {
    try {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      const level = url.searchParams.get('level');
      const source = url.searchParams.get('source');

      let logs = [...logBuffer];

      // Apply filters
      if (level && level !== 'all') {
        logs = logs.filter(log => log.level === level);
      }
      if (source && source !== 'all') {
        logs = logs.filter(log => log.source === source);
      }

      // Return last N logs
      logs = logs.slice(-limit);

      sendJson(res, 200, { logs });
    } catch (error) {
      logger.error('[Admin] Get logs error:', error);
      sendJson(res, 500, { error: 'Failed to get logs' });
    }
  };

  // GET /api/admin/logs/stream - Stream logs via SSE
  const streamLogsHandler: RouteHandler = async (
    _req: AuthenticatedRequest,
    res: ServerResponse,
  ) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial logs
    const lastIndex = logBuffer.length;
    res.write(`data: ${JSON.stringify({ type: 'init', logs: logBuffer.slice(-100) })}\n\n`);

    // Send new logs every second
    let currentIndex = lastIndex;
    const interval = setInterval(() => {
      if (logBuffer.length > currentIndex) {
        const newLogs = logBuffer.slice(currentIndex);
        res.write(`data: ${JSON.stringify({ type: 'update', logs: newLogs })}\n\n`);
        currentIndex = logBuffer.length;
      }
    }, 1000);

    // Clean up on close
    res.on('close', () => {
      clearInterval(interval);
    });
  };

  // GET /api/admin/logs/file - Read log file from disk
  const getLogFileHandler: RouteHandler = async (
    req: AuthenticatedRequest,
    res: ServerResponse,
  ) => {
    try {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const lines = parseInt(url.searchParams.get('lines') || '100', 10);

      // Try common log file locations
      const logPaths = [
        path.resolve(process.cwd(), 'logs', 'combined.log'),
        path.resolve(process.cwd(), 'logs', 'error.log'),
        path.resolve(process.cwd(), 'xpod.log'),
        path.resolve(process.cwd(), 'combined.log'),
      ];

      let logPath: string | null = null;
      for (const p of logPaths) {
        if (fs.existsSync(p)) {
          logPath = p;
          break;
        }
      }

      if (!logPath) {
        sendJson(res, 404, { error: 'No log file found' });
        return;
      }

      // Read last N lines
      const fileLogs: string[] = [];
      const stats = statSync(logPath);
      const stream = createReadStream(logPath, {
        start: Math.max(0, stats.size - 1024 * 100), // Last 100KB
        end: stats.size,
      });

      const rl = createInterface({ input: stream });
      for await (const line of rl) {
        fileLogs.push(line);
      }

      const lastLines = fileLogs.slice(-lines);
      sendJson(res, 200, {
        file: logPath,
        lines: lastLines,
      });
    } catch (error) {
      logger.error('[Admin] Get log file error:', error);
      sendJson(res, 500, { error: 'Failed to read log file' });
    }
  };


  // GET /api/admin/public-ip - Detect outbound public IP and compare with CSS_BASE_URL
  const publicIpHandler: RouteHandler = async (
    req: AuthenticatedRequest,
    res: ServerResponse,
  ) => {
    try {
      const envFilePath = getEnvFilePath();
      const env = readEnvFile(envFilePath);
      const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
      const baseUrl = parsedUrl.searchParams.get('baseUrl') || env.CSS_BASE_URL || process.env.CSS_BASE_URL || '';

      const ip = await fetchPublicIp();

      if (!baseUrl) {
        sendJson(res, 200, {
          status: 'unknown',
          publicIp: ip,
          baseUrl,
          detail: ip ? '未配置 Base URL，无法判断是否可直连。' : '未配置 Base URL，且无法获取公网 IP。',
        });
        return;
      }

      let hostname = '';
      try {
        hostname = new URL(baseUrl).hostname;
      } catch {
        sendJson(res, 200, {
          status: 'unknown',
          publicIp: ip,
          baseUrl,
          detail: 'Base URL 格式不合法，无法判断。',
        });
        return;
      }

      if (isPrivateIp(hostname)) {
        sendJson(res, 200, {
          status: 'fail',
          publicIp: ip,
          baseUrl,
          detail: 'Base URL 为本地/内网地址，默认不可直连。',
        });
        return;
      }

      // If hostname is an IP, compare directly.
      const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
      if (isIpLiteral) {
        if (!ip) {
          sendJson(res, 200, {
            status: 'unknown',
            publicIp: null,
            baseUrl,
            detail: '无法获取公网出口 IP，无法比对。',
          });
          return;
        }
        const ok = hostname === ip;
        sendJson(res, 200, {
          status: ok ? 'pass' : 'fail',
          publicIp: ip,
          baseUrl,
          detail: ok
            ? 'Base URL IP 与公网出口 IP 一致，默认可直连。'
            : 'Base URL IP 与公网出口 IP 不一致，默认不可直连。',
        });
        return;
      }

      // Domain name: we can only do best-effort.
      if (!ip) {
        sendJson(res, 200, {
          status: 'unknown',
          publicIp: null,
          baseUrl,
          detail: '已配置域名，但无法获取公网出口 IP，无法进一步判断。',
        });
        return;
      }

      sendJson(res, 200, {
        status: 'pass',
        publicIp: ip,
        baseUrl,
        detail: '已配置域名，默认可直连（仍需确保端口映射/防火墙放行）。',
      });
    } catch (error) {
      logger.error('[Admin] Public IP check error:', error);
      sendJson(res, 500, { error: 'Failed to detect public ip' });
    }
  };

  // Register routes - public for now (TODO: add auth for production)
  server.get('/api/admin/status', statusHandler, { public: true });
  server.get('/api/admin/config', getConfigHandler, { public: true });
  server.get('/api/admin/public-ip', publicIpHandler, { public: true });
  server.put('/api/admin/config', updateConfigHandler, { public: true });
  server.post('/api/admin/restart', restartHandler, { public: true });
  server.get('/api/admin/logs', getLogsHandler, { public: true });
  server.get('/api/admin/logs/stream', streamLogsHandler, { public: true });
  server.get('/api/admin/logs/file', getLogFileHandler, { public: true });

  logger.log('[Admin] Admin API routes registered');
}
