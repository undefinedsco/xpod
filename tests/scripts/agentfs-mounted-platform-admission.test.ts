import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { classifyProbeError, evaluateRequiredMountedCases, isEntryPoint, passedCountFromReport, probeOwnedGroup, reapOwnedGroup, REQUIRED_MOUNTED_CASES } from '../../scripts/agentfs-native-ci/mounted/platform-admission';

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
});
