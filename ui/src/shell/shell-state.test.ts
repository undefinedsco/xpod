import { describe, expect, it, vi } from 'vitest';
import { decideApproval, isActionableApproval, projectShellState, markActivitiesRead } from './shell-state';

describe('shell attention projection', () => {
  it('keeps unresolved requests separate from read activity and matches inbox by exact IRI', () => {
    const snapshot = projectShellState({ approvals: [{ id: 'https://pod/.data/approvals/a#1', status: 'pending', toolName: '读取文件', risk: 'low' }], inbox: [{ id: 'i', object: 'https://pod/.data/approvals/a#1', createdAt: new Date() }], runs: [], tasks: [] });
    expect(snapshot.attention).toHaveLength(1);
    expect(snapshot.inbox[0].approvalId).toBe(snapshot.attention[0].approvalId);
    expect(markActivitiesRead(snapshot).attention).toEqual(snapshot.attention);
  });
  it('removes resolved and expired requests, retaining failed and waiting runs', () => {
    expect(isActionableApproval({ status: 'approved' })).toBe(false);
    expect(isActionableApproval({ status: 'pending', expiresAt: new Date(0) })).toBe(false);
    const snapshot = projectShellState({ approvals: [], inbox: [], tasks: [], runs: [{ id: 'r1', status: 'failed' }, { id: 'r2', status: 'waiting_input' }, { id: 'r3', status: 'running' }] });
    expect(snapshot.attention.map(item => item.id)).toEqual(['r1', 'r2']);
    expect(snapshot.inProgress.map(item => item.id)).toEqual(['r3']);
  });
});

const decision = vi.hoisted(() => vi.fn());
vi.mock('@undefineds.co/models', async importOriginal => ({ ...await importOriginal<typeof import('@undefineds.co/models')>(), decideApprovalRequest: decision }));
it('uses the shared conditional decision helper and surfaces conflicts without retrying', async () => {
  const fetcher = vi.fn();
  const isCurrent = () => true;
  decision.mockResolvedValueOnce({ status: 'decided' });
  await decideApproval(fetcher, 'https://pod/approval', 'https://pod/profile#me', 'approved', isCurrent);
  expect(decision).toHaveBeenLastCalledWith({ approval: 'https://pod/approval', decisionBy: 'https://pod/profile#me', decision: 'approved', authenticatedFetch: fetcher, isCurrent });
  decision.mockResolvedValueOnce({ status: 'conflict' });
  await expect(decideApproval(fetcher, 'https://pod/approval', 'https://pod/profile#me', 'rejected')).rejects.toThrow('其他入口');
  expect(decision).toHaveBeenCalledTimes(2);
});
it('links runtime approvals back to the waiting run and inbox requests back to their envelope', () => {
  const approval = { id: 'https://pod/approval', thread: 'https://pod/thread', toolCallId: 'call-1', status: 'pending' };
  const run = { id: 'https://pod/run', thread: approval.thread, status: 'waiting_input', metadata: { waitingTool: { requestId: 'call-1' } } };
  const snapshot = projectShellState({ approvals: [approval], runs: [run], tasks: [], inbox: [] });
  expect(snapshot.attention[0].thread).toBe(approval.thread);
  expect(snapshot.attention[0].run).toBe(run.id);
  expect(snapshot.attention[0].href).toBe('/tasks?run=https%3A%2F%2Fpod%2Frun&approval=https%3A%2F%2Fpod%2Fapproval');
  const withInbox = projectShellState({ approvals: [approval], runs: [run], tasks: [], inbox: [{ id: 'i', object: approval.id, createdAt: new Date() }] });
  expect(withInbox.attention[0].run).toBe(run.id);
  expect(withInbox.attention[0].href).toBe('/inbox?approval=https%3A%2F%2Fpod%2Fapproval');
});

it('reconstructs continuation from the exact durable checkpoint without reusing older approvals', () => {
  const run = { id: 'run', thread: 'thread', status: 'waiting_input', metadata: { waitingTool: { requestId: 'current-call' } } };
  const approvals = [{ id: 'old', thread: 'thread', toolCallId: 'older-call', status: 'approved' }, { id: 'current', thread: 'thread', toolCallId: 'current-call', status: 'rejected' }];
  const snapshot = projectShellState({ approvals, runs: [run], tasks: [], inbox: [] });
  expect(snapshot.attention).toHaveLength(1);
  expect(snapshot.attention[0]).toMatchObject({ kind: 'run', run: 'run', resumeApproval: 'current' });
  const withoutCheckpoint = projectShellState({ approvals, runs: [{ ...run, metadata: undefined }], tasks: [], inbox: [] });
  expect(withoutCheckpoint.attention[0].resumeApproval).toBeUndefined();
});
it.each(['cancelled', 'completed', 'failed'])('hides only the pending approval matching a %s run checkpoint', status => {
  const cancelledApproval = { id: 'approval-cancelled', thread: 'shared-thread', toolCallId: 'cancelled-call', status: 'pending' };
  const stillWaiting = { id: 'approval-waiting', thread: 'shared-thread', toolCallId: 'live-call', status: 'pending' };
  const standalone = { id: 'approval-standalone', thread: 'shared-thread', toolCallId: 'unrelated-call', status: 'pending' };
  const approvals = [cancelledApproval, stillWaiting, standalone];
  const runs = [
    { id: 'terminal-run', thread: 'shared-thread', status, metadata: { waitingTool: { requestId: 'cancelled-call' } } },
    { id: 'waiting-run', thread: 'shared-thread', status: 'waiting_input', metadata: { waitingTool: { requestId: 'live-call' } } },
  ];
  const inbox = [{ id: 'message', object: cancelledApproval.id, createdAt: new Date() }];
  const snapshot = projectShellState({ approvals, runs, inbox, tasks: [] });
  expect(snapshot.attention.filter(item => item.kind === 'approval').map(item => item.id)).toEqual(['approval-waiting', 'approval-standalone']);
  expect(snapshot.inbox).toHaveLength(1);
  expect(snapshot.inbox[0].approvalId).toBeUndefined();
  expect(approvals.map(item => item.status)).toEqual(['pending', 'pending', 'pending']);
});
it('does not hide an approval from another thread or an unidentifiable terminal checkpoint', () => {
  const approvals = [{ id: 'approval', thread: 'current-thread', toolCallId: 'call', status: 'pending' }];
  const runs = [
    { id: 'other-thread-run', thread: 'different-thread', status: 'cancelled', metadata: { waitingTool: { requestId: 'call' } } },
    { id: 'unidentified-run', thread: 'current-thread', status: 'completed' },
  ];
  const snapshot = projectShellState({ approvals, runs, inbox: [], tasks: [] });
  expect(snapshot.attention.map(item => item.id)).toEqual(['approval']);
});

it('preserves a pending approval when a reused checkpoint also belongs to an active run', () => {
  const approvals = [{ id: 'approval', thread: 'thread', toolCallId: 'call', status: 'pending' }];
  const runs = [
    { id: 'old-run', thread: 'thread', status: 'cancelled', metadata: { waitingTool: { requestId: 'call' } } },
    { id: 'current-run', thread: 'thread', status: 'waiting_input', metadata: { waitingTool: { requestId: 'call' } } },
  ];
  const snapshot = projectShellState({ approvals, runs, inbox: [], tasks: [] });
  expect(snapshot.attention.find(item => item.approvalId === 'approval')?.run).toBe('current-run');
});
