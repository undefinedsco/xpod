import { createRequire } from 'node:module';

/** Shared supervised selected-source command mechanics only. This module
 * issues no capability and never parses source; it returns actual child bytes. */
const METADATA = 4194304;
const MAXIMUM_TIMEOUT = 120000;
const sourceRequire = createRequire(__filename); // local CommonJS-compatible base

export interface SdkSelectedOriginalBudget {
  check(): void;
  remainingMs(): number;
  remainingReadBytes(): number;
  reserveBytes(bytes: number): void;
  chargeReadBytes(bytes: number): void;
}

export interface SdkSelectedOriginalCommandInput {
  readonly archiveIdentity: Readonly<{bytes: number; sha256: string}>;
  withArchiveFile<T>(
    operation: (archive: {readonly path: string; readonly identity: Readonly<{bytes: number; sha256: string}>}) => Promise<T>,
    budget: {check(): void; remainingMs(): number},
  ): Promise<T>;
  readonly python: string;
  readonly helperPath: string;
  createPlan(remainingMs: number): Buffer;
  remainingMs(): number;
  readonly budget: SdkSelectedOriginalBudget;
}

export interface SdkSelectedOriginalCommandResult {
  readonly json: unknown;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly record: Readonly<Record<string, unknown>>;
}

function need(value: unknown, reason: string): asserts value {
  if (!value) throw Error('SDK selected original command: ' + reason);
}

export async function runSdkSelectedOriginalCommand(input: SdkSelectedOriginalCommandInput): Promise<SdkSelectedOriginalCommandResult> {
  const budget = input.budget;
  need(budget && typeof budget.check === 'function' && typeof budget.remainingMs === 'function'
    && typeof budget.remainingReadBytes === 'function' && typeof budget.reserveBytes === 'function'
    && typeof budget.chargeReadBytes === 'function', 'same parent read budget required');
  const deadlineRemaining = () => Math.floor(Math.min(input.remainingMs(), budget.remainingMs()));
  const check = () => {
    budget.check();
    need(input.remainingMs() >= 2 && budget.remainingMs() >= 2, 'shared source window expired');
  };
  const { runOwnedModeCommand } = sourceRequire('../owned-mode-command.cjs') as {
    runOwnedModeCommand(binary: string, args: readonly string[], options: Record<string, unknown>): Promise<{
      stdout: Buffer; stderr: Buffer; record: Record<string, any>;
    }>;
  };
  return input.withArchiveFile(async archive => {
    check();
    need(archive.identity.bytes === input.archiveIdentity.bytes && archive.identity.sha256 === input.archiveIdentity.sha256,
      'same retained actual archive required');
    // Plan and every cap are derived inside actual custody, immediately before
    // spawn. The plan is reserved twice (original plus runner defensive copy)
    // and charged once.
    let plan = input.createPlan(Math.max(1, Math.min(deadlineRemaining(), MAXIMUM_TIMEOUT)));
    need(Buffer.isBuffer(plan) && plan.length <= METADATA, 'bounded selected command plan required');
    const initialPlanBytes = plan.length;
    need(budget.remainingReadBytes() >= initialPlanBytes + 4, 'selected command read budget exhausted before spawn');
    budget.reserveBytes(2 * initialPlanBytes);
    budget.chargeReadBytes(initialPlanBytes);
    budget.check();
    // Dual-stream cap after the plan charge: (remaining - 2) / 2 metadata bound,
    // then reduced so 2*cap per stream for retained chunks+result fits the
    // same parent without refund or overcommit.
    const remainingAfterCharge = budget.remainingReadBytes();
    const perStream = Math.min(METADATA, Math.floor((remainingAfterCharge - 2) / 2), Math.floor((remainingAfterCharge - 2) / 4));
    need(perStream >= 1, 'selected command output budget exhausted before spawn');
    // Reserve retained chunks plus concatenated result for each stream.
    const held = 4 * perStream;
    need(budget.remainingReadBytes() >= held, 'selected command retained-output budget exhausted before spawn');
    budget.reserveBytes(held);
    budget.check();
    // Build the final plan under the current clock bound, reserve any growth,
    // then re-read the actual remaining window IMMEDIATELY before spawn so the
    // plan's own clock cannot make the runner timeout stale.
    let planClockMs = Math.max(1, Math.min(deadlineRemaining(), MAXIMUM_TIMEOUT));
    need(planClockMs >= 1, 'selected command window expired before final plan');
    const finalPlan = input.createPlan(planClockMs);
    need(Buffer.isBuffer(finalPlan) && finalPlan.length <= METADATA, 'bounded final selected command plan required');
    if (finalPlan.length > initialPlanBytes) {
      const extra = finalPlan.length - initialPlanBytes;
      need(budget.remainingReadBytes() >= 2 * extra, 'selected command plan growth exceeds parent budget');
      budget.reserveBytes(2 * extra);
      budget.chargeReadBytes(extra);
    }
    plan = finalPlan;
    budget.check();
    // Authoritative spawn window: never larger than the clock stamped into the
    // plan, and never the pre-plan value.
    const timeoutMs = Math.min(deadlineRemaining(), planClockMs, MAXIMUM_TIMEOUT);
    need(timeoutMs >= 1, 'selected command window expired before spawn');
    const observation = await runOwnedModeCommand(input.python, ['-I', '-S', '-B', input.helperPath, archive.path], {
      cwd: process.cwd(), env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'},
      timeoutMs, outputBytes: perStream, terminationGraceMs: 1000, finalObservationMs: 4000, input: plan,
    });
    const record = observation.record;
    // Charge actual received bytes before leaving custody, even on failure.
    const receivedOut = Number(record.receivedStdoutBytes);
    const receivedErr = Number(record.receivedStderrBytes);
    need(Number.isSafeInteger(receivedOut) && receivedOut >= 0 && Number.isSafeInteger(receivedErr) && receivedErr >= 0,
      'actual received-byte accounting required');
    budget.chargeReadBytes(receivedOut + receivedErr);
    budget.check();
    need(receivedOut <= perStream && receivedErr <= perStream && observation.stdout.length <= perStream && observation.stderr.length <= perStream,
      'selected command output exceeded per-stream cap');
    // Returned copies: reserve their exact bytes on the same parent before the
    // defensive Buffer.from allocations.
    const heldCopies = observation.stdout.length + observation.stderr.length;
    budget.reserveBytes(heldCopies);
    budget.check();
    need(record.code === 0 && record.signal === null && record.rawEligible === true && record.inputDelivered === true
      && !record.cancelled && !record.timedOut && !record.outputTruncated && !record.forcedCleanup
      && record.closeObserved === true && record.groupAbsent === true && record.ownershipUnknown === false
      && record.spawnFailed !== true, 'selected command delivery failed');
    return Object.freeze({json: JSON.parse(observation.stdout.toString()), stdout: Buffer.from(observation.stdout),
      stderr: Buffer.from(observation.stderr), record: Object.freeze({...record})});
  }, {check: budget.check, remainingMs: deadlineRemaining});
}
