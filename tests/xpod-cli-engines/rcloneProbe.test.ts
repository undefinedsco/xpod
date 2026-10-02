import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPodContractServer, type PodContractServer } from '../agentfs-pod/support/podContractServer';

const REPO_ROOT = process.cwd();
const BIN = process.env.XPOD_RCLONE_POD_BIN ?? path.join(REPO_ROOT, 'tools', 'rclone-pod', 'bin', 'xpod-rclone');
const available = existsSync(BIN);
const TOKEN = 'rclone-token';

function runCli(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(BIN, args, { env: { ...process.env, ...env }, stdio: [ 'ignore', 'pipe', 'pipe' ] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ status: 1, stdout, stderr: error.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code ?? 1, stdout, stderr }); });
  });
}

describe.runIf(available)('rclone podhttp candidate probe against the external Pod fixture', () => {
  let server: PodContractServer;

  beforeAll(async () => {
    server = await startPodContractServer({ token: TOKEN, files: { 'alpha.txt': 'ALPHA_BODY_0123456789\n' } });
  });

  afterAll(async () => {
    await server.close();
  });

  function env(): NodeJS.ProcessEnv {
    return {
      RCLONE_CONFIG_POD_TYPE: 'podhttp',
      RCLONE_CONFIG_POD_URL: server.podRoot,
      RCLONE_CONFIG_POD_TOKEN: TOKEN,
    };
  }

  it('lists metadata only (no body transfer) through the recording fixture', async () => {
    server.resetLog();
    const result = await runCli([ 'lsjson', 'pod:', '--no-modtime' ], env());
    expect(result.status, result.stderr).toBe(0);
    const entries = JSON.parse(result.stdout) as { Name: string; Size: number }[];
    expect(entries.map((entry) => entry.Name)).toContain('alpha.txt');
    const bodyGets = server.log.filter((entry) => entry.resource !== undefined && entry.method === 'GET');
    expect(bodyGets).toEqual([]);
  });

  it('reads a single file body', async () => {
    server.resetLog();
    const result = await runCli([ 'cat', 'pod:alpha.txt' ], env());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('ALPHA_BODY_0123456789\n');
    expect(server.log.some((entry) => entry.resource === 'alpha.txt' && entry.method === 'GET')).toBe(true);
  });
});

describe.skipIf(available)('rclone podhttp candidate probe (skipped: no xpod-rclone build)', () => {
  it('requires the rclone study build', () => {
    expect(available).toBe(false);
  });
});
