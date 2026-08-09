import { describe, expect, test } from 'bun:test';
import { networkNavigationItems } from './network-navigation';

describe('Network navigation', () => {
  test('contains the eight direct network subjects', () => {
    expect(networkNavigationItems.map((item) => item.label)).toEqual([
      'Overview', 'Endpoints', 'Addresses', 'Domain & DNS', 'HTTPS', 'Tunnel Profiles', 'P2P', 'Diagnostics',
    ]);
  });
});
