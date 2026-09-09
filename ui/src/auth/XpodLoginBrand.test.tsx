// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { XpodLoginBrand } from './XpodLoginBrand';

afterEach(() => cleanup());

describe('Xpod login brand', () => {
  test('renders the standalone shield without a second rounded tile', () => {
    const { container } = render(<XpodLoginBrand />);
    const icon = container.querySelector('img');

    expect(icon).toBeTruthy();
    expect(icon?.className).toContain('h-11');
    expect(icon?.parentElement?.className).not.toContain('rounded-');
    expect(screen.getByRole('heading', { name: 'Xpod' })).toBeTruthy();
    expect(screen.getByText('使用 WebID 登录')).toBeTruthy();
  });

  test('uses one compact identity row for transient and failure states', () => {
    const { container } = render(<XpodLoginBrand compact />);
    const brand = screen.getByTestId('xpod-login-brand');
    const icon = container.querySelector('img');

    expect(brand.getAttribute('data-presentation')).toBe('compact');
    expect(icon?.className).toContain('h-7');
    expect(screen.getByRole('heading', { name: 'Xpod' })).toBeTruthy();
    expect(screen.queryByText('使用 WebID 登录')).toBeNull();
  });

  test('can retain the shared subtitle in compact authentication cards', () => {
    const { container } = render(<XpodLoginBrand compact showSubtitle subtitle="使用 WebID 账号" />);
    const brand = screen.getByTestId('xpod-login-brand');

    expect(container.querySelector('img')?.className).toContain('h-16');
    expect(brand.className).toContain('flex-col');
    expect(brand.className).toContain('items-center');
    expect(screen.getByText('使用 WebID 账号')).toBeTruthy();
  });
});
