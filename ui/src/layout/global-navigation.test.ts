import { describe, expect, test } from 'vitest';

import { globalNavigationItems, isGlobalNavigationItemActive } from './global-navigation';

/**
 * 顶层导航契约（spec §3.1/§3.3、AC-04）：四个任务域、独立身份入口、规范路径不重叠。
 */
describe('global navigation contract', () => {
  test('exposes exactly the four task entries with their spec labels and targets', () => {
    expect(globalNavigationItems.map((item) => [item.id, item.label, item.href])).toEqual([
      ['overview', '概览', '/status/overview'],
      ['storage', '存储空间', '/settings/pod'],
      ['ai', 'AI', '/ai-connections'],
      ['services', '服务与访问', '/settings/runtime'],
    ]);
    expect(globalNavigationItems.map((item) => item.labelEn)).toEqual([
      'Overview', 'Storage Spaces', 'AI', 'Services & Access',
    ]);
  });

  test('never lets two entries claim the same path', () => {
    // 旧根路径（/status、/settings）先被重定向到规范路径，所以 0 或 1 都合法，2 一定不对
    for (const path of ['/status', '/settings', '/ai-config', '/network', '/status/overview', '/settings/pod']) {
      const matches = globalNavigationItems.filter((item) => isGlobalNavigationItemActive(item, path));
      expect(matches.length, `${path} matched ${matches.length} entries`).toBeLessThanOrEqual(1);
    }
    expect(globalNavigationItems.filter((item) => isGlobalNavigationItemActive(item, '/settings/pod'))
      .map((item) => item.id)).toEqual(['storage']);
  });

  test('routes the AI Config deep links to their owning entry', () => {
    const owner = (path: string) => globalNavigationItems
      .filter((item) => isGlobalNavigationItemActive(item, path)).map((item) => item.id);

    // §3.1：用途模型与资料处理属 AI；空间搜索索引与维护任务属存储空间
    expect(owner('/ai-config/model-assignments')).toEqual(['ai']);
    expect(owner('/ai-config/document-processing')).toEqual(['ai']);
    expect(owner('/ai-config/search-indexing')).toEqual(['storage']);
    expect(owner('/ai-config/index-lifecycle')).toEqual(['storage']);
  });

  test('keeps professional deep links inside the services entry', () => {
    const owner = (path: string) => globalNavigationItems
      .filter((item) => isGlobalNavigationItemActive(item, path)).map((item) => item.id);

    for (const path of ['/settings/runtime', '/network/overview', '/network/domain-dns', '/status/logs',
      '/status/services/gateway', '/status/index/vector', '/status/usage/bandwidth']) {
      expect(owner(path), path).toEqual(['services']);
    }
    expect(owner('/status/overview')).toEqual(['overview']);
  });
});
