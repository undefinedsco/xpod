import { describe, expect, test } from 'bun:test';
import { systemSettingsNavigationGroups } from './system-settings-navigation';

const items = systemSettingsNavigationGroups.flatMap((group) => group.items);

describe('System Settings navigation', () => {
  test('keeps only low-frequency configuration domains', () => {
    expect(items.map((item) => item.label)).toEqual([
      'Pod', 'Identity & Access', 'Storage', 'Runtime', 'Cloud', 'Advanced',
    ]);
    expect(items.some((item) => /usage|network|model/i.test(item.label))).toBe(false);
  });

  test('separates the signed-in account from settings the whole node shares', () => {
    expect(systemSettingsNavigationGroups.map((group) => [group.scope, group.items.map((item) => item.id)]))
      .toEqual([
        ['account', ['pod', 'identity-access']],
        ['node', ['storage', 'runtime', 'cloud', 'advanced']],
      ]);
  });
});
