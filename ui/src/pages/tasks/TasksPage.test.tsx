import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { TasksClient } from '@undefineds.co/tasks';
import TasksPage from './TasksPage';

const mocks = vi.hoisted(() => ({ stop: vi.fn(), client: undefined as TasksClient | undefined }));
vi.mock('@undefineds.co/tasks', () => ({
  createTasksClient: () => ({ stop: mocks.stop }),
  TasksPanel: ({ client }: { client: TasksClient }) => { mocks.client = client; return null; },
}));
vi.mock('../../solid/useXpodSolidRuntime', () => ({ useXpodSolidRuntime: () => ({ fetch, webId: 'https://pod.test/profile/card#me', currentPod: { podUrl: 'https://pod.test/' } }) }));
vi.mock('../../shell/ShellHeaderControls', () => ({ ApprovalCard: () => null, ShellDecisionFeedback: () => null, ShellHeaderControls: () => null }));
vi.mock('../../shell/useShellState', () => ({ useShellState: () => ({ snapshot: { attention: [] } }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

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
