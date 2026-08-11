import { describe, expect, it } from 'vitest';
import {
  normalizeApplicationReturnTo,
  normalizeWebIdLoginRoute,
  normalizeWebIdLoginTransaction,
  type WebIdLoginActions,
  type WebIdLoginRouteDescriptor,
  type WebIdLoginTransaction,
} from '../src/webid-auth';

function createRoute(): WebIdLoginRouteDescriptor {
  return {
    id: 'current-origin',
    label: 'This browser',
    description: 'Use the identity provider configured for this host.',
    badge: { label: 'Recommended', tone: 'primary' },
    identityProvider: {
      url: 'https://id.example/oidc',
      label: 'Identity provider',
    },
    storageProvider: {
      url: 'https://pod.example/',
      label: 'Storage provider',
    },
    availability: 'ready',
  };
}

describe('WebID login contracts', () => {
  it('normalizes a route with identityProvider only without treating its id as an issuer', () => {
    const route: WebIdLoginRouteDescriptor = {
      id: 'local',
      label: 'Local identity',
      identityProvider: { url: 'https://id.example/oidc', label: 'Identity' },
      availability: 'ready',
    };

    const normalized = normalizeWebIdLoginRoute(route);

    expect(normalized).toEqual({
      ...route,
      identityProvider: {
        url: 'https://id.example/oidc',
        label: 'Identity',
      },
    });
    expect(normalized).not.toBe(route);
    expect(normalized.identityProvider).not.toBe(route.identityProvider);
    expect(normalized.id).toBe('local');
  });

  it('normalizes distinct identity and storage provider endpoints', () => {
    const route = createRoute();
    const normalized = normalizeWebIdLoginRoute(route);

    expect(normalized.identityProvider.url).toBe('https://id.example/oidc');
    expect(normalized.storageProvider?.url).toBe('https://pod.example/');
    expect(normalized.identityProvider.url).not.toBe(normalized.storageProvider?.url);
    expect(normalized).not.toBe(route);
  });

  it('rejects endpoint credentials and fragments', () => {
    expect(() => normalizeWebIdLoginRoute({
      ...createRoute(),
      identityProvider: { url: 'https://user:pass@id.example/oidc', label: 'Identity' },
    })).toThrow(/credentials/i);
    expect(() => normalizeWebIdLoginRoute({
      ...createRoute(),
      storageProvider: { url: 'https://pod.example/#storage', label: 'Storage' },
    })).toThrow(/fragment/i);
  });

  it('keeps transaction id separate from provider identity and allows no selected storage', () => {
    const transaction: WebIdLoginTransaction = {
      id: 'txn-opaque-123',
      route: {
        ...createRoute(),
        storageProvider: undefined,
      },
      authorizationSurface: 'redirect',
      discovery: 'strict',
      returnTo: '/settings/connections',
    };

    const normalized = normalizeWebIdLoginTransaction(transaction);

    expect(normalized.id).toBe('txn-opaque-123');
    expect(normalized.route.id).toBe('current-origin');
    expect(normalized.route.identityProvider.url).toBe('https://id.example/oidc');
    expect(normalized.selectedStorage).toBeUndefined();
    expect(normalized).not.toBe(transaction);
    expect(normalized.route).not.toBe(transaction.route);
  });

  it('rejects authorization parameters that could override Inrupt-owned protocol values', () => {
    const forbidden = [
      'state',
      'redirect_uri',
      'client_id',
      'response_type',
      'code_challenge',
      'code_challenge_method',
    ];

    for (const key of forbidden) {
      expect(() => normalizeWebIdLoginTransaction({
        id: 'txn',
        route: createRoute(),
        authorizationSurface: 'popup',
        discovery: 'standard',
        authorizationParameters: { [key]: 'attacker-value' },
      })).toThrow(new RegExp(key));
    }
  });

  it('rejects unsafe application return paths and paths outside the host allow-list', () => {
    const allowed = ['/dashboard', '/settings'];
    for (const unsafe of [
      'https://evil.example/steal',
      '//evil.example/steal',
      '/settings\\evil',
      '/settings/%2e%2e/admin',
    ]) {
      expect(() => normalizeApplicationReturnTo(unsafe, allowed)).toThrow();
    }

    expect(normalizeApplicationReturnTo('/settings/profile', allowed)).toBe('/settings/profile');
    expect(() => normalizeApplicationReturnTo('/admin', allowed)).toThrow(/allow/i);
  });

  it('exposes independent start, optional cancellation/retry, and logout actions', async () => {
    const started: WebIdLoginTransaction[] = [];
    const actions: WebIdLoginActions = {
      start: (transaction) => {
        started.push(transaction);
      },
      logout: async () => undefined,
    };
    const transaction = normalizeWebIdLoginTransaction({
      id: 'txn',
      route: createRoute(),
      authorizationSurface: 'redirect',
      discovery: 'standard',
    });

    await actions.start(transaction);
    await actions.logout();

    expect(started).toEqual([transaction]);
    expect(actions.cancel).toBeUndefined();
    expect(actions.retry).toBeUndefined();
  });
});
