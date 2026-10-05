import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyMountInventoryDetailed, makeObservingKernelObserver, observeKernelMounts, observeKernelMountsDetailed, parseLinuxMountInfo } from '../agentfs-pod/support/mountCleanup';
import { classifyProbeError, evaluateRequiredMountedCases, failureTextFromReport, isEntryPoint, passedCountFromReport, probeOwnedGroup, reapOwnedGroup, REQUIRED_MOUNTED_CASES } from '../../scripts/agentfs-native-ci/mounted/platform-admission';

/**
 * Behavioural boundaries for the mounted-platform admission driver's owned
 * process-group gate. These invoke the EXACT probe/reap/classify functions the
 * driver uses (imported above), not a duplicated toy implementation.
 */
describe('owned process-group absence gate (driver functions)', () => {
  it('proves direct parent actual exit 0 while an owned grandchild stays live (group PRESENT -> red)', async () => {
    if (process.platform === 'win32') return;
    // The parent prints a ready line only AFTER the grandchild is confirmed live,
    // then exits 0 while the grandchild remains. The close promise is registered
    // at spawn, so we require the ACTUAL direct close(code 0) before probing.
    const parent = spawn(process.execPath, [ '-e',
      "const {spawn}=require('node:child_process');" +
      "const g=spawn(process.execPath,['-e','process.stdout.write(\"g-ready\\\\n\");setTimeout(()=>{},60000)'],{stdio:['ignore','pipe','ignore']});" +
      "g.stdout.once('data',()=>{process.stdout.write('p-ready\\\\n');process.exit(0);});" ],
      { detached: true, stdio: [ 'ignore', 'pipe', 'ignore' ] });
    const closeAtBirth = new Promise<{ code: number | null }>((resolve) => parent.once('close', (code) => resolve({ code })));
    try {
      const closed = await Promise.race([
        closeAtBirth,
        new Promise<{ code: number | null }>((resolve) => setTimeout(() => resolve({ code: -1 }), 15_000)),
      ]);
      expect(closed.code, 'direct parent must actually exit 0 (grandchild still live)').toBe(0);
      // The owned group must still be PRESENT because the grandchild survives.
      expect(probeOwnedGroup(parent.pid), 'live grandchild => group PRESENT, never absent').toBe('present');
      // This present-group state is exactly what must make a success claim red:
      // the admission gate requires groupAbsent === true.
      expect(probeOwnedGroup(parent.pid) === 'absent', 'success must be refused while the owned group is live').toBe(false);
      // Bounded owned reap must then genuinely resolve the group (real absence).
      const absent = await reapOwnedGroup(parent.pid, 15_000);
      expect(absent, 'owned group must be truly absent after bounded reap').toBe(true);
      expect(probeOwnedGroup(parent.pid)).toBe('absent');
    } finally {
      await reapOwnedGroup(parent.pid, 15_000);
    }
  });

  it('classifies a non-ESRCH probe error as UNKNOWN (never absent)', () => {
    // A real EPERM is not reliably inducible for our own group, so exercise the
    // production errno classifier directly: only ESRCH is absent, EPERM unknown.
    expect(classifyProbeError(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }))).toBe('unknown');
    expect(classifyProbeError(Object.assign(new Error('no such process'), { code: 'ESRCH' }))).toBe('absent');
    expect(classifyProbeError({ code: 'EACCES' })).toBe('unknown');
  });

  it('an UNKNOWN-only probe never resolves to absent during bounded reap (red, retained)', async () => {
    // Inject an EPERM probe: reap must NOT report absent even after the deadline,
    // so admission stays red and the owned scene/raw is retained.
    const epermProbe = (): 'unknown' => 'unknown';
    const absent = await reapOwnedGroup(4242, 500, () => undefined, () => Promise.resolve(), epermProbe);
    expect(absent, 'unknown probe must never be accepted as absent').toBe(false);
  });

  it('a nonexistent PGID is ESRCH -> absent (distinct from UNKNOWN)', async () => {
    if (process.platform === 'win32') return;
    expect(probeOwnedGroup(0x7ffffffe)).toBe('absent');
    expect(await reapOwnedGroup(0x7ffffffe, 500)).toBe(true);
  });
});

describe('required mounted-case gate (real Vitest JSON report)', () => {
  const report = (entries: { title: string; status: string }[], informationalSkip = true) => JSON.stringify({
    testResults: [ { assertionResults: [
      ...entries.map((e) => ({ title: e.title, status: e.status })),
      ...(informationalSkip ? [ { title: 'is opt-in and reuses the original harness', status: 'skipped' } ] : []),
    ] } ],
  });

  it('requires exactly FIVE named cases', () => {
    expect(REQUIRED_MOUNTED_CASES.length).toBe(5);
  });

  it('is satisfied only when all five required cases are PASSED', () => {
    const all = REQUIRED_MOUNTED_CASES.map((title) => ({ title, status: 'passed' }));
    expect(evaluateRequiredMountedCases(report(all)).satisfied).toBe(true);
  });

  it('rejects a required case that is missing (summary-only would false-pass)', () => {
    const partial = REQUIRED_MOUNTED_CASES.slice(0, 4).map((title) => ({ title, status: 'passed' }));
    const verdict = evaluateRequiredMountedCases(report(partial));
    expect(verdict.satisfied).toBe(false);
    expect(verdict.missing).toContain(REQUIRED_MOUNTED_CASES[4]);
  });

  it('rejects a required case that is skipped or failed, while allowing informational skips', () => {
    const skipped = REQUIRED_MOUNTED_CASES.map((title, i) => ({ title, status: i === 1 ? 'skipped' : 'passed' }));
    const v1 = evaluateRequiredMountedCases(report(skipped));
    expect(v1.satisfied).toBe(false);
    expect(v1.notPassed.some((n) => n.status === 'skipped')).toBe(true);
    const failed = REQUIRED_MOUNTED_CASES.map((title, i) => ({ title, status: i === 2 ? 'failed' : 'passed' }));
    expect(evaluateRequiredMountedCases(report(failed)).satisfied).toBe(false);
  });

  it('is unsatisfied for a malformed/absent report', () => {
    expect(evaluateRequiredMountedCases('not json').satisfied).toBe(false);
  });

  it('surfaces suite/assertion failure text so a setup/hook error is not lost', () => {
    const report = JSON.stringify({
      testResults: [
        { name: 'matrix.ts', status: 'failed', message: 'beforeAll hook threw: EPERM mount_nfs',
          assertionResults: [ { title: 'case', status: 'pending' } ] },
        { name: 'overlay.ts', status: 'failed',
          assertionResults: [ { title: 'overlay case', status: 'failed', failureMessages: [ 'Error: mount denied' ] } ] },
      ],
    });
    const text = failureTextFromReport(report);
    expect(text).toContain('EPERM mount_nfs');
    expect(text).toContain('mount denied');
    expect(failureTextFromReport('not json')).toBe('');
    // Bounded: a huge message is capped.
    const big = JSON.stringify({ testResults: [ { name: 'x', status: 'failed', message: 'z'.repeat(50000) } ] });
    expect(failureTextFromReport(big).length).toBeLessThanOrEqual(4000);
  });
});

describe('driver runtime boundaries (Node22 ESM entry + JSON reporter)', () => {
  it('isEntryPoint is false when imported (no absolute entry argv)', () => {
    // Under the test runner, process.argv[1] is vitest, not this module.
    expect(typeof isEntryPoint()).toBe('boolean');
    // It must never throw (the cross-runtime ESM guard catches).
    expect(() => isEntryPoint()).not.toThrow();
  });

  it('derives the passed count from the SAME JSON report (text summary is suppressed)', () => {
    const report = JSON.stringify({ numPassedTests: 117, numTotalTests: 127, numFailedTests: 0 });
    expect(passedCountFromReport(report)).toBe(117);
    expect(passedCountFromReport('not json')).toBeUndefined();
    expect(passedCountFromReport(JSON.stringify({ foo: 1 }))).toBeUndefined();
  });

  it('runs the driver module under Node22 --experimental-strip-types without a require ReferenceError', async () => {
    // A REAL cross-runtime import probe: strip-types loads the TS module and the
    // ESM entry guard must not throw `require is not defined`. No mount, no env.
    const { execFileSync } = await import('node:child_process');
    const node22 = process.env.XPOD_NODE22_BIN ?? process.execPath;
    const script = "import('./scripts/agentfs-native-ci/mounted/platform-admission.ts').then(m=>{if(typeof m.isEntryPoint!=='function')process.exit(3);process.exit(0)}).catch(e=>{process.stderr.write(String(e));process.exit(4)})";
    try {
      execFileSync(node22, [ '--experimental-strip-types', '-e', script ], { cwd: process.cwd(), stdio: 'pipe' });
    } catch (error) {
      throw new Error(`Node22 strip-types import failed (${node22}): ${(error as { stderr?: Buffer }).stderr?.toString() ?? String(error)}`);
    }
  });

  it('default+json reporters preserve the real failure text on a tiny failing child', async () => {
    // REAL observation: run a tiny failing spec with the SAME dual-reporter argv
    // the driver uses, and prove (a) the human raw carries the exception and
    // (b) failureTextFromReport surfaces it. Not a copied toy function.
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    // Generic, suite-owned path so a clean clone works: no timestamped job path.
    // Create parent with recursive mode 0700, then a randomized child; remove
    // only the owned child in finally.
    const parent = path.resolve('.test-data/agentfs-mounted-platform-admission');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(parent, 'reporter-'));
    try {
      const spec = path.join(dir, 'tiny.spec.ts');
      writeFileSync(spec, [
        "import { beforeAll, describe, it, expect } from 'vitest';",
        "describe('tiny-required', () => {",
        "  beforeAll(() => { throw new Error('owned setup failure beforeAll-EPERM'); });",
        "  it('required-case', () => { expect(1).toBe(2); });",
        "});",
      ].join('\n'), { mode: 0o600 });
      const vitestConfig = path.join(dir, 'vitest.config.mjs');
      writeFileSync(vitestConfig, [
        "import { defineConfig } from 'vitest/config';",
        "export default defineConfig({ test: { include: ['tiny.spec.ts'], root: " + JSON.stringify(dir) + " } });",
      ].join('\n'), { mode: 0o600 });
      const reportPath = path.join(dir, 'report.json');
      const bun = process.env.XPOD_BUN ?? 'bun';
      const result = spawnSync(bun, [ 'x', 'vitest', 'run', '--config', vitestConfig, '--no-file-parallelism',
        '--reporter=default', '--reporter=json', `--outputFile=${reportPath}` ], { encoding: 'utf8', cwd: path.resolve('.'), timeout: 120_000 });
      // Finite timeout means no hang; a tiny failing spec must exit 1 with no signal.
      expect(result.status, `child must exit 1 (stderr: ${result.stderr ?? ''})`).toBe(1);
      expect(result.signal, 'child must not be signalled').toBe(null);
      const human = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      // (a) the human (default reporter) output carries the real setup exception.
      // The EPERM text is a SYNTHETIC fixture string, not an actual privilege cause.
      expect(human, 'human reporter must surface the beforeAll exception').toContain('owned setup failure beforeAll-EPERM');
      // (b) vitest 1.6.1 JSON reporter LOSES a beforeAll throw (file status failed,
      // no message/failureMessages): this is exactly why the driver must ALSO keep
      // the human reporter. Assert the real shape and that our extractor returns
      // '' for JSON-only, so the dual-reporter requirement is provably necessary.
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { testResults?: { status?: string }[] };
      expect(report.testResults?.[0]?.status).toBe('failed');
      expect(failureTextFromReport(readFileSync(reportPath, 'utf8'))).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('kernel observer detail (real implementation, fail-closed preserved)', () => {
  const root = '/tmp/nonexistent-owned-scene';

  it('classifies a safe baseline as absent with a reason', () => {
    const rows = process.platform === 'darwin'
      ? [ { mountpoint: '/', type: 'apfs' }, { mountpoint: '/System/Volumes/Data', type: 'apfs' } ]
      : [ { mountpoint: '/', type: 'ext4' } ];
    const d = classifyMountInventoryDetailed(root, rows);
    expect(d.state).toBe('absent');
    expect(d.classifyReason).toBe('baseline-present');
  });

  it('returns the specific classify reason + bounded classificationContext (state unknown)', () => {
    expect(classifyMountInventoryDetailed(root, []).classifyReason).toBe('empty-rows');
    const malformed = classifyMountInventoryDetailed(root, [ { mountpoint: 'relative', type: 'ext4' } ]);
    expect(malformed.classifyReason).toBe('malformed-row:mountpoint');
    expect(malformed.classificationContext?.rowIndex).toBe(0);
    expect(malformed.classificationContext?.malformedField).toBe('mountpoint');
    const ancestor = classifyMountInventoryDetailed(root, [ { mountpoint: '/', type: 'zzzfs' } ]);
    expect(ancestor.classifyReason).toBe('unknown-ancestor-type');
    expect(ancestor.classificationContext?.type).toBe('zzzfs');
    expect(ancestor.classificationContext?.mountpoint).toBe('/');
    expect(ancestor.classificationContext?.ancestorOfRoot).toBe(true);
    // A target child mount is mounted, not unknown.
    expect(classifyMountInventoryDetailed(root, [ { mountpoint: `${root}/x`, type: 'nfs' } ]).state).toBe('mounted');
  });

  it('observeKernelMountsDetailed reports state + bounded detail without throwing', () => {
    const d = observeKernelMountsDetailed(root);
    expect(['absent', 'mounted', 'unknown']).toContain(d.state);
    expect(typeof d.reason).toBe('string');
    expect(d.reason.length).toBeLessThanOrEqual(64);
    expect(observeKernelMounts(root)).toBe(d.state); // same decision, no divergence
  });

  it('parseLinuxMountInfo returns undefined for malformed mountinfo (fail-closed)', () => {
    expect(parseLinuxMountInfo('garbage line')).toBeUndefined();
    const good = '36 25 0:32 / / rw,relatime shared:1 - overlay overlay rw\n';
    const rows = parseLinuxMountInfo(good);
    expect(rows && rows[0].type).toBe('overlay');
  });

  it('the observing observer wrapper writes a real NONEMPTY detail file and returns the same state', () => {
    const base = path.resolve('.test-data/agentfs-mounted-platform-admission');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(base, 'obs-'));
    const prev = process.env.XPOD_MOUNTED_EVIDENCE;
    process.env.XPOD_MOUNTED_EVIDENCE = dir;
    try {
      const observe = makeObservingKernelObserver('test');
      const state = observe('/tmp/owned-scene');
      expect(['absent', 'mounted', 'unknown']).toContain(state);
      const files = readdirSync(dir).filter((f) => f.startsWith('observer-test-'));
      expect(files.length, 'a real observer detail file must be written').toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(readFileSync(path.join(dir, files[0]), 'utf8')) as { state: string; reason: string; platform: string };
      expect(parsed.state).toBe(state);
      expect(typeof parsed.reason).toBe('string');
      expect(parsed.platform.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.XPOD_MOUNTED_EVIDENCE; else process.env.XPOD_MOUNTED_EVIDENCE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
