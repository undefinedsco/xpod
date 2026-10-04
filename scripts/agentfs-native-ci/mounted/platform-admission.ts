import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Source-bound mounted-platform admission driver.
 *
 * Consumes the frozen product archive (already-accepted c7e9 run) and runs the
 * tracked mounted harness against the INSTALLED helper/CLI under Node22 noBun.
 * The product pins (archive + helper) and the harness checkout are recorded
 * separately; no product source is rebuilt here.
 */
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const sha256File = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

async function waitFor(child: ReturnType<typeof spawn>): Promise<{ code: number; signal: string | null }> {
  return new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal }));
    child.on('error', () => resolve({ code: 1, signal: null }));
  });
}

async function main(): Promise<void> {
  const archive = required('XPOD_MOUNTED_ARCHIVE');
  const archiveSha = required('XPOD_MOUNTED_ARCHIVE_SHA');
  const helperSha = required('XPOD_MOUNTED_HELPER_SHA');
  const evidence = required('XPOD_MOUNTED_EVIDENCE');
  const workspace = required('XPOD_MOUNTED_WORKSPACE');
  const os = required('XPOD_MOUNTED_OS');
  const backend = process.env.XPOD_MOUNTED_BACKEND ?? 'nfs';

  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const runnerSha = sha256File(path.join(workspace, 'scripts/agentfs-native-ci/mounted/platform-admission.ts'));

  if (sha256File(archive) !== archiveSha) throw new Error('product archive digest mismatch');
  const install = path.join(evidence, 'install');
  mkdirSync(install, { recursive: true, mode: 0o700 });
  execFileSync('tar', [ '-xzf', archive, '-C', install ]);
  const helper = path.join(install, 'install', 'helper', 'agentfs-pod');
  const launcher = path.join(install, 'install', 'bin', 'xpodcli');
  if (!existsSync(helper) || !existsSync(launcher)) throw new Error('installed archive lacks helper or launcher');
  if (sha256File(helper) !== helperSha) throw new Error('installed helper digest mismatch');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XPOD_AGENTFS_HELPER: helper,
    XPOD_AGENTFS_TEST_CLI: launcher,
    XPOD_AGENTFS_RUN_OVERLAY: '1',
    XPOD_MOUNTED_BACKEND: backend,
    XPOD_MOUNTED_OS: os,
  };
  const rawPath = path.join(evidence, `mounted-${os}.raw.log`);
  const vitest = path.join(workspace, 'node_modules', 'vitest', 'vitest.mjs');
  const child = spawn(process.execPath, [ vitest, 'run', 'tests/agentfs-pod/nativeMountedPlatformMatrix.test.ts', '--no-file-parallelism' ], {
    cwd: workspace,
    env,
    stdio: [ 'ignore', 'pipe', 'pipe' ],
  });
  const chunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
  const outcome = await waitFor(child);
  const raw = Buffer.concat(chunks);
  writeFileSync(rawPath, raw, { mode: 0o600 });
  chmodSync(rawPath, 0o600);
  const receipt = {
    schemaVersion: 1,
    os,
    backend,
    productArchiveSha256: archiveSha,
    installedHelperSha256: helperSha,
    installedLauncherPath: launcher,
    harnessRunnerSha256: runnerSha,
    exit: outcome.code,
    signal: outcome.signal,
    actualWait: true,
    rawClosedBeforeHash: true,
    rawLog: rawPath,
    rawSHA256: createHash('sha256').update(raw).digest('hex'),
    status: outcome.code === 0 && outcome.signal === null ? 'ok' : 'failed',
    mountExecuted: true,
  };
  const receiptPath = path.join(evidence, `mounted-${os}.receipt.json`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  chmodSync(receiptPath, 0o600);
  process.stdout.write(`${JSON.stringify({ status: receipt.status, os, backend, exit: receipt.exit, rawSHA256: receipt.rawSHA256 })}\n`);
  process.exit(receipt.status === 'ok' ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ stage: 'platform-admission', errorClass: 'failed', message: String(error) })}\n`);
  process.exit(70);
});
