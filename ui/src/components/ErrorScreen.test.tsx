import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ErrorScreen } from './ErrorScreen';

afterEach(cleanup);

it('keeps technical details secondary and retries the failed Account step', () => {
  const retry = vi.fn();
  render(<ErrorScreen message="Failed to load account controls (Status: 500)" retry={retry} />);
  expect(screen.getByRole('heading', { name: '账号服务暂时不可用' })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).not.toContain('Status: 500');
  const details = screen.getByText('技术详情').closest('details');
  expect(details?.hasAttribute('open')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(retry).toHaveBeenCalledTimes(1);
});
