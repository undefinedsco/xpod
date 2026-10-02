import { describe, expect, test } from 'vitest';
import { globalNavigationItems, isGlobalNavigationItemActive } from './global-navigation';

describe('desktop shell navigation', () => {
  test('keeps applets above local host controls', () => {
    expect(globalNavigationItems.map(({ label, href }) => [label, href])).toEqual([
      ['任务', '/tasks'], ['AI 连接', '/ai-connections'], ['Pod', '/pod/models'],
      ['这台设备', '/device/network'], ['设置', '/settings/appearance'],
    ]);
  });
  test('selects exactly one owner for every canonical destination', () => {
    for (const item of globalNavigationItems) {
      expect(globalNavigationItems.filter(candidate => isGlobalNavigationItemActive(candidate, item.href)).map(value => value.id)).toEqual([item.id]);
    }
  });
});
