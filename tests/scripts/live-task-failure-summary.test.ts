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

it('retains the failed producer stage through the shared safe projection', () => {
  const evidence = { cases: [{ ok: false, producerFailure: { status: 'failed', errorClass: 'unknown' },
    failureDiagnostic: { code: 'TASK_EXECUTION_ERROR', stage: 'retrieve_context', status: 'failed', message: 'private-key' } }],
    cleanup: { ok: true } } as unknown as LiveTaskEvidence;
  expect(summarizeLiveTaskFailure(evidence).failureDiagnostic).toEqual({
    code: 'TASK_EXECUTION_ERROR', stage: 'retrieve_context', status: 'failed',
  });
  expect(JSON.stringify(summarizeLiveTaskFailure(evidence))).not.toContain('private-key');
  evidence.cases[0].failureDiagnostic!.stage = 'private-key' as never;
  expect(summarizeLiveTaskFailure(evidence).failureDiagnostic).toBeUndefined();
});

it('does not attach a stale diagnostic from another case or a successful producer', () => {
  const diagnostic = { code: 'TASK_EXECUTION_ERROR', stage: 'retrieve_context', status: 'failed' };
  const evidence = { cases: [{ ok: false, producerFailure: { status: 'failed', errorClass: 'unknown' }, failureDiagnostic: diagnostic },
    { ok: false, producerFailure: { status: 'completed', errorClass: 'none' }, failureDiagnostic: diagnostic }],
    cleanup: { ok: true } } as unknown as LiveTaskEvidence;
  expect(summarizeLiveTaskFailure(evidence).failureDiagnostic).toBeUndefined();
  delete evidence.cases[1].failureDiagnostic;
  evidence.cases[1].producerFailure!.status = 'failed';
  expect(summarizeLiveTaskFailure(evidence).failureDiagnostic).toBeUndefined();
});
