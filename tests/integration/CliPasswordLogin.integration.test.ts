import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { XpodTestStack } from '../helpers/XpodTestStack';
import { setupAccount } from './helpers/solidAccount';

const nativeCommand = process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND;

// This exercises the actual password/client-credentials CLI entry point.
// Browser OIDC is not currently an initial-login command in this CLI.
it.skipIf(!nativeCommand)('restores password login in fresh CLI processes and rejects private reads after logout', async () => {
  if (!nativeCommand) throw new Error('Set XPOD_QLEVER_LOCAL_RUNTIME_COMMAND to a real native QLever executable');
  await mkdir(path.resolve('.test-data'), { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/cli-password-login-'));
  const solidHome = path.join(root, 'solid-home');
  const stack = new XpodTestStack();
  const cli = (args: string[]): Promise<{ exitCode: number; result: { ok: boolean; code: string; data?: Record<string, unknown> } }> => new Promise((resolve, reject) => {
    const child = spawn('bun', ['--no-env-file', path.resolve('src/cli/index.ts'), ...args, '--json'], {
      env: { ...process.env, SOLID_HOME: solidHome }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.resume();
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI command timed out')); }, 60_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { resolve({ exitCode: code ?? -1, result: JSON.parse(output) }); }
      catch { reject(new Error('CLI did not emit its JSON envelope')); }
    });
  });
  try {
    await stack.start('local', {
      transport: 'port', open: false, apiOpen: false, logLevel: 'error',
      runtimeRoot: path.join(root, 'runtime'), env: { XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: nativeCommand },
    });
    const account = await setupAccount(stack.baseUrl, 'cli-login');
    expect(account?.email && account.password).toBeTruthy();
    const login = await cli(['auth', 'login', '--url', stack.baseUrl, '--email', account!.email!, '--password', account!.password!]);
    expect(login.exitCode).toBe(0);
    expect(login.result).toMatchObject({ ok: true, data: { webId: account!.webId } });
    const stored = JSON.parse(await readFile(path.join(solidHome, 'auth/credentials.json'), 'utf8'));
    expect(stored.authType).toBe('client_credentials');
    expect(stored.webId).toBe(account!.webId);

    const body = 'private CLI process restoration evidence';
    const file = path.join(root, 'private.txt');
    await writeFile(file, body);
    const resource = 'cli-private.txt';
    const put = await cli(['put', resource, '--from', file, '--content-type', 'text/plain']);
    expect(put.exitCode).toBe(0);
    expect(put.result.ok).toBe(true);
    const anonymous = await fetch(new URL(resource, account!.podUrl));
    expect([401, 403]).toContain(anonymous.status);
    const restored = await cli(['get', resource]);
    expect(restored.exitCode).toBe(0);
    expect(restored.result).toMatchObject({ ok: true, data: { body } });
    const logout = await cli(['auth', 'logout']);
    expect(logout.exitCode).toBe(0);
    expect(logout.result).toMatchObject({ ok: true, data: { authenticated: false } });
    const denied = await cli(['get', resource]);
    expect(denied.exitCode).toBe(2);
    expect(denied.result).toMatchObject({ ok: false, code: 'auth_required' });
  } finally {
    await stack.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
