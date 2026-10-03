import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRow } from '@undefineds.co/models';
import { pollLiveTask, requireLiveCheckpoint, requireLiveTerminal, type LiveTaskRun, type LiveTaskCaseEvidence } from '../../scripts/helpers/live-task-approval';

const owner = 'https://pod.example/alice/profile/card#me';
const target = 'https://pod.example/alice/acceptance/marker.txt';
const run: LiveTaskRun = { id: 'task/test/2026/10/02/runs.ttl#run', thread: 'https://pod.example/alice/thread#one',
  status: 'waiting_input', waitingToolCallId: 'call-one' };
const approval = { id: '2026/10/02/approvals.ttl#one', target, thread: run.thread, toolCallId: 'call-one',
  toolName: 'request_approval', assignedTo: owner, status: 'pending' } as ApprovalRow;

afterEach(() => { vi.useRealTimers(); });

describe('live Task acceptance evidence gates (unit checks, not live proof)', () => {
  it('requires the actual pending tool checkpoint and owner', () => {
    expect(requireLiveCheckpoint(run, [approval], target, owner)).toBe(approval);
    for (const changed of [ { target: `${target}-other` }, { thread: `${run.thread}-other` },
      { toolCallId: 'other' }, { toolName: 'write' }, { assignedTo: 'https://other.example/me' }, { status: 'approved' } ]) {
      expect(requireLiveCheckpoint(run, [{ ...approval, ...changed } as ApprovalRow], target, owner)).toBeUndefined();
    }
    expect(requireLiveCheckpoint({ ...run, status: 'running' }, [approval], target, owner)).toBeUndefined();
  });
  it.each(['completed', 'failed', 'cancelled'])('does not count early %s as an approval', status => {
    expect(() => requireLiveCheckpoint({ ...run, status }, [approval], target, owner)).toThrow('before requesting approval');
  });
  it('keeps failed producers blocking while projecting only safe diagnostics', () => {
    const secret = 'SYNTHETIC_CREDENTIAL_MARKER';
    const error = `service_access_missing HTTP 403 Bearer ${secret} Cookie=${secret} JWT=eyJ${secret}.payload.signature\nstack: https://user:${secret}@example.test/path?token=${secret} body=${secret}`;
    const evidence: LiveTaskCaseEvidence = { kind: 'approved', ok: false };
    expect(() => requireLiveCheckpoint({ ...run, status: 'failed', error }, [], target, owner, evidence))
      .toThrow('Producer ended failed before requesting approval');
    expect(evidence.producerFailure).toEqual({ status: 'failed', errorPresent: true, errorLength: error.length,
      errorClass: 'service_access_missing', httpStatus: 403 });
    expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(JSON.stringify(evidence)).not.toMatch(/Bearer|Cookie|https:|stack|body/);
  });
  it.each<[unknown, string, boolean, number]>([
    [undefined, 'none', false, 0], ['', 'none', false, 0],
    [{ errorClass: 'provider_error', httpStatus: 403, message: 'SECRET' }, 'unknown', true, 0],
    ['SECRET HTTP 401 then status 403', 'unknown', true, 'SECRET HTTP 401 then status 403'.length],
    ...([
      ['Pi assistant ended with error', 'provider_error'],
      ['Pi assistant ended with aborted', 'provider_aborted'],
      ['Error: token_exchange_failed', 'token_exchange_failed'],
      ['auth_required', 'auth_required'],
      ['Cloud Agent Runtime requires an OS sandbox, but none is available on this host', 'sandbox_unavailable'],
      ['Cloud Agent Runtime refused to run without a sandbox', 'sandbox_unavailable'],
      ['Agent Runtime worker failed to start: SECRET', 'worker_start_failed'],
      ['Agent Runtime worker exited with code 1 SECRET', 'worker_exited'],
      ['Unable to read execution state: SECRET', 'execution_state_error'],
    ] as const).map(([text, classification]) => [text, classification, true, text.length] as [unknown, string, boolean, number]),
  ])('projects terminal failures without accepting arbitrary error objects (%s)', (error, errorClass, errorPresent, errorLength) => {
    const evidence: LiveTaskCaseEvidence = { kind: 'approved', ok: false };
    expect(() => requireLiveTerminal({ ...run, status: 'failed', error }, run.id, 'completed', evidence))
      .toThrow('expected completed');
    expect(evidence.producerFailure).toEqual({ status: 'failed', errorClass, errorPresent, errorLength });
    expect(JSON.stringify(evidence)).not.toContain('SECRET');
  });
  it('copies the runner\'s allowlisted provider classification without any upstream text', () => {
    const secret = 'SYNTHETIC_CREDENTIAL_MARKER';
    const error = `Pi assistant ended with error (class=auth, api=openai-completions, provider=xpod, model=deepseek-v4-pro) body=${secret} key=sk-${secret}`;
    const evidence: LiveTaskCaseEvidence = { kind: 'approved', ok: false };
    expect(() => requireLiveTerminal({ ...run, status: 'failed', error }, run.id, 'completed', evidence))
      .toThrow('expected completed');
    expect(evidence.producerFailure).toMatchObject({
      status: 'failed', errorClass: 'provider_error',
      providerClass: 'auth', providerApi: 'openai-completions', providerName: 'xpod', providerModel: 'deepseek-v4-pro',
    });
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });
  it('rejects ambiguous duplicate approvals', () => {
    expect(() => requireLiveCheckpoint(run, [approval, { ...approval, id: 'other' }], target, owner)).toThrow('Multiple approvals');
  });
  it('requires the same Run and the correct terminal result', () => {
    expect(requireLiveTerminal(run, run.id, 'completed')).toBe(false);
    expect(requireLiveTerminal({ ...run, status: 'completed' }, run.id, 'completed')).toBe(true);
    expect(() => requireLiveTerminal({ ...run, status: 'cancelled' }, run.id, 'completed')).toThrow('expected completed');
    expect(() => requireLiveTerminal({ ...run, id: 'other', status: 'completed' }, run.id, 'completed')).toThrow('different Run');
  });
  it('polls persisted state without converting a transient state into success', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce('queued').mockResolvedValueOnce('running').mockResolvedValue('waiting_input');
    const result = pollLiveTask(read, value => value === 'waiting_input', 'checkpoint', 100, 10);
    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toBe('waiting_input');
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('fails within its polling deadline', async () => {
    vi.useFakeTimers();
    const result = pollLiveTask(async () => 'running', value => value === 'completed', 'terminal Run', 20, 10);
    const assertion = expect(result).rejects.toThrow('Timed out waiting for terminal Run');
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
  });
  it('preserves transport and malformed-evidence failures', async () => {
    await expect(pollLiveTask(async () => { throw new Error('HTTP 403'); }, () => true, 'checkpoint')).rejects.toThrow('HTTP 403');
    await expect(pollLiveTask(async () => ({ ...run, status: 'failed' }), value =>
      requireLiveTerminal(value, run.id, 'completed'), 'terminal')).rejects.toThrow('expected completed');
  });
});
