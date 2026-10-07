import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { ShellAttentionItem } from '@undefineds.co/extension-sdk';
import type { TaskRun, TasksClient } from '@undefineds.co/tasks';
import TasksPage from './TasksPage';

const mocks = vi.hoisted(() => ({ stop: vi.fn(), client: undefined as TasksClient | undefined, run: undefined as TaskRun | undefined, attention: [] as ShellAttentionItem[], podUrl: 'https://pod.test/' }));
vi.mock('@undefineds.co/tasks', () => ({
  createTasksClient: () => ({ stop: mocks.stop }),
  TasksPanel: ({ client, renderApproval }: { client: TasksClient; renderApproval: (run: TaskRun) => ReactNode }) => { mocks.client = client; return mocks.run ? renderApproval(mocks.run) : null; },
}));
vi.mock('../../solid/useXpodSolidRuntime', () => ({ useXpodSolidRuntime: () => ({ fetch, webId: 'https://pod.test/profile/card#me', currentPod: { podUrl: mocks.podUrl, database: { resolveResourceIri: (_resource: unknown, id: string) => /^https?:/.test(id) ? id : new URL(`.data/${id}`, mocks.podUrl).href, resolveRelationIri: (_resource: unknown, id: string) => /^https?:/.test(id) ? id : new URL(`.data/${id}`, mocks.podUrl).href } } }) }));
vi.mock('../../shell/ShellHeaderControls', () => ({ ApprovalCard: ({ item }: { item: ShellAttentionItem }) => <div data-testid="approval">{item.approvalId}</div>, ShellDecisionFeedback: ({ run }: { run: string }) => <div data-testid="feedback">{run}</div>, ShellHeaderControls: () => null }));
vi.mock('../../shell/useShellState', () => ({ useShellState: () => ({ snapshot: { attention: mocks.attention } }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.run = undefined; mocks.attention = []; mocks.podUrl = 'https://pod.test/'; });

it('refreshes shell projections after a successful stop, and preserves a failed stop', async () => {
  const changed = vi.fn();
  window.addEventListener('xpod:pod-changed', changed);
  try {
    render(<MemoryRouter><TasksPage /></MemoryRouter>);
    const result = { run: { id: 'run', status: 'cancelled', createdAt: 1 } };
    mocks.stop.mockResolvedValueOnce(result);
    expect(await mocks.client!.stop('run')).toBe(result);
    expect(mocks.stop).toHaveBeenCalledWith('run');
    expect(changed).toHaveBeenCalledTimes(1);
    mocks.stop.mockRejectedValueOnce(new Error('Stop failed'));
    await expect(mocks.client!.stop('run')).rejects.toThrow('Stop failed');
    expect(changed).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener('xpod:pod-changed', changed); }
});

const rawRun = 'task/default/2026/10/04/runs.ttl#run-one';
const canonicalRun = `https://pod.test/.data/${rawRun}`;
function pendingRun() { return { id: rawRun, thread: 'https://pod.test/thread#one', status: 'waiting_input', createdAt: 1 } as TaskRun; }
function approval() { return { id: 'https://pod.test/approval#one', approvalId: 'https://pod.test/approval#one', run: canonicalRun, thread: 'https://pod.test/thread#one', title: '申请', kind: 'approval', href: '/tasks' } as ShellAttentionItem; }
it('shows the exact approval for a relative dated Run id and sends canonical identity to feedback', () => {
  mocks.run = pendingRun(); mocks.attention = [approval()];
  render(<MemoryRouter><TasksPage /></MemoryRouter>);
  expect(screen.getByTestId('approval').textContent).toBe(approval().approvalId);
  expect(screen.getByTestId('feedback').textContent).toBe(canonicalRun);
  expect(mocks.run.id).toBe(rawRun);
});
it.each(['thread', 'run', 'Pod'])('does not select an approval from a different %s', mismatch => {
  mocks.run = pendingRun(); const item = approval();
  if (mismatch === 'thread') item.thread = 'https://pod.test/thread#other';
  if (mismatch === 'run') item.run = canonicalRun.replace('#run-one', '#run-other');
  if (mismatch === 'Pod') mocks.podUrl = 'https://other.test/';
  mocks.attention = [item];
  render(<MemoryRouter initialEntries={[`/tasks?approval=${encodeURIComponent(item.approvalId!)}`]}><TasksPage /></MemoryRouter>);
  expect(screen.queryByTestId('approval')).toBeNull();
  expect(screen.getByText('这次运行在等你确认，暂未收到对应的申请。')).toBeTruthy();
});
it('recognizes canonical recovery without showing a missing approval and keeps HTTP stop raw', async () => {
  mocks.run = pendingRun(); mocks.attention = [{ id: canonicalRun, run: canonicalRun, resumeApproval: 'https://pod.test/approval#one', title: '恢复', kind: 'run', href: '/tasks' }];
  render(<MemoryRouter><TasksPage /></MemoryRouter>);
  expect(screen.queryByText('这次运行在等你确认，暂未收到对应的申请。')).toBeNull();
  expect(screen.getByTestId('feedback').textContent).toBe(canonicalRun);
  mocks.stop.mockResolvedValueOnce({ run: mocks.run });
  await mocks.client!.stop(rawRun);
  expect(mocks.stop).toHaveBeenCalledWith(rawRun);
});

it('matches the API relative Thread relation to the exact ORM-resolved approval Thread', () => {
  const thread = 'threads.ttl#owned-thread';
  mocks.run = { ...pendingRun(), thread };
  mocks.attention = [{ ...approval(), thread: `https://pod.test/.data/${thread}` }];
  render(<MemoryRouter><TasksPage /></MemoryRouter>);
  expect(screen.getByTestId('approval').textContent).toBe(approval().approvalId);
  expect(mocks.run.thread).toBe(thread);
});
