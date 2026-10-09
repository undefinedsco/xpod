import { expect, it } from 'vitest';
import { summarizeLiveTaskFailure, type LiveTaskEvidence } from '../../scripts/helpers/live-task-approval';

it('retains grant failures before any case exists without publishing private text', () => {
  const evidence = { ok: false, cases: [], failure: 'private-key-and-body', acceptancePhase: 'grant',
    failureDetails: { substage: 'other', category: 'assertion', name: 'LiveTaskEvidenceError', httpStatus: 401,
      taskError: 'authentication_required' },
    cleanup: { ok: true, tasksPaused: 0, runsStopped: 0, sessionsTerminal: 0, grantRevoked: false } } as LiveTaskEvidence;
  expect(summarizeLiveTaskFailure(evidence)).toEqual({ phase: 'grant', category: 'assertion', httpStatus: 401,
    taskError: 'authentication_required', completedCases: 0, cleanupOk: true });
  expect(JSON.stringify(summarizeLiveTaskFailure(evidence))).not.toContain('private-key-and-body');
});

it('rejects injected diagnostics and retains only bounded reviewed facts', () => {
  const evidence = { ok: false, cases: [{ ok: true, taskId: 'private-url', approval: 'https://private.example/approval#original', producerFailure: { status: 'private-status', errorClass: 'private-error' } }], acceptancePhase: 'private-key',
    failureDetails: { substage: 'private-substage', category: 'private-body', httpStatus: 999, taskError: 'private-token' },
    cleanup: { ok: false } } as unknown as LiveTaskEvidence;
  expect(summarizeLiveTaskFailure(evidence)).toEqual({ phase: 'other', completedCases: 1, cleanupOk: false });
});

it('distinguishes a case decision failure from cleanup without exposing resource identifiers', () => {
  const evidence = { ok: false, cases: [], acceptancePhase: 'approved:decision',
    failureDetails: { category: 'timeout', httpStatus: 504, taskError: 'run_document_update_failed' },
    cleanup: { ok: false } } as unknown as LiveTaskEvidence;
  expect(summarizeLiveTaskFailure(evidence)).toEqual({ phase: 'approved:decision', category: 'timeout',
    httpStatus: 504, taskError: 'run_document_update_failed', completedCases: 0, cleanupOk: false });
});

it('identifies producer failures at checkpoint without copying provider text', () => {
  const evidence = { ok: false, cases: [{ ok: false, producerFailure: { status: 'failed', errorClass: 'provider_error', providerModel: 'private-model' } }],
    acceptancePhase: 'approved:checkpoint', failureDetails: { substage: 'checkpoint-match', category: 'assertion' }, cleanup: { ok: true } } as unknown as LiveTaskEvidence;
  expect(summarizeLiveTaskFailure(evidence)).toEqual({ phase: 'approved:checkpoint', substage: 'checkpoint-match', category: 'assertion', producerStatus: 'failed', producerErrorClass: 'provider_error', completedCases: 0, cleanupOk: true });
});
