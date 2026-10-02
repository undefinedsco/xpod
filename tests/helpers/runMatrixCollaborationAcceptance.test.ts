import { describe, expect, it } from 'vitest';
import { classifyMatrixTermination, shouldPreserveMatrixRuntime } from './runMatrixCollaborationAcceptance';

// Regression guard for the ROOT review: the old helper inferred `timedOut` from
// `killed === true && (signal === SIGTERM || code === 143)` and its onSignal path called cleanup()
// with the delete default. These tests pin the actual-timer attribution and preserve-on-signal.
describe('Matrix helper termination attribution', () => {
  it('does not infer a timer deadline from a killed exit 143 alone', () => {
    // A user/teardown SIGTERM can surface as killed=true + code 143 without our deadline firing.
    expect(classifyMatrixTermination({ childFailed: true, userSignal: false, timerFired: false }))
      .toBe('other');
  });

  it('attributes the deadline only when the monotonic timer actually fired', () => {
    expect(classifyMatrixTermination({ childFailed: true, userSignal: false, timerFired: true }))
      .toBe('timer-deadline');
  });

  it('distinguishes a user signal from a timer deadline and other failures', () => {
    expect(classifyMatrixTermination({ childFailed: true, userSignal: true, timerFired: true }))
      .toBe('user-signal');
    expect(classifyMatrixTermination({ childFailed: false, userSignal: false, timerFired: false }))
      .toBe('exit');
  });

  it('preserves the failed runtime on the first cleanup after a signal or deadline', () => {
    expect(shouldPreserveMatrixRuntime({ childFailed: false, userSignal: true, timerFired: false })).toBe(true);
    expect(shouldPreserveMatrixRuntime({ childFailed: false, userSignal: false, timerFired: true })).toBe(true);
    expect(shouldPreserveMatrixRuntime({ childFailed: true, userSignal: false, timerFired: false })).toBe(true);
    // Only a clean child exit with no signal and no deadline may delete the runtime.
    expect(shouldPreserveMatrixRuntime({ childFailed: false, userSignal: false, timerFired: false })).toBe(false);
  });
});
