// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { StatusBar } from './StatusBar';
import type { ServiceState } from '@/api/admin';

afterEach(cleanup);

const running = (name: string): ServiceState => ({ name, status: 'running', restartCount: 0 });

test('projects the real service state and keeps the Pod action available when healthy', () => {
  render(<StatusBar services={[running('css'), running('api')]} onRestart={vi.fn()} restarting={false} />);
  expect(screen.getByText('运行中')).toBeTruthy();
  expect(screen.getByText('CSS: 正常')).toBeTruthy();
  expect(screen.getByText('API: 正常')).toBeTruthy();
  expect((screen.getByRole('button', { name: /打开 Pod/ }) as HTMLButtonElement).disabled).toBe(false);
});

test('reports a stopped service and does not offer the Pod action', () => {
  render(<StatusBar services={[{ name: 'css', status: 'stopped', restartCount: 0 }]} onRestart={vi.fn()} restarting={false} />);
  expect(screen.getByText('服务异常')).toBeTruthy();
  expect(screen.getByText('CSS: 停止')).toBeTruthy();
  expect((screen.getByRole('button', { name: /打开 Pod/ }) as HTMLButtonElement).disabled).toBe(true);
});

test('wires the restart action without inventing state', () => {
  const onRestart = vi.fn();
  render(<StatusBar services={null} onRestart={onRestart} restarting={false} />);
  fireEvent.click(screen.getByRole('button', { name: /重启/ }));
  expect(onRestart).toHaveBeenCalledOnce();
});
