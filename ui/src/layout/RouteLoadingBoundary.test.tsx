import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RouteLoadingBoundary } from './RouteLoadingBoundary';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('RouteLoadingBoundary', () => {
  test('uses a product-neutral loading message', () => {
    const Pending = () => { throw Promise.resolve(); };
    const html = renderToStaticMarkup(<RouteLoadingBoundary><Pending /></RouteLoadingBoundary>);
    expect(html).toContain('正在打开…');
    expect(html).not.toContain('Loading settings');
  });

  test('does not call an ordinary render error an outdated page or expired session', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Broken = () => { throw new Error('Missing product context'); };
    render(<RouteLoadingBoundary><Broken /></RouteLoadingBoundary>);
    expect(screen.getByText('页面暂时无法打开')).toBeDefined();
    expect(screen.queryByText('页面已更新')).toBeNull();
  });

  test('offers a reload for an actual failed chunk import', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Broken = () => { throw new Error('Failed to fetch dynamically imported module: /chunk.js'); };
    render(<RouteLoadingBoundary><Broken /></RouteLoadingBoundary>);
    expect(screen.getByText('页面已更新')).toBeDefined();
    expect(screen.getByRole('button', { name: '重新载入' })).toBeDefined();
  });
});
