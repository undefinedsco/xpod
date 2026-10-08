import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { AgentFsHelper } from './helperDiscovery';
import type { PodContractServer } from './podContractServer';

export interface BackendCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RustBackendReport {
  status: 'pass' | 'fail' | 'unavailable';
  checks: BackendCheck[];
  notes: string[];
}

/**
 * The AgentFS-linked helper does not expose per-operation `fs` subcommands; it
 * exposes `status|mount|unmount|commit|selftest`. `selftest` runs against the
 * helper's OWN in-process fixture and therefore cannot prove the external HTTP
 * contract. This harness drives the real CLI against an EXTERNAL recording Pod
 * fixture (a separate HTTP server) and asserts the helper actually contacted it.
 * Full FileSystem/File verification is done by the mount harness.
 */
export const RUST_BACKEND_CLI = [
  'agentfs-pod status --json (XPOD_AGENTFS_SERVER=<external fixture>, XPOD_AGENTFS_TOKEN=...)',
  'agentfs-pod mount --server <external fixture> --mountpoint <dir> --backend nfs',
  'agentfs-pod unmount --mountpoint <dir>',
  'agentfs-pod commit --pod-root <external fixture> [--session-dir <dir>]',
  'NOTE: `agentfs-pod selftest` uses an in-process fixture and is NOT independent evidence.',
];

interface ExecResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runCli(binary: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { env: { ...process.env, ...env }, stdio: [ 'ignore', 'pipe', 'pipe' ] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr: stderr || error.message, timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr, timedOut });
    });
  });
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export async function probeRustBackend(
  helper: AgentFsHelper,
  server: PodContractServer,
  token: string,
  workDir: string,
): Promise<RustBackendReport> {
  const checks: BackendCheck[] = [];
  const notes: string[] = [];
  const binary = helper.helperPath;

  if (!binary) {
    return {
      status: 'unavailable',
      checks: [],
      notes: [ 'no AgentFS-linked helper binary; run the mount harness once it exists' ],
    };
  }

  mkdirSync(workDir, { recursive: true });

  server.resetLog();
  const status = await runCli(binary, [ 'status', '--json' ], {
    XPOD_AGENTFS_SERVER: server.podRoot,
    XPOD_AGENTFS_TOKEN: token,
  });
  const payload = parseJson(status.stdout) as { reachable?: boolean; server?: string } | undefined;
  const externalRequests = server.log.filter((entry) => entry.path.startsWith('/pod') || entry.path.startsWith('/-/'));
  checks.push({
    name: 'status-exit',
    ok: status.status === 0 && !status.timedOut,
    detail: `exit=${status.status} signal=${status.signal ?? '-'} timedOut=${status.timedOut} stderr=${status.stderr.trim().slice(0, 160)}`,
  });
  checks.push({
    name: 'status-reachable-external-fixture',
    ok: payload?.reachable === true,
    detail: `reachable=${payload?.reachable} server=${payload?.server ?? '-'}`,
  });
  checks.push({
    name: 'external-fixture-received-request',
    ok: externalRequests.length > 0,
    detail: `externalRequests=${externalRequests.map((entry) => `${entry.method} ${entry.path}`).join(',')}`,
  });
  notes.push('per-operation fs subcommands are not implemented; FileSystem/File behavior is verified by the mount harness against this same external fixture');
  notes.push('agentfs-pod selftest is not used as evidence because it targets an in-process fixture');

  return {
    status: checks.every((check) => check.ok) ? 'pass' : 'fail',
    checks,
    notes,
  };
}
