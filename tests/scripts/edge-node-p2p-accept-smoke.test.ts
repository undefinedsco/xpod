import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

describe('edge node P2P accept smoke script', () => {
  const cleanupStack: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanupStack.length > 0) {
      await cleanupStack.pop()?.();
    }
  });

  it('prints node-side accept smoke evidence without replacing tunnel fallbacks', async () => {
    let apiBaseUrl = '';
    let sessionPollCount = 0;
    const signalApi = await startSignalApi(async (req, res) => {
      const url = new URL(req.url ?? '/', apiBaseUrl);
      if (req.method === 'POST' && url.pathname === '/api/signal') {
        writeJson(res, {});
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/signal/nodes/node-1/sessions') {
        sessionPollCount += 1;
        writeJson(res, { kind: 'p2p', sessions: [] });
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`unexpected ${req.method ?? 'GET'} ${url.pathname}`);
    });
    apiBaseUrl = signalApi.baseUrl;
    cleanupStack.push(() => signalApi.close());

    const { stdout } = await execFileAsync('bun', [
      'scripts/edge-node-p2p-accept-smoke.ts',
      '--signal-endpoint', `${apiBaseUrl}api/signal`,
      '--node-id', 'node-1',
      '--node-token', 'node-token',
      '--base-url', 'https://node-1.pods.example/',
      '--target-base-url', 'http://127.0.0.1:3000/',
      '--accept-interval-ms', '25',
      '--connect-timeout-ms', '100',
      '--settle-after-accept-ms', '10',
      '--run-timeout-ms', '100',
      '--allow-no-accept',
    ], { cwd: root, timeout: 8_000 });

    const result = JSON.parse(stdout) as {
      smokeOk: boolean;
      requireAccept: boolean;
      accepted: unknown[];
      caveats: string[];
      settleAfterAcceptMs?: number;
    };
    expect(result.smokeOk).toBe(true);
    expect(result.requireAccept).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.settleAfterAcceptMs).toBe(10);
    expect(result.caveats.join('\n')).toContain('Cloudflare Tunnel');
    expect(result.caveats.join('\n')).toContain('FRP/SakuraFRP');
    expect(sessionPollCount).toBeGreaterThan(0);
  });

  it('fails when accept evidence is required but no P2P session is accepted', async () => {
    let apiBaseUrl = '';
    const signalApi = await startSignalApi(async (req, res) => {
      const url = new URL(req.url ?? '/', apiBaseUrl);
      if (req.method === 'POST' && url.pathname === '/api/signal') {
        writeJson(res, {});
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/signal/nodes/node-1/sessions') {
        writeJson(res, { kind: 'p2p', sessions: [] });
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`unexpected ${req.method ?? 'GET'} ${url.pathname}`);
    });
    apiBaseUrl = signalApi.baseUrl;
    cleanupStack.push(() => signalApi.close());

    const result = await execFileCatching('bun', [
      'scripts/edge-node-p2p-accept-smoke.ts',
      '--signal-endpoint', `${apiBaseUrl}api/signal`,
      '--node-id', 'node-1',
      '--node-token', 'node-token',
      '--base-url', 'https://node-1.pods.example/',
      '--target-base-url', 'http://127.0.0.1:3000/',
      '--accept-interval-ms', '25',
      '--connect-timeout-ms', '100',
      '--run-timeout-ms', '100',
      '--require-accept',
    ], { cwd: root, timeout: 8_000 });

    expect(result.code).not.toBe(0);
    const body = JSON.parse(result.stdout) as { smokeOk: boolean; error: string };
    expect(body.smokeOk).toBe(false);
    expect(body.error).toContain('No raw TCP P2P session was accepted');
  });
});

async function startSignalApi(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected signal API TCP address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: () => closeServer(server),
  };
}

function writeJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function execFileCatching(
  file: string,
  args: string[],
  options: Parameters<typeof execFile>[2],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({
        code: typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
          ? (error as NodeJS.ErrnoException).code as number
          : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}
