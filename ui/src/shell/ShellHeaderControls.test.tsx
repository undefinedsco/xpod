import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ShellDecisionFeedback, ShellHeaderControls } from './ShellHeaderControls';

const state = vi.hoisted(() => ({ snapshot: { attention: [{ id: 'approval', title: '访问申请', href: '/inbox', kind: 'approval' }], activity: [{ id: 'event', title: '新建任务', href: '/tasks', createdAt: '2026-10-01' }], inbox: [], inProgress: [] }, resumeFailures: [], retryResume: vi.fn(), loading: false, error: undefined, refresh: vi.fn(), markAllRead: vi.fn(), decide: vi.fn() }));
vi.mock('./useShellState', () => ({ useShellState: () => state }));
afterEach(cleanup);
it('separates attention from events and closes with Escape restoring trigger focus', () => {
  render(<MemoryRouter><ShellHeaderControls /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '通知' }));
  expect(screen.getByRole('region', { name: '通知中心' })).toBeTruthy();
  expect(screen.getByText('需要你处理')).toBeTruthy();
  expect(screen.getByText('动态')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '全部已读' }));
  expect(state.markAllRead).toHaveBeenCalledOnce();
  expect(screen.getByText('访问申请 ›')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('region')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '通知' }));
});
it('shows the actual empty inbox without fabricated messages', () => {
  render(<MemoryRouter><ShellHeaderControls /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '收件箱' }));
  expect(screen.getByText('收件箱是空的')).toBeTruthy();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('region')).toBeNull();
});

it('offers recovery from an authoritative persisted approval pointer after reload', () => {
  render(<ShellDecisionFeedback run="https://pod/run" recoveryApproval="https://pod/approval" />);
  fireEvent.click(screen.getByRole('button', { name: '重试处理运行' }));
  expect(state.retryResume).toHaveBeenCalledWith('https://pod/approval', 'https://pod/run');
  expect(state.decide).not.toHaveBeenCalled();
});
