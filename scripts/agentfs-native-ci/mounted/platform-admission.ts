import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Source-bound mounted-platform admission driver.
 *
 * Consumes the frozen product archive (already-accepted c7e9 run) and runs the
 * tracked mounted harness against the INSTALLED helper/CLI. The consumer runs
 * under an EXPLICIT Node22 absolute path (never process.execPath, which is Bun
 * when this file is launched by Bun); the product pins (archive + helper) and
 * the harness checkout are recorded separately; no product source is rebuilt.
 * A missing helper / all-skipped run / zero executed cases is a preflight
 * failure, never a pass.
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
  const node = required('XPOD_MOUNTED_NODE');
  const minPassed = Number(process.env.XPOD_MOUNTED_MIN_PASSED ?? '2');

  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const runnerSha = sha256File(path.join(workspace, 'scripts/agentfs-native-ci/mounted/platform-admission.ts'));

  // Explicit Node22 identity, never the launcher runtime of this file.
  if (!existsSync(node)) throw new Error(`XPOD_MOUNTED_NODE not found: ${node}`);
  const nodeVersion = execFileSync(node, [ '--version' ], { encoding: 'utf8' }).trim();
  if (!/^v22\./.test(nodeVersion)) throw new Error(`XPOD_MOUNTED_NODE must be a Node 22 runtime, got ${nodeVersion}`);

  if (sha256File(archive) !== archiveSha) throw new Error('product archive digest mismatch');
  const install = path.join(evidence, 'install');
  mkdirSync(install, { recursive: true, mode: 0o700 });
  execFileSync('tar', [ '-xzf', archive, '-C', install ]);
  const helper = path.join(install, 'install', 'helper', 'agentfs-pod');
  const launcher = path.join(install, 'install', 'bin', 'xpodcli');
  if (!existsSync(helper) || !existsSync(launcher)) throw new Error('installed archive lacks helper or launcher');
  if (sha256File(helper) !== helperSha) throw new Error('installed helper digest mismatch');

  // Consumer identity: noBun on the acceptance PATH (the harness itself may use
  // Bun, but the INSTALLED CLI consumer must resolve under Node22).
  const acceptancePath = `${path.dirname(node)}:${process.env.PATH ?? ''}`;
  if (process.env.XPOD_MOUNTED_REQUIRE_NOBUN === '1' && /(^|:)[^:]*\/bun(\.exe)?(:|$)/.test(acceptancePath)) {
    throw new Error('consumer acceptance PATH unexpectedly contains bun');
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: acceptancePath,
    XPOD_AGENTFS_HELPER: helper,
    XPOD_AGENTFS_TEST_CLI: launcher,
    XPOD_AGENTFS_RUN_OVERLAY: '1',
    XPOD_MOUNTED_BACKEND: backend,
    XPOD_MOUNTED_OS: os,
  };
  const rawPath = path.join(evidence, `mounted-${os}.raw.log`);
  const vitest = path.join(workspace, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitest)) throw new Error('harness dependency tree is missing (node_modules/vitest)');
  const child = spawn(node, [ vitest, 'run', 'tests/agentfs-pod/nativeMountedPlatformMatrix.test.ts', '--no-file-parallelism' ], {
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

  // Preflight accounting from the actual closed vitest output.
  const text = raw.toString('utf8');
  const passed = Number((/Tests\s+(\d+)\s+passed/u.exec(text) ?? [])[1] ?? 0);
  const skippedAll = /Test Files\s+.*skipped/u.test(text) && passed === 0;
  const executed = outcome.code === 0 && outcome.signal === null && passed >= minPassed;
  if (!executed) {
    const reason = skippedAll ? 'all-cases-skipped' : outcome.signal ? 'signal' : passed < minPassed ? 'insufficient-passed-cases' : 'failed';
    throw Object.assign(new Error(`mounted preflight failed: ${reason} (passed=${passed}, min=${minPassed})`), { raw, rawPath });
  }

  const receipt = {
    schemaVersion: 1,
    os,
    backend,
    nodePath: node,
    nodeVersion,
    productArchiveSha256: archiveSha,
    installedHelperSha256: helperSha,
    installedLauncherPath: launcher,
    harnessRunnerSha256: runnerSha,
    passedCases: passed,
    minPassedCases: minPassed,
    exit: outcome.code,
    signal: outcome.signal,
    actualWait: true,
    rawClosedBeforeHash: true,
    rawLog: rawPath,
    rawSHA256: createHash('sha256').update(raw).digest('hex'),
    status: 'ok',
    mountExecuted: true,
  };
  const receiptPath = path.join(evidence, `mounted-${os}.receipt.json`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  chmodSync(receiptPath, 0o600);
  process.stdout.write(`${JSON.stringify({ status: receipt.status, os, backend, nodeVersion, passedCases: passed, rawSHA256: receipt.rawSHA256 })}\n`);
  process.exit(0);
}

main().catch((error: unknown) => {
  const rawPath = (error as { rawPath?: string }).rawPath;
  process.stderr.write(`${JSON.stringify({ stage: 'platform-admission', errorClass: 'failed', message: String((error as Error).message), rawLog: rawPath ?? null })}\n`);
  process.exit(70);
});
