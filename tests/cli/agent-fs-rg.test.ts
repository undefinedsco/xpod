import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../helpers/agent-directory/fixtureServer';
import { resolveNativeBinary } from '../../src/cli/agent-fs/native';

const TEST_DATA_ROOT = path.resolve('.test-data/agent-directory-workers');
const ENTRY = path.resolve('src/cli/index.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [ 'ignore', 'pipe', 'pipe' ],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

function runWithStdin(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; stdin: string },
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [ 'pipe', 'pipe', 'pipe' ],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.stdin.end(options.stdin);
  });
}

describe('agent-fs rg wrapper', () => {
  const nativeRg = resolveNativeBinary('rg', process.env);
  let fixtureDir: string;
  let server: FixtureServer;
  let deniedServer: FixtureServer;

  beforeAll(async () => {
    if (!nativeRg) {
      throw new Error('native rg is required for the differential suite');
    }
    await mkdir(TEST_DATA_ROOT, { recursive: true });
    fixtureDir = await mkdtemp(path.join(TEST_DATA_ROOT, 'rg-'));
    await mkdir(path.join(fixtureDir, 'sub'), { recursive: true });
    await writeFile(path.join(fixtureDir, 'a.txt'), 'alpha beta\nGAMMA\nbeta beta\n');
    await writeFile(path.join(fixtureDir, 'sub', 'b.txt'), 'nothing here\n');
    await writeFile(path.join(fixtureDir, 'notes.md'), 'beta in markdown\n');
    await writeFile(path.join(fixtureDir, 'secret.txt'), 'unique-secret-token\n');
    server = await startFixtureServer({ fixtureDir });
    deniedServer = await startFixtureServer({ fixtureDir, deniedPaths: [ 'secret.txt' ] });
  });

  afterAll(async () => {
    await server?.close();
    await deniedServer?.close();
    if (fixtureDir) {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  function wrapperEnv(podRoot: string): NodeJS.ProcessEnv {
    return {
      XPOD_AGENT_FS_ACCESS_TOKEN: 'test-token',
      XPOD_AGENT_FS_ROOTS: JSON.stringify([{ localPath: fixtureDir, podRoot } ]),
      XPOD_AGENT_FS_NATIVE_RG: nativeRg,
      XPOD_AGENT_FS_WRAPPER_DIR: '',
    };
  }

  async function runWrapper(args: string[], podRoot: string): Promise<RunResult> {
    return run('bun', [ ENTRY, 'agent-fs', 'rg', ...args ], {
      cwd: fixtureDir,
      env: wrapperEnv(podRoot),
    });
  }

  it('matches native rg --files exactly', async () => {
    const args = [ '--no-ignore', '--sort', 'path', '--files', '.' ];
    const [ native, managed ] = await Promise.all([
      run(nativeRg as string, args, { cwd: fixtureDir }),
      runWrapper(args, server.podRoot),
    ]);
    expect(managed.stdout).toBe(native.stdout);
    expect(managed.stderr).toBe('');
    expect(managed.code).toBe(native.code);
  });

  it('matches native fixed-string search exactly', async () => {
    const args = [ '-F', '-n', '--no-ignore', '--sort', 'path', 'beta', '.' ];
    const [ native, managed ] = await Promise.all([
      run(nativeRg as string, args, { cwd: fixtureDir }),
      runWrapper(args, server.podRoot),
    ]);
    expect(managed.stdout).toBe(native.stdout);
    expect(managed.stderr).toBe('');
    expect(managed.code).toBe(native.code);
  });

  it('matches native -l and -c output exactly', async () => {
    for (const args of [
      [ '-F', '-l', '--no-ignore', '--sort', 'path', 'beta', '.' ],
      [ '-F', '-c', '--no-ignore', '--sort', 'path', 'beta', '.' ],
    ]) {
      const [ native, managed ] = await Promise.all([
        run(nativeRg as string, args, { cwd: fixtureDir }),
        runWrapper(args, server.podRoot),
      ]);
      expect(managed.stdout).toBe(native.stdout);
      expect(managed.code).toBe(native.code);
    }
  });

  it('falls back to the native binary for regex patterns', async () => {
    const args = [ '--no-ignore', '--sort', 'path', 'b.ta', '.' ];
    const [ native, managed ] = await Promise.all([
      run(nativeRg as string, args, { cwd: fixtureDir }),
      runWrapper(args, server.podRoot),
    ]);
    expect(managed.stdout).toBe(native.stdout);
    expect(managed.stderr).toBe(native.stderr);
    expect(managed.code).toBe(native.code);
  });

  it('falls back to the native binary for piped stdin instead of querying the Pod', async () => {
    const args = [ '-F', 'beta' ];
    const [ native, managed ] = await Promise.all([
      runWithStdin(nativeRg as string, args, { cwd: fixtureDir, stdin: 'beta\nnope\n' }),
      runWithStdin('bun', [ ENTRY, 'agent-fs', 'rg', ...args ], {
        cwd: fixtureDir,
        env: wrapperEnv(server.podRoot),
        stdin: 'beta\nnope\n',
      }),
    ]);
    expect(managed.stdout).toBe(native.stdout);
    expect(managed.code).toBe(native.code);
  });

  it('never leaks resources denied by per-resource authorization', async () => {
    const args = [ '-F', '--no-ignore', '--sort', 'path', 'unique-secret-token', '.' ];
    const native = await run(nativeRg as string, args, { cwd: fixtureDir });
    const managed = await runWrapper(args, deniedServer.podRoot);
    expect(native.code).toBe(0);
    expect(native.stdout).toContain('secret.txt');
    expect(managed.stdout).toBe('');
    expect(managed.stdout).not.toContain('secret');
    expect(managed.code).toBe(1);
  });

  it('excludes denied paths from --files enumeration', async () => {
    const args = [ '--no-ignore', '--sort', 'path', '--files', '.' ];
    const managed = await runWrapper(args, deniedServer.podRoot);
    expect(managed.stdout).not.toContain('secret.txt');
    expect(managed.code).toBe(0);
  });
});
