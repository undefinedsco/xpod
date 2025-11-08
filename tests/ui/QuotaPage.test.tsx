import { describe, it, expect } from 'vitest';
import { QuotaPage } from '../../ui/admin/src/pages/QuotaPage';
import { AdminConfigContext, type AdminConfig } from '../../ui/admin/src/context/AdminConfigContext';
import { render } from './testUtils';

function renderWithConfig(config: AdminConfig) {
  return render(
    <AdminConfigContext.Provider value={config}>
      <QuotaPage />
    </AdminConfigContext.Provider>,
  );
}

const baseConfig: AdminConfig = {
  edition: 'cluster',
  features: { quota: true, nodes: false },
  baseUrl: undefined,
  signalEndpoint: undefined,
};

describe('QuotaPage', () => {
  it('在集群模式下显示配额卡片', () => {
    const { container, unmount } = renderWithConfig(baseConfig);
    try {
      expect(container.textContent).toContain('Quota enforcement');
      expect(container.textContent).toContain('UsageTrackingStore');
    } finally {
      unmount();
    }
  });

  it('在本地模式下提示集群专属功能', () => {
    const { container, unmount } = renderWithConfig({
      ...baseConfig,
      edition: 'local',
      features: { quota: false, nodes: false },
    });
    try {
      expect(container.textContent).toContain('Cluster-only feature');
      expect(container.textContent).toContain('This capability is disabled on local profiles.');
    } finally {
      unmount();
    }
  });
});
