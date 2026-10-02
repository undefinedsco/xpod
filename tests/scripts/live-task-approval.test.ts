import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRow } from '@undefineds.co/models';
import { pollLiveTask, requireLiveCheckpoint, requireLiveTerminal, type LiveTaskRun } from '../../scripts/helpers/live-task-approval';

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
