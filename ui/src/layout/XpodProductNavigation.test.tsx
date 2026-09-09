// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ProductNavLinks } from './XpodProductLayout';
import { globalNavigationItems } from './global-navigation';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

function CurrentLocation() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}</output>;
}

describe('Xpod product rail navigation', () => {
  test('handles same-product entry switches inside the shared router', () => {
    render(
      <MemoryRouter initialEntries={['/ai-connections']}>
        <ProductNavLinks items={globalNavigationItems} label="Primary Xpod workspaces" />
        <CurrentLocation />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByLabelText('AI Config'));

    expect(screen.getByLabelText('Current route').textContent).toBe('/ai-config/model-assignments');
  });

  test('handles Dashboard-to-Settings entry switches without replacing the document', () => {
    render(
      <MemoryRouter initialEntries={['/status/overview']}>
        <ProductNavLinks items={globalNavigationItems} label="Primary Xpod workspaces" />
        <CurrentLocation />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByLabelText('AI Connections'));

    expect(screen.getByLabelText('Current route').textContent).toBe('/ai-connections');
  });
});
