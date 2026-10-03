import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ShellStateProvider } from './ShellStateProvider';
import { projectShellState } from './shell-state';
import { useShellState } from './useShellState';

const mocks = vi.hoisted(() => ({
  runtime: { state: { status: 'authenticated' }, webId: 'https://one/profile#me', currentPod: { podUrl: 'https://one/', database: {} }, fetch: vi.fn() },
  resume: vi.fn(), read: vi.fn(), decide: vi.fn(), network: vi.fn(), usage: vi.fn(), publish: vi.fn(),
}));
vi.mock('@undefineds.co/tasks', () => ({ createTasksClient: () => ({ resumeRun: mocks.resume }) }));
vi.mock('../solid/useXpodSolidRuntime', () => ({ useXpodSolidRuntime: () => mocks.runtime }));
vi.mock('../api/admin', () => ({ getPublicIpCheck: mocks.network }));
vi.mock('../api/pod-settings', () => ({ fetchPodSettingsStatus: mocks.usage }));
vi.mock('./shell-state', async importOriginal => ({ ...await importOriginal<typeof import('./shell-state')>(), readShellSnapshot: mocks.read, decideApproval: mocks.decide }));
function View() {
  const { snapshot, error, markAllRead } = useShellState();
  return <><output>{JSON.stringify(snapshot)}</output><p>{error}</p><button onClick={markAllRead}>read</button></>;
}
beforeEach(() => {
  Object.values(mocks).forEach(value => { if (vi.isMockFunction(value)) value.mockReset(); });
  mocks.runtime.state.status = 'authenticated';
  mocks.runtime.webId = 'https://one/profile#me';
});
afterEach(() => { cleanup(); vi.clearAllMocks(); delete globalThis.xpodDesktop; });
it('publishes the same state to tray and keeps network attention when Pod reading fails', async () => {
  globalThis.xpodDesktop = { setIdentity: vi.fn(), publishAttention: mocks.publish };
  mocks.read.mockRejectedValue(new Error('offline'));
  mocks.network.mockResolvedValue({ status: 'fail' });
  mocks.usage.mockResolvedValue(null);
  const view = render(<ShellStateProvider><View /></ShellStateProvider>);
  await waitFor(() => expect(screen.getByText('Pod 通知读取失败，请重试')).toBeTruthy());
  const snapshot = JSON.parse(screen.getByRole('status').textContent || '{}');
  expect(snapshot.attention[0].kind).toBe('network');
  await waitFor(() => expect(mocks.publish).toHaveBeenCalledWith(snapshot));
  view.unmount();
  expect(mocks.publish).toHaveBeenLastCalledWith({ attention: [], activity: [], inbox: [], inProgress: [] });
});
it('all read only changes activity and identity switching clears previous Pod data immediately', async () => {
  mocks.read.mockResolvedValue({ attention: [{ id: 'request', title: '请求', kind: 'approval', href: '/inbox' }], activity: [{ id: 'event', title: '事件', href: '/tasks', createdAt: '2026-10-01' }], inbox: [], inProgress: [] });
  mocks.network.mockResolvedValue(null);
  mocks.usage.mockResolvedValue(null);
  const view = render(<ShellStateProvider><View /></ShellStateProvider>);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('request'));
  fireEvent.click(screen.getByText('read'));
  let snapshot = JSON.parse(screen.getByRole('status').textContent || '{}');
  expect(snapshot.attention).toHaveLength(1);
  expect(snapshot.activity[0].read).toBe(true);
  mocks.read.mockRejectedValueOnce(new Error('offline'));
  fireEvent.focus(window);
  await waitFor(() => expect(screen.getByText('Pod 通知读取失败，请重试')).toBeTruthy());
  expect(screen.getByRole('status').textContent).toContain('request');
  mocks.runtime.webId = 'https://two/profile#me';
  mocks.read.mockReturnValue(new Promise(() => {}));
  view.rerender(<ShellStateProvider><View /></ShellStateProvider>);
  snapshot = JSON.parse(screen.getByRole('status').textContent || '{}');
  expect(snapshot.attention).toEqual([]);
  expect(snapshot.activity).toEqual([]);
});

it('routes tray decisions through the same persisted decision and surfaces failures without hiding attention', async () => {
  let handler: ((request: { approvalId: string; decision: 'approved' | 'rejected' }) => void) | undefined;
  globalThis.xpodDesktop = { setIdentity: vi.fn(), publishAttention: mocks.publish, onApprovalDecision: callback => { handler = callback; return () => { handler = undefined; }; } };
  mocks.read.mockResolvedValue({ attention: [{ id: 'request', approvalId: 'https://pod/approval', title: '请求', kind: 'approval', href: '/inbox' }], activity: [], inbox: [], inProgress: [] });
  mocks.network.mockResolvedValue(null);
  mocks.usage.mockResolvedValue(null);
  mocks.decide.mockRejectedValue(new Error('申请已过期'));
  render(<ShellStateProvider><View /></ShellStateProvider>);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('request'));
  handler?.({ approvalId: 'https://pod/approval', decision: 'approved' });
  await waitFor(() => expect(screen.getByText('申请已过期')).toBeTruthy());
  expect(mocks.decide).toHaveBeenCalledWith(mocks.runtime.fetch, 'https://pod/approval', mocks.runtime.webId, 'approved', expect.any(Function));
  expect(screen.getByRole('status').textContent).toContain('request');
});
it('clears Pod attention when the session expires even if the runtime retains the WebID', async () => {
  mocks.runtime.state.status = 'authenticated';
  mocks.read.mockResolvedValue({ attention: [{ id: 'private-request', title: '请求', kind: 'approval', href: '/inbox' }], activity: [], inbox: [], inProgress: [] });
  mocks.network.mockResolvedValue(null);
  mocks.usage.mockResolvedValue(null);
  const view = render(<ShellStateProvider><View /></ShellStateProvider>);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('private-request'));
  const reads = mocks.read.mock.calls.length;
  mocks.runtime.state.status = 'expired';
  view.rerender(<ShellStateProvider><View /></ShellStateProvider>);
  expect(screen.getByRole('status').textContent).not.toContain('private-request');
  expect(mocks.read).toHaveBeenCalledTimes(reads);
  mocks.runtime.state.status = 'authenticated';
});

function ResumeProbe() {
  const { decide, retryResume, resumeFailures } = useShellState();
  return <><button onClick={() => void decide('https://pod/approval', 'approved')}>decide</button>{resumeFailures.map(item => <div key={item.approvalId}><p>{item.message}</p><button onClick={() => void retryResume(item.approvalId, item.run)}>retry run</button></div>)}</>;
}
it('retains a retryable run continuation after saving approval without writing the decision again', async () => {
  mocks.read.mockResolvedValueOnce({ attention: [{ id: 'approval', approvalId: 'https://pod/approval', run: 'https://pod/run', title: '请求', kind: 'approval', href: '/inbox' }], activity: [], inbox: [], inProgress: [] });
  mocks.read.mockResolvedValue({ attention: [], activity: [], inbox: [], inProgress: [] });
  mocks.network.mockResolvedValue(null);
  mocks.usage.mockResolvedValue(null);
  mocks.decide.mockResolvedValue(undefined);
  mocks.resume.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ resumed: true });
  render(<ShellStateProvider><View /><ResumeProbe /></ShellStateProvider>);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('https://pod/approval'));
  fireEvent.click(screen.getByText('decide'));
  await screen.findByText('决定已保存，运行处理失败，请重试。');
  expect(mocks.decide).toHaveBeenCalledTimes(1);
  expect(mocks.resume).toHaveBeenCalledWith('https://pod/run', 'https://pod/approval');
  fireEvent.click(screen.getByText('retry run'));
  await waitFor(() => expect(screen.queryByText('retry run')).toBeNull());
  expect(mocks.resume).toHaveBeenCalledTimes(2);
  expect(mocks.decide).toHaveBeenCalledTimes(1);
});

it('refreshes terminal checkpoint projections out of both the shell and tray without deciding approvals', async () => {
  const approvals = [
    { id: 'cancelled-approval', thread: 'thread', toolCallId: 'cancelled-call', status: 'pending' },
    { id: 'live-approval', thread: 'thread', toolCallId: 'live-call', status: 'pending' },
  ];
  const cancelledRun = { id: 'cancelled-run', thread: 'thread', status: 'waiting_input', metadata: { waitingTool: { requestId: 'cancelled-call' } } };
  const liveRun = { id: 'live-run', thread: 'thread', status: 'waiting_input', metadata: { waitingTool: { requestId: 'live-call' } } };
  mocks.read.mockResolvedValueOnce(projectShellState({ approvals, runs: [cancelledRun, liveRun], inbox: [], tasks: [] }));
  mocks.read.mockResolvedValue(projectShellState({ approvals, runs: [{ ...cancelledRun, status: 'cancelled' }, liveRun], inbox: [], tasks: [] }));
  mocks.network.mockResolvedValue(null);
  mocks.usage.mockResolvedValue(null);
  globalThis.xpodDesktop = { setIdentity: vi.fn(), publishAttention: mocks.publish };
  render(<ShellStateProvider><View /></ShellStateProvider>);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('cancelled-approval'));
  fireEvent(window, new Event('xpod:pod-changed'));
  await waitFor(() => expect(screen.getByRole('status').textContent).not.toContain('cancelled-approval'));
  const latest = JSON.parse(screen.getByRole('status').textContent || '{}');
  expect(latest.attention.some((item: { id: string }) => item.id === 'live-approval')).toBe(true);
  await waitFor(() => expect(mocks.publish).toHaveBeenLastCalledWith(latest));
  expect(mocks.decide).not.toHaveBeenCalled();
  expect(approvals.map(item => item.status)).toEqual(['pending', 'pending']);
});
