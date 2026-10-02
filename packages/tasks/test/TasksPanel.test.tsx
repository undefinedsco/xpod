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
