import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMISSION_SCENARIOS, evaluateAdmission, missingScenarios } from './admissionScenarios';

const REPO_ROOT = process.cwd();

function discoverRclonePod(): { available: boolean; reason: string; candidates: string[] } {
  const candidates = [
    process.env.XPOD_RCLONE_POD_BIN,
    process.env.XPOD_RCLONE_POD_CMD,
    path.join(REPO_ROOT, 'tools', 'rclone-pod', 'bin', 'xpod-rclone'),
    path.join(REPO_ROOT, 'tools', 'rclone-pod', 'target', 'release', 'rclone-pod'),
  ].filter((entry): entry is string => Boolean(entry));
  const found = candidates.find((candidate) => existsSync(candidate));
  return {
    available: Boolean(found),
    reason: found ? `found ${found}` : 'no rclone-pod tool found',
    candidates,
  };
}

describe('Xpod CLI engine-neutral admission scenarios', () => {
  it('defines the full admission set with unique ids and evidence', () => {
    const ids = ADMISSION_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'metadata-zero-body',
      'correct-range-206',
      'external-mutation-visible',
      'create-409-412',
      'conditional-edit-delete',
      'editor-replace',
      'network-fail',
      '412-preserves-dirty',
      'restart-baseline',
      'rg-unsupported-falls-back-to-mount-view',
    ]);
    for (const scenario of ADMISSION_SCENARIOS) {
      expect(scenario.description.length).toBeGreaterThan(0);
      expect(scenario.evidence.length).toBeGreaterThan(0);
    }
  });

  it('cannot silently drop a scenario', () => {
    expect(missingScenarios([ 'metadata-zero-body' ])).toContain('editor-replace');
    expect(missingScenarios(ADMISSION_SCENARIOS.map((scenario) => scenario.id))).toEqual([]);
  });

  it('never reports PASS while a required scenario has not run', () => {
    const pass = (id: string) => ({ id, status: 'pass' as const });
    const allNotRun = ADMISSION_SCENARIOS.map((scenario) => ({ id: scenario.id, status: 'not-run' as const }));
    expect(evaluateAdmission(allNotRun).status).toBe('incomplete');

    const oneMissing = ADMISSION_SCENARIOS.filter((scenario) => scenario.id !== 'network-fail').map((scenario) => pass(scenario.id));
    const evaluation = evaluateAdmission(oneMissing);
    expect(evaluation.status).toBe('incomplete');
    expect(evaluation.notRun).toEqual([ 'network-fail' ]);

    const allPass = ADMISSION_SCENARIOS.map((scenario) => pass(scenario.id));
    expect(evaluateAdmission(allPass).status).toBe('pass');

    const oneFail = ADMISSION_SCENARIOS.map((scenario) => ({ id: scenario.id, status: scenario.id === 'create-409-412' ? ('fail' as const) : ('pass' as const) }));
    expect(evaluateAdmission(oneFail).status).toBe('fail');

    // A failure plus un-run required scenarios is still INCOMPLETE (never PASS).
    const failPlusMissing = oneFail.filter((result) => result.id !== 'network-fail');
    expect(evaluateAdmission(failPlusMissing).status).toBe('incomplete');
  });

  it('reports the rclone candidate availability honestly', () => {
    const rclone = discoverRclonePod();
    if (!rclone.available) {
      console.warn(`[engines] rclone candidate UNAVAILABLE: ${rclone.reason}`);
    }
    expect(rclone.available ? rclone.reason.startsWith('found') : rclone.reason.length > 0).toBe(true);
  });
});
