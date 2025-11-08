import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from '../../ui/admin/src/components/AppShell';
import type { NavigationEntry } from '../../ui/admin/src/types/ui';
import { render } from './testUtils';

describe('AppShell', () => {
  it('在本地版中为集群专属路由显示提示', () => {
    const routes: NavigationEntry[] = [
      { path: '/', translationKey: 'navigation.dashboard', icon: <span data-testid="icon" /> },
      { path: '/quota', translationKey: 'navigation.quota', icon: <span />, clusterOnly: true },
    ];

    const { container, unmount } = render(
      <MemoryRouter>
        <AppShell routes={routes} edition="local">
          <div>content</div>
        </AppShell>
      </MemoryRouter>,
    );

    try {
      const navItems = Array.from(container.querySelectorAll('nav a'));
      expect(navItems).toHaveLength(2);
      expect(navItems[0].textContent).toContain('Dashboard');
      expect(navItems[1].textContent).toContain('Quota & Billing');
      expect(navItems[1].textContent).toContain('Cluster-only feature');
    } finally {
      unmount();
    }
  });
});
