import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

describe('dashboard runtime console routes', () => {
  it('keeps runtime settings out of the account/OIDC app', async () => {
    const app = await readRepoFile('ui/src/App.tsx');

    expect(app).not.toContain("./pages/admin/SettingsPage");
    expect(app).not.toContain('/.account/settings/');
  });

  it('uses deep-linkable dashboard routes for status, logs and settings', async () => {
    const dashboardApp = await readRepoFile('ui/src/DashboardApp.tsx');
    const adminLayout = await readRepoFile('ui/src/pages/admin/AdminLayout.tsx');
    const sidebar = await readRepoFile('ui/src/components/ui/Sidebar.tsx');

    expect(dashboardApp).toContain('BrowserRouter');
    expect(dashboardApp).toContain('basename="/dashboard"');
    expect(dashboardApp).toContain('path="status"');
    expect(dashboardApp).toContain('path="logs"');
    expect(dashboardApp).toContain('path="settings"');
    expect(dashboardApp).toContain('to="/status"');
    expect(adminLayout).toContain('Outlet');
    expect(adminLayout).not.toContain('useState<AdminPage>');
    expect(sidebar).toContain('NavLink');
    expect(sidebar).toContain('MobileDashboardNav');
    expect(sidebar).toContain('sm:hidden');
    expect(sidebar).toContain("to: '/status'");
    expect(sidebar).toContain("to: '/logs'");
    expect(sidebar).toContain("to: '/settings'");
  });
});

describe('upgraded dashboard pages', () => {
  it('uses the flat taro runtime palette and tactile buttons instead of default high-saturation purple', async () => {
    const indexCss = await readRepoFile('ui/src/index.css');
    const button = await readRepoFile('ui/src/components/ui/Button.tsx');

    expect(indexCss).toContain('Flat taro');
    expect(indexCss).not.toContain('Primary: Violet (#7C3AED / #8B5CF6)');
    expect(indexCss).not.toContain('--primary: 262.1 83.3% 57.8%;');
    expect(indexCss).not.toContain('--primary: 263.4 70% 50.4%;');
    expect(button).toContain('active:translate-y-px');
  });

  it('has a status page centered on reachability, routes and diagnostics evidence', async () => {
    const statusPagePath = path.join(root, 'ui/src/pages/admin/StatusPage.tsx');
    expect(existsSync(statusPagePath)).toBe(true);

    const statusPage = await readRepoFile('ui/src/pages/admin/StatusPage.tsx');
    expect(statusPage).toContain('RouteTable');
    expect(statusPage).toContain('RouteSummaryCards');
    expect(statusPage).toContain('访问路径');
    expect(statusPage).toContain('完整路径详情');
    expect(statusPage).toContain('Loopback');
    expect(statusPage).toContain('LAN');
    expect(statusPage).toContain('Public');
    expect(statusPage).toContain('User tunnel');
    expect(statusPage).toContain('ActionNeededCard');
    expect(statusPage).toContain('稳定资料入口');
    expect(statusPage).toContain('当前建议路径');
    expect(statusPage).toContain('recommendedRoute');
    expect(statusPage).toContain('copyStableUrl');
    expect(statusPage).toContain('loadError');
    expect(statusPage).toContain('复制状态 JSON');
    expect(statusPage).toContain('lastCheckedAt');
    expect(statusPage).toContain('resolveAccessBaseUrl');
    expect(statusPage).toContain('getPublicIpCheck(resolveAccessBaseUrl(configData?.env ?? {}, ddnsData))');
    expect(statusPage).toContain('serviceRouteState');
    expect(statusPage.indexOf('<ActionNeededCard')).toBeLessThan(statusPage.indexOf('<RouteTable'));
    expect(statusPage.indexOf('Cloud 协调')).toBeLessThan(statusPage.indexOf('配置摘要'));
    expect(statusPage).toContain('bg-muted/30');
    expect(statusPage).not.toContain('env.CSS_BASE_URL || ddnsStatus?.baseUrl');
    expect(statusPage).not.toContain('cancelled = true;\\n      cancelled = true;');
  });

  it('upgrades logs with diagnostics export, keyword filtering and stream error states', async () => {
    const logsPage = await readRepoFile('ui/src/pages/admin/LogsPage.tsx');
    const adminApi = await readRepoFile('ui/src/api/admin.ts');

    expect(logsPage).toContain('DiagnosticsPanel');
    expect(logsPage).toContain('keywordFilter');
    expect(logsPage).toContain('streamError');
    expect(logsPage).toContain('autoScroll');
    expect(logsPage).toContain('导出诊断');
    expect(logsPage).toContain('ERR_NGROK_8001');
    expect(logsPage).toContain('getLogFileTail');
    expect(logsPage).toContain('lg:grid-cols-[1fr_auto]');
    expect(logsPage).not.toContain("behavior: 'smooth'");
    expect(adminApi).toContain('${API_BASE}/logs');
    expect(adminApi).toContain('${API_BASE}/logs/stream');
    expect(adminApi).not.toContain('/service/logs/stream');
  });

  it('upgrades settings with one active tunnel provider, write-only secrets and pending changes', async () => {
    const settingsPage = await readRepoFile('ui/src/pages/admin/SettingsPage.tsx');
    const secretField = await readRepoFile('ui/src/components/admin/SecretField.tsx');

    expect(settingsPage).toContain("type TunnelProvider = 'none' | 'ngrok' | 'cloudflare' | 'sakura_frp' | 'frp'");
    expect(settingsPage).toContain('TunnelProviderFieldSpec');
    expect(settingsPage).toContain('publicEndpointKey');
    expect(settingsPage).toContain('credentialKey');
    expect(settingsPage).toContain('getTunnelProviderFields');
    expect(settingsPage).toContain('隧道入口 URL');
    expect(settingsPage).toContain('访问密钥');
    expect(settingsPage).toContain('ngrok 固定入口 URL');
    expect(settingsPage).toContain('Cloudflare Tunnel 公开入口');
    expect(settingsPage).toContain('FRP 公开入口 URL');
    expect(settingsPage).toContain('Sakura FRP 公开入口 URL');
    expect(settingsPage).toContain('不使用隧道时，不填写隧道入口 URL 或访问密钥。');
    expect(settingsPage).toContain('NGROK_AUTHTOKEN');
    expect(settingsPage).toContain('FRP_TUNNEL_TOKEN');
    expect(settingsPage).toContain('SecretField');
    expect(settingsPage).toContain('PendingChangesPanel');
    expect(settingsPage).toContain('LinX');
    expect(settingsPage).toContain('高级运行时设置');
    expect(settingsPage).toContain('网络访问');
    expect(settingsPage).toContain('managedBaseUrl');
    expect(settingsPage).toContain('ddnsStatus?.baseUrl');
    expect(settingsPage).toContain('readOnly={isManaged}');
    expect(settingsPage.split("isManaged && ddnsStatus?.mode === 'tunnel' && tunnelProvider === 'none'").length - 1).toBeGreaterThanOrEqual(2);
    expect(settingsPage).not.toContain('ddnsStatus?.fqdn || env.CSS_BASE_URL');
    expect(settingsPage).not.toContain('value={env.CLOUDFLARE_TUNNEL_TOKEN');
    expect(settingsPage).not.toContain('label="ngrok 固定入口"');
    expect(settingsPage).not.toContain('label="FRP 入口 URL"');
    expect(secretField).toContain('已配置');
    expect(secretField).toContain('填写新 secret');
  });

  it('removes the stale single-page dashboard implementation', () => {
    expect(existsSync(path.join(root, 'ui/src/pages/admin/DashboardPage.tsx'))).toBe(false);
  });

  it('does not use em dash or en dash typography tells in admin pages', async () => {
    const files = [
      'ui/src/pages/admin/StatusPage.tsx',
      'ui/src/pages/admin/LogsPage.tsx',
      'ui/src/pages/admin/SettingsPage.tsx',
      'ui/src/components/admin/PendingChangesPanel.tsx',
      'ui/src/components/admin/SecretField.tsx',
      'ui/src/components/admin/StatusBadge.tsx',
    ];

    for (const file of files) {
      const source = await readRepoFile(file);
      expect(source, file).not.toMatch(/[\u2014\u2013]/);
    }
  });
});
