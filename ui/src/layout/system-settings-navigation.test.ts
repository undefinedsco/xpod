import { describe, expect, test } from 'bun:test';
import { systemSettingsNavigationItems } from './system-settings-navigation';

describe('System Settings navigation', () => {
  test('keeps only low-frequency configuration domains', () => {
    expect(systemSettingsNavigationItems.map((item) => item.label)).toEqual([
      'Pod', 'Identity & Access', 'Storage', 'Runtime', 'Cloud', 'Advanced',
    ]);
    expect(systemSettingsNavigationItems.some((item) => /usage|network|model/i.test(item.label))).toBe(false);
  });
});
