// @vitest-environment jsdom
import React from 'react';
import { WorkspaceDrawerContext } from '@undefineds.co/extension-sdk/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TasksPanel } from '../src/TasksPanel';
import type { TaskSummary, TasksClient } from '../src/client';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const owner = 'https://pod.test/me';
function clientFor(tasks: TaskSummary[]): TasksClient {
  return {
    resumeRun: vi.fn(),
    list: vi.fn(async () => ({ tasks, capabilities: { createAi: false, resumeStep: false, handoff: false, approve: false } })),
    create: vi.fn(async input => ({ task: { ...tasks[0], id: 'new', instruction: input.prompt } })),
    update: vi.fn(async id => ({ task: tasks.find(task => task.id === id)! })),
    pause: vi.fn(), run: vi.fn(), runs: vi.fn(async () => ({ runs: [] })),
    steps: vi.fn(async () => ({ steps: [] })), stop: vi.fn(), selection: vi.fn(),
  };
}
describe('shared task body', () => {
  it.each([false, true])('uses the host drawer capability without duplicate back navigation (drawer=%s)', async hosted => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const task = { id: 'one', instruction: 'Read', assignedTo: owner, status: 'open', createdAt: 1, updatedAt: 1 };
    render(<WorkspaceDrawerContext.Provider value={hosted ? { open: false } : undefined}><TasksPanel client={clientFor([task])} webId={owner} workspace="https://pod.test/work/" selectedTaskId="one" /></WorkspaceDrawerContext.Provider>);
    await screen.findByRole('heading', { name: 'Read' });
    expect(Boolean(screen.queryByRole('button', { name: '返回任务清单' }))).toBe(!hosted);
  });
  it('limits todos to five, reveals more, and completes through the client', async () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({ id: `todo${i}`, instruction: `Read ${i}`, assignedTo: owner, status: 'open', createdAt: i, updatedAt: 0 }));
    const client = clientFor(tasks);
    render(<TasksPanel client={client} webId={owner} workspace="https://pod.test/work/" />);
    await screen.findByText('还有 2 条');
    expect(screen.queryByText('Read 6')).toBeNull();
    fireEvent.click(screen.getByText('还有 2 条'));
    expect(screen.getByText('Read 6')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '完成 Read 0' }));
    await waitFor(() => expect(client.update).toHaveBeenCalledWith('todo0', { completed: true }));
  });
  it('marks unavailable AI creation and never offers a one-shot option', async () => {
    render(<TasksPanel client={clientFor([])} webId={owner} workspace="https://pod.test/work/" />);
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    await screen.findByText('代理执行身份待接入。你可以先在清单中添加自己的待办。');
    expect(screen.getByRole('button', { name: '创建任务' }).hasAttribute('disabled')).toBe(true);
    for (const label of ['定时', '周期', '事件']) expect(screen.getByRole('radio', { name: label })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: '一次' })).toBeNull();
    expect(screen.queryByLabelText('一次')).toBeNull();
  });
  it('opens a full Task IRI supplied by a host notification', async () => {
    const task = { id: 'index.ttl#one', iri: 'https://pod.test/.data/task/index.ttl#one', instruction: 'Read', assignedTo: owner, status: 'open', createdAt: 1, updatedAt: 1 };
    render(<TasksPanel client={clientFor([task])} webId={owner} workspace="https://pod.test/work/" selectedTaskId={task.iri} />);
    expect(await screen.findByRole('heading', { name: 'Read' })).toBeTruthy();
  });
  it('switches assignment filter and view through shared single-choice controls', async () => {
    const tasks = [
      { id: 'mine1', instruction: 'Mine only', assignedTo: owner, status: 'open', createdAt: 1, updatedAt: 1 },
      { id: 'ai1', instruction: 'AI schedule', assignedTo: 'https://pod.test/ai', status: 'active', createdAt: 2, updatedAt: 2, schedule: { kind: 'cron', cron: '0 8 * * *', nextRunAt: 4102444800, paused: false } },
    ];
    render(<TasksPanel client={clientFor(tasks)} webId={owner} workspace="https://pod.test/work/" />);
    await screen.findByText('Mine only');

    expect(screen.getByRole('radiogroup', { name: '交给谁' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'AI 的' }));
    expect((screen.getByRole('radio', { name: 'AI 的' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText('Mine only')).toBeNull();
    expect(screen.getByText('AI schedule')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: '日程' }));
    expect((screen.getByRole('radio', { name: '日程' }) as HTMLInputElement).checked).toBe(true);
  });
});

 it('preserves todo form values and AI schedule submission through native control events', async () => {
    const task = { id: 'todo', instruction: 'Read', assignedTo: owner, status: 'open', createdAt: 1, updatedAt: 1 };
    const client = clientFor([task]);
    vi.mocked(client.list).mockResolvedValue({ tasks: [task], capabilities: { createAi: true, resumeStep: false, handoff: false, approve: false } });
    render(<TasksPanel client={client} webId={owner} workspace="https://pod.test/work/" selectedTaskId="todo" />);
    await screen.findByRole('heading', { name: 'Read' });
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: 'Keep notes' } });
    fireEvent.change(screen.getByLabelText('重要程度'), { target: { value: 'urgent' } });
    fireEvent.change(screen.getByLabelText('截止日期'), { target: { value: '2026-10-03T09:30' } });
    fireEvent.click(screen.getByRole('button', { name: '保存待办' }));
    await waitFor(() => expect(client.update).toHaveBeenCalledWith('todo', { notes: 'Keep notes', priority: 'urgent', dueAt: new Date('2026-10-03T09:30').getTime() / 1000 }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存待办' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    fireEvent.change(screen.getByLabelText('要做什么'), { target: { value: 'Read news' } });
    fireEvent.click(screen.getByRole('radio', { name: '周期' }));
    fireEvent.change(screen.getByLabelText('每隔多少分钟'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(client.create).toHaveBeenCalledWith({ prompt: 'Read news', kind: 'interval', intervalSeconds: 900, workspace: 'https://pod.test/work/' }));
  });

describe('scheduled task behavior', () => {
  const aiOwner = 'https://pod.test/ai';
  it('renders the kind glyph and accessible label for cron, interval and event', async () => {
    const tasks = [
      { id: 'cron', instruction: 'Cron task', assignedTo: aiOwner, status: 'active', createdAt: 1, updatedAt: 1, schedule: { kind: 'cron' as const, cron: '0 8 * * *' } },
      { id: 'interval', instruction: 'Interval task', assignedTo: aiOwner, status: 'active', createdAt: 2, updatedAt: 2, schedule: { kind: 'interval' as const, intervalSeconds: 60 } },
      { id: 'event', instruction: 'Event task', assignedTo: aiOwner, status: 'active', createdAt: 3, updatedAt: 3, schedule: { kind: 'event' as const, eventName: 'deploy' } },
    ];
    const { container } = render(<TasksPanel client={clientFor(tasks)} webId={owner} workspace="https://pod.test/work/" />);
    await screen.findByText('Cron task');
    expect(container.querySelector('[aria-label="定时"]')?.textContent).toBe('▦');
    expect(container.querySelector('[aria-label="周期"]')?.textContent).toBe('↻');
    expect(container.querySelector('[aria-label="事件"]')?.textContent).toBe('ϟ');
  });
  it('runs, pauses future runs, and stops the current run through distinct client commands', async () => {
    const task = { id: 'sched', instruction: 'Scheduled', assignedTo: aiOwner, status: 'active', createdAt: 1, updatedAt: 1, schedule: { kind: 'cron' as const, cron: '0 8 * * *', paused: false } };
    const runningRun = { id: 'run1', status: 'running', createdAt: 1 };
    const client = clientFor([task]);
    vi.mocked(client.run).mockResolvedValue({ run: runningRun } as never);
    vi.mocked(client.runs).mockResolvedValue({ runs: [runningRun] } as never);
    vi.mocked(client.stop).mockResolvedValue({ run: { ...runningRun, cancelRequestedAt: 5 } } as never);
    render(<TasksPanel client={client} webId={owner} workspace="https://pod.test/work/" selectedTaskId="sched" />);
    await screen.findByRole('heading', { name: 'Scheduled' });
    fireEvent.click(screen.getByRole('button', { name: '立即运行一次' }));
    await waitFor(() => expect(client.run).toHaveBeenCalledWith('sched'));
    fireEvent.click(screen.getByRole('button', { name: '暂停后续运行' }));
    await waitFor(() => expect(client.pause).toHaveBeenCalledWith('sched', true));
    fireEvent.click(await screen.findByRole('button', { name: '停止这次运行' }));
    await waitFor(() => expect(client.stop).toHaveBeenCalledWith('run1'));
  });
  it('disables run-once and pause for an ended scheduled task', async () => {
    const task = { id: 'done', instruction: 'Done task', assignedTo: aiOwner, status: 'completed', createdAt: 1, updatedAt: 1, schedule: { kind: 'cron' as const, cron: '0 8 * * *' } };
    render(<TasksPanel client={clientFor([task])} webId={owner} workspace="https://pod.test/work/" selectedTaskId="done" />);
    await screen.findByRole('heading', { name: 'Done task' });
    expect((screen.getByRole('button', { name: '立即运行一次' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '暂停后续运行' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('never renders a supplied runner identity in the list or detail', async () => {
    const task = { id: 'r1', instruction: 'Agent work', assignedTo: aiOwner, status: 'active', createdAt: 1, updatedAt: 1, runner: 'pi:pi', schedule: { kind: 'cron' as const, cron: '0 8 * * *' } } as unknown as TaskSummary;
    const { container } = render(<TasksPanel client={clientFor([task])} webId={owner} workspace="https://pod.test/work/" selectedTaskId="r1" />);
    await screen.findByRole('heading', { name: 'Agent work' });
    expect(container.textContent).not.toContain('pi:pi');
  });
});

 it('shows the recorded task workspace without claiming it limits Pod authorization', async () => {
    const task = { id: 'scope-task', instruction: 'Review documents', assignedTo: 'urn:xpod:agent:pi', workspace: 'https://pod.test/project/', status: 'blocked', createdAt: 1, updatedAt: 1 };
    render(<TasksPanel client={clientFor([task])} webId={owner} workspace="https://pod.test/other/" selectedTaskId={task.id} />);
    expect(await screen.findByText('工作空间：https://pod.test/project/')).toBeTruthy();
    expect(screen.getByText('工作空间不代表授权范围。实际可读写的资料由 Pod 权限决定，逐项授权明细待接入。')).toBeTruthy();
    expect(screen.queryByText('工作空间：https://pod.test/other/')).toBeNull();
  });
