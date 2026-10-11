import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Source-bound mounted-platform admission driver.
 *
 * The INSTALLED consumer runs under an explicit Node 22.21.1 absolute path on a
 * consumer PATH that is PROVEN not to resolve Bun (`command -v bun` empty); the
 * harness itself may use Bun by absolute path but never inherits it. Every exit
 * path — success or throw — writes a receipt with the actual exit/signal,
 * closed-raw SHA and the Node version/binary SHA.
 */
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const sha256File = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

function bunReachableOn(p: string): boolean {
  const out = execFileSync('/bin/sh', [ '-c', 'command -v bun || true' ], { env: { PATH: p }, encoding: 'utf8' }).trim();
  return out.length > 0;
}

type ChildFact = { state: 'closed' | 'spawn-error' | 'pending'; code: number | null; signal: string | null };

/**
 * Group-absence probe: ONLY ESRCH proves the owned group is absent. A successful
 * kill(0) means it still exists; EPERM or any other error is UNKNOWN (never
 * absent) and must never be recorded as a green.
 */
export function probeOwnedGroup(pgid: number | undefined): 'absent' | 'present' | 'unknown' {
  if (process.platform === 'win32' || pgid === undefined) return 'absent';
  try { process.kill(-pgid, 0); return 'present'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unknown'; }
}

/** Same errno classification as the production probe, for injectable tests. */
export function classifyProbeError(error: unknown): 'absent' | 'unknown' {
  return (error as NodeJS.ErrnoException)?.code === 'ESRCH' ? 'absent' : 'unknown';
}

/**
 * The SIX actual cases that MUST be observed PASSED for a mounted success:
 * four from the matrix and two from the original overlay scenario. A summary
 * count alone is insufficient — a real mounted case could silently skip.
 */
export const REQUIRED_MOUNTED_CASES = [
  'passes the original mounted harness for the platform backend',
  'consumes mounted content through ordinary shell, PATH rg and Git with host-local metadata and a mounted worktree',
  'streams disk-backed 64/512/1024 MiB remote bodies with Range, in-place copy-up and sampled helper RSS',
  'interrupts a genuinely in-flight remote copy-up, then recovers the same session and GCs the orphan partial',
  'keeps uncommitted edits local, recovers them across restart, then writes back on commit',
  'keeps a 412 conflict dirty and preserves the first baseline',
] as const;

interface VitestJsonReport {
  numPassedTests?: number;
  numTotalTests?: number;
  numFailedTests?: number;
  testResults?: {
    name?: string;
    status?: string;
    message?: string;
    assertionResults?: { title?: string; fullName?: string; status?: string; failureMessages?: string[] }[];
  }[];
}

/**
 * Bounded suite/assertion failure text from the JSON report, so a setup/hook
 * exception (empty assertion statuses) is still recorded in the receipt even if
 * the human reporter output is unavailable. Trimmed and length-capped.
 */
export function failureTextFromReport(reportJson: string, maxChars = 4000): string {
  try {
    const report = JSON.parse(reportJson) as VitestJsonReport;
    const parts: string[] = [];
    for (const file of report.testResults ?? []) {
      if (file.status && file.status !== 'passed' && typeof file.message === 'string' && file.message.trim()) {
        parts.push(`${file.name ?? 'file'}: ${file.message.trim()}`);
      }
      for (const assertion of file.assertionResults ?? []) {
        for (const message of assertion.failureMessages ?? []) {
          if (message.trim()) parts.push(`${assertion.title ?? 'case'}: ${message.trim()}`);
        }
      }
    }
    return parts.join('\n').slice(0, maxChars);
  } catch { return ''; }
}

/** Real passed-test count from the SAME JSON report (text summary is absent under --reporter=json). */
export function passedCountFromReport(reportJson: string): number | undefined {
  try {
    const report = JSON.parse(reportJson) as VitestJsonReport;
    if (Array.isArray(report.testResults)) {
      return report.testResults.flatMap((file) => file.assertionResults ?? []).filter((assertion) => assertion.status === 'passed').length;
    }
  } catch { /* ignore */ }
  return undefined;
}

/**
 * Parse a real Vitest JSON report and return, for each required case, whether it
 * was actually EXECUTED and PASSED. Missing/skipped/failed required cases are
 * not satisfied; unrelated informational skips are allowed.
 */
export function evaluateRequiredMountedCases(reportJson: string, requiredTitles: readonly string[] = REQUIRED_MOUNTED_CASES): {
  satisfied: boolean;
  missing: string[];
  notPassed: { title: string; status: string }[];
} {
  let report: VitestJsonReport;
  try { report = JSON.parse(reportJson) as VitestJsonReport; }
  catch { return { satisfied: false, missing: [ ...requiredTitles ], notPassed: [] }; }
  const statusByTitle = new Map<string, string>();
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      const key = assertion.title ?? assertion.fullName ?? '';
      if (key) statusByTitle.set(key, assertion.status ?? 'unknown');
    }
  }
  const missing: string[] = [];
  const notPassed: { title: string; status: string }[] = [];
  for (const required of requiredTitles) {
    const status = statusByTitle.get(required);
    if (status === undefined) missing.push(required);
    else if (status !== 'passed') notPassed.push({ title: required, status });
  }
  return { satisfied: missing.length === 0 && notPassed.length === 0, missing, notPassed };
}

/**
 * Finite reap of the owned process group: if not already absent, signal the
 * group, then poll to `deadlineMs`; 'unknown' (e.g. EPERM) is never absent.
 * Returns the final absence fact.
 */
export function reapOwnedGroup(
  pgid: number | undefined,
  deadlineMs: number,
  signalGroup: (pgid: number) => void = (id) => { try { process.kill(-id, 'SIGKILL'); } catch { /* gone */ } },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  probe: (pgid: number | undefined) => 'absent' | 'present' | 'unknown' = probeOwnedGroup,
): Promise<boolean> {
  if (probe(pgid) === 'absent') return Promise.resolve(true);
  if (pgid !== undefined) signalGroup(pgid);
  return (async () => {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (probe(pgid) === 'absent') return true;
      // 'present'/'unknown' both keep polling; only ESRCH-absent returns true.
      await sleep(100);
    }
    return probe(pgid) === 'absent';
  })();
}

/** Exit and stdio close are distinct: descendants can keep a dead parent's pipes open. */
export function observeChildLifecycle(child: ReturnType<typeof spawn>) {
  let exitObserved = false; let exit: number | null = null; let signal: string | null = null;
  let closeObserved = false;
  const exited = new Promise<'exited'>((resolve) => child.once('exit', (code, sig) => {
    exitObserved = true; exit = code; signal = sig; resolve('exited');
  }));
  const closed = new Promise<ChildFact>((resolve) => child.once('close', (code, sig) => {
    closeObserved = true; resolve({ state: 'closed', code, signal: sig });
  }));
  const failed = new Promise<ChildFact>((resolve) => child.once('error', () => resolve({ state: 'spawn-error', code: null, signal: null })));
  const bounded = async <T>(promises: Promise<T>[], timeoutMs: number, fallback: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([ ...promises, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }) ]); }
    finally { if (timer) clearTimeout(timer); }
  };
  return {
    facts: () => ({ pid: child.pid, exitObserved, exit, signal, closeObserved }),
    wait: async (timeoutMs: number, closeBudgetMs = 15_000): Promise<ChildFact> => {
      const pending: ChildFact = { state: 'pending', code: null, signal: null };
      const result = await bounded<ChildFact | 'exited'>([ closed, failed, exited ], timeoutMs, pending);
      return result === 'exited' ? bounded([ closed, failed ], closeBudgetMs, pending) : result;
    },
    waitClose: (timeoutMs: number): Promise<ChildFact> => bounded([ closed, failed ], timeoutMs, { state: 'pending', code: null, signal: null }),
  };
}

function ownedProcessSnapshot(pgid: number | undefined, phase: string): Record<string, unknown> {
  if (pgid === undefined) return { phase, known: false, members: [], reason: 'no-owned-pgid' };
  try {
    const raw = execFileSync('/bin/ps', [ '-axo', 'pid=,ppid=,pgid=,state=' ], { encoding: 'utf8', timeout: 5000 });
    const members = raw.trim().split('\n').map((line) => line.trim().split(/\s+/)).filter((fields) => Number(fields[2]) === pgid)
      .map(([ pid, ppid, group, state ]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(group), state }));
    return { phase, known: true, members };
  } catch (error) { return { phase, known: false, members: [], reason: String((error as NodeJS.ErrnoException).code ?? 'process-observation-failed') }; }
}

let evidenceDir = ''; let os = ''; let rawPath = ''; const rawChunks: Buffer[] = []; let lastSummary = '';
// Real lifecycle facts; actualWait/rawClosedBeforeHash are never hard-coded.
// rawClosed is true ONLY when the producer actually closed AND the raw bytes
// were actually flushed to disk (rawFinished). A pending snapshot is not closed.
let started = false; let closedFact = false; let rawFinished = false; let exitCode: number | null = null; let exitSignal: string | null = null;
// Owned process-group absence is tracked separately from the direct child close.
let groupAbsent = true;
function writeReceipt(extra: Record<string, unknown>): boolean {
  if (!evidenceDir || !os) return false;
  try {
    const raw = Buffer.concat(rawChunks);
    if (raw.length && !rawFinished) {
      writeFileSync(rawPath, raw, { mode: 0o600 });
      chmodSync(rawPath, 0o600);
      rawFinished = true; // actual bytes flushed; never inferred from existsSync
    }
    const rawClosedBeforeHash = closedFact && rawFinished && groupAbsent;
    const receipt = { schemaVersion: 1, os, producerStarted: started, producerClosed: closedFact,
      actualWait: started && closedFact, rawClosedBeforeHash,
      exit: exitCode, signal: exitSignal, ownedGroupAbsent: groupAbsent, ...extra };
    const receiptPath = path.join(evidenceDir, `mounted-${os}.receipt.json`);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    chmodSync(receiptPath, 0o600);
    return true;
  } catch { return false; }
}

export interface InstalledMountedProduct {
  helper: string; launcher: string; helperSha256: string; launcherSha256: string;
  entry: string; entrySha256: string;
  env: NodeJS.ProcessEnv;
  binding: Record<string, unknown>;
  additionalTests: string[]; additionalRequiredCases: string[];
}

export async function runMountedPlatformAdmission(product?: InstalledMountedProduct): Promise<number> {
  rawChunks.length = 0; lastSummary = ''; started = false; closedFact = false; rawFinished = false;
  exitCode = null; exitSignal = null; groupAbsent = true;
  const archive = required('XPOD_MOUNTED_ARCHIVE');
  const archiveSha = required('XPOD_MOUNTED_ARCHIVE_SHA');
  const helperSha = required('XPOD_MOUNTED_HELPER_SHA');
  const workspace = required('XPOD_MOUNTED_WORKSPACE');
  const backend = process.env.XPOD_MOUNTED_BACKEND ?? 'nfs';
  const node = required('XPOD_MOUNTED_NODE');
  const minPassed = Number(process.env.XPOD_MOUNTED_MIN_PASSED ?? '2');
  evidenceDir = required('XPOD_MOUNTED_EVIDENCE'); os = required('XPOD_MOUNTED_OS');
  if (![ 'linux', 'darwin' ].includes(os) || process.platform !== os) throw new Error(`mounted os mismatch: ${os} vs ${process.platform}`);
  const arch = process.env.XPOD_MOUNTED_ARCH ?? 'arm64';
  if (!['arm64', 'x64'].includes(arch) || process.arch !== arch) throw new Error(`mounted architecture mismatch: ${arch} vs ${process.arch}`);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  rawPath = path.join(evidenceDir, `mounted-${os}.raw.log`);

  const runnerSha = sha256File(path.join(workspace, 'scripts/agentfs-native-ci/mounted/platform-admission.ts'));
  if (!existsSync(node)) throw new Error(`XPOD_MOUNTED_NODE not found: ${node}`);
  const nodeVersion = execFileSync(node, [ '--version' ], { encoding: 'utf8' }).trim();
  if (!/^v22\.21\.1$/.test(nodeVersion)) throw new Error(`XPOD_MOUNTED_NODE must be exactly v22.21.1, got ${nodeVersion}`);
  const nodeSha256 = sha256File(node);

  if (sha256File(archive) !== archiveSha) throw new Error('product archive digest mismatch');
  // Extract OUTSIDE the uploaded evidence dir so the full 70 MB distribution
  // package is never duplicated into the evidence artifact; only raw/receipts
  // are uploaded and the product identity is carried by SHA references.
  const install = path.join(path.dirname(evidenceDir), `mounted-${os}-install`);
  if (!product) {
    mkdirSync(install, { recursive: true, mode: 0o700 });
    execFileSync('tar', [ '-xzf', archive, '-C', install ]);
  }
  const helper = product?.helper ?? path.join(install, 'install', 'helper', 'agentfs-pod');
  const launcher = product?.launcher ?? path.join(install, 'install', 'bin', 'xpodcli');
  if (!existsSync(helper) || !existsSync(launcher)) throw new Error('installed archive lacks helper or launcher');
  if (sha256File(helper) !== helperSha) throw new Error('installed helper digest mismatch');
  if (product && (helperSha !== product.helperSha256 || sha256File(launcher) !== product.launcherSha256
    || sha256File(product.entry) !== product.entrySha256)) throw new Error('installed module handoff digest mismatch');

  const nativeRg = execFileSync('/bin/sh', [ '-c', 'command -v rg' ], { encoding: 'utf8' }).trim();
  if (!path.isAbsolute(nativeRg) || !existsSync(nativeRg)) throw new Error('actual native rg is unavailable');
  const nativeRgVersion = execFileSync(nativeRg, [ '--version' ], { encoding: 'utf8' }).trim();
  const nativeRgSha256 = sha256File(nativeRg);

  // Consumer PATH: drop every dir that contains a bun executable, then PROVE
  // bun is unreachable from the consumer environment.
  const filtered = (process.env.PATH ?? '').split(':').filter(Boolean).filter((dir) => {
    try { return !existsSync(path.join(dir, 'bun')) && !existsSync(path.join(dir, 'bun.exe')); } catch { return true; }
  });
  const acceptancePath = [ path.dirname(node), ...filtered ].join(':');
  const bunVisible = bunReachableOn(acceptancePath);
  if (process.env.XPOD_MOUNTED_REQUIRE_NOBUN === '1' && bunVisible) throw new Error('consumer PATH still resolves bun');

  const env: NodeJS.ProcessEnv = {
    ...(product ? product.env : process.env), PATH: acceptancePath, XPOD_AGENT_FS_NATIVE_RG: nativeRg,
    XPOD_AGENTFS_HELPER: helper, XPOD_AGENTFS_TEST_CLI: launcher,
    XPOD_AGENTFS_RUN_OVERLAY: '1', XPOD_MOUNTED_BACKEND: backend, XPOD_MOUNTED_OS: os,
  };
  const vitest = path.join(workspace, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitest)) throw new Error('harness dependency tree is missing (node_modules/vitest)');
  // Spawn in a NEW process group where POSIX supports it, so a timeout/cleanup
  // can terminate the WHOLE owned group (workers/helpers), not only the direct
  // Vitest PID. The close promise is attached at birth, before any signal.
  // A real Vitest JSON report lets the driver require the SIX named actual
  // mounted cases to be EXECUTED and PASSED (a summary count could skip them).
  // ALSO keep the human (default) reporter on stdout so an actual setup/hook or
  // test exception is preserved in the closed raw; --reporter=json alone loses it.
  const reportPath = path.join(evidenceDir, `mounted-${os}.vitest-report.json`);
  const child = spawn(node, [ vitest, 'run',
    'tests/agentfs-pod/nativeMountedPlatformMatrix.test.ts',
    'tests/agentfs-pod/nativeOverlayScenario.test.ts',
    ...(product?.additionalTests ?? []),
    '--no-file-parallelism',
    '--reporter=default',
    '--reporter=json', `--outputFile=${reportPath}` ], { cwd: workspace, env, stdio: [ 'ignore', 'pipe', 'pipe' ], detached: process.platform !== 'win32' });
  started = true; // actual spawn was requested; spawn-error is tracked separately
  const lifecycle = observeChildLifecycle(child);
  const processObservations = [ ownedProcessSnapshot(child.pid, 'after-spawn') ];
  child.stdout?.on('data', (chunk: Buffer) => rawChunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => rawChunks.push(chunk));
  const fact = await lifecycle.wait(3_600_000);
  processObservations.push(ownedProcessSnapshot(child.pid, 'after-first-wait'));
  let actualFact = fact;
  const pgid = child.pid;
  if (fact.state !== 'closed' && child.pid !== undefined) {
    // Signal the owned group AND also the direct child (belt + braces), then poll.
    groupAbsent = await reapOwnedGroup(pgid, 15_000, (id) => { try { process.kill(-id, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } });
    actualFact = await lifecycle.waitClose(15_000);
  } else if (process.platform !== 'win32' && child.pid !== undefined) {
    // The direct child closed, but an owned descendant in the group may remain.
    groupAbsent = await reapOwnedGroup(pgid, 15_000);
  } else { groupAbsent = true; }
  processObservations.push(ownedProcessSnapshot(child.pid, 'after-owned-reap'));
  closedFact = actualFact.state === 'closed';
  exitCode = actualFact.code; exitSignal = actualFact.signal;
  const producerState = actualFact.state;
  // Flush the actual raw once, after the actual wait. writeReceipt marks
  // rawFinished only on this real write; a pending snapshot never claims closed.
  const raw = Buffer.concat(rawChunks);
  if (raw.length) { writeFileSync(rawPath, raw, { mode: 0o600 }); chmodSync(rawPath, 0o600); rawFinished = true; }
  const sealed = closedFact && groupAbsent;
  const text = sealed ? raw.toString('utf8') : '';
  // Bounded, safe CI projection of the harness output (no product secrets here;
  // this is test/helper diagnostics only) so the failure is visible without
  // downloading the evidence artifact.
  lastSummary = text.split('\n').filter((line) => /Test Files|Tests |skipped|FAIL|Error|helper|fuse|nfs|blocker|prerequisite/i.test(line)).slice(-30).join('\n').slice(0, 4000);
  const passed = Number((/Tests\s+(\d+)\s+passed/u.exec(text) ?? [])[1] ?? 0);
  const allSkipped = /Test Files\s+.*skipped/u.test(text) && passed === 0;
  // SUCCESS requires the owned process group to be REALLY absent, not merely the
  // direct child closed. A present or unknown group is a red (false-success guard).
  const groupResolved = groupAbsent === true;
  // Require the SIX named actual mounted cases to be PASSED from the real report.
  let reportSha: string | null = null;
  const requiredTitles = [...REQUIRED_MOUNTED_CASES, ...(product?.additionalRequiredCases ?? [])];
  let requiredCases: { satisfied: boolean; missing: string[]; notPassed: { title: string; status: string }[] } =
    { satisfied: false, missing: [ ...requiredTitles ], notPassed: [] };
  // Under --reporter=json the human "Tests N passed" line is suppressed, so the
  // real count MUST come from passed assertions in the SAME report, not summary totals.
  let reportPassed: number | undefined;
  let reportFailureText = '';
  try {
    if (!sealed) throw new Error('producer raw closure or group absence unresolved');
    const reportBytes = readFileSync(reportPath);
    reportSha = createHash('sha256').update(reportBytes).digest('hex');
    const reportText = reportBytes.toString('utf8');
    requiredCases = evaluateRequiredMountedCases(reportText, requiredTitles);
    reportPassed = passedCountFromReport(reportText);
    reportFailureText = failureTextFromReport(reportText);
  } catch { /* report absent: required cases unsatisfied */ }
  const effectivePassed = reportPassed ?? passed; // report is authoritative for the gate
  const ok = actualFact.state === 'closed' && actualFact.code === 0 && actualFact.signal === null
    && effectivePassed >= minPassed && groupResolved && requiredCases.satisfied;
  const reason = ok ? null
    : actualFact.state !== 'closed' ? actualFact.state
    : actualFact.signal ? 'signal'
    : effectivePassed < minPassed ? 'insufficient-passed-cases'
    : allSkipped ? 'all-cases-skipped'
    : !groupResolved ? 'owned-group-not-absent'
    : !requiredCases.satisfied ? 'required-mounted-cases-not-passed'
    : 'failed';
  const persisted = writeReceipt({
    backend, nodePath: node, nodeVersion, nodeSha256, nativeRg, nativeRgVersion, nativeRgSha256,
    productArchiveSha256: archiveSha, installedHelperSha256: helperSha, installedLauncherPath: launcher,
    ...(product ? { moduleBinding: product.binding } : {}),
    harnessRunnerSha256: runnerSha, consumerBunVisible: bunVisible, passedCases: effectivePassed, minPassedCases: minPassed,
    producerState, producerLifecycle: lifecycle.facts(), ownedProcessObservations: processObservations, rawLog: rawPath,
    rawSHA256: sealed ? createHash('sha256').update(raw).digest('hex') : null,
    snapshotSHA256: sealed ? null : createHash('sha256').update(raw).digest('hex'), status: ok ? 'ok' : 'failed', failureReason: reason,
    mountExecuted: ok,
    vitestReport: reportSha ? { path: reportPath, sha256: reportSha, requiredCases: requiredTitles,
      requiredSatisfied: requiredCases.satisfied, missingRequired: requiredCases.missing, notPassed: requiredCases.notPassed,
      failureText: reportFailureText } : null,
  });
  if (!persisted) { process.stderr.write('{"stage":"platform-admission","errorClass":"receipt-persist-failed"}\n'); process.exit(72); }
  if (!ok && lastSummary) process.stderr.write(`mounted-harness-summary:\n${lastSummary}\n`);
  process.stdout.write(`${JSON.stringify({ status: ok ? 'ok' : 'failed', os, backend, nodeVersion, passedCases: effectivePassed, producerState })}\n`);
  return ok ? 0 : 1;
}

// Execute ONLY when run as the entry point. Cross-runtime ESM guard (works under
// Bun and Node22 --experimental-strip-types, where `require` is not defined).
export function isEntryPoint(): boolean {
  // A bundled module-admission entry also contains this module's import.meta.
  // Its distinct entry name must not launch the legacy driver a second time.
  try { return /^platform-admission\.(?:ts|mjs)$/.test(path.basename(process.argv[1] ?? ''))
    && fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? ''); }
  catch { return false; }
}
if (isEntryPoint()) {
  runMountedPlatformAdmission().then(code => { process.exitCode = code; }).catch((error: unknown) => {
    const persisted = writeReceipt({ status: 'failed', failureReason: 'preflight', message: String((error as Error).message) });
    if (lastSummary) process.stderr.write(`mounted-harness-summary:\n${lastSummary}\n`);
    process.stderr.write(`${JSON.stringify({ stage: 'platform-admission', errorClass: 'failed', message: String((error as Error).message) })}\n`);
    process.exit(persisted ? 70 : 72);
  });
}
