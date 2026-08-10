import { describe, expect, test, vi } from 'vitest';
import type { StorageBinding, WebIdLoginTransaction } from '@undefineds.co/solid-sdk';
import {
  XpodLoginTransactionError,
  createXpodLoginTransactionStore,
  createOpaqueTransactionId,
} from './xpod-login-transaction';

const route = {
  id: 'xpod-current-origin',
  label: 'Xpod',
  identityProvider: { url: 'https://app.example', label: 'app.example' },
  storageProvider: { url: 'https://app.example', label: 'app.example' },
  availability: 'ready' as const,
};

const binding: StorageBinding = {
  storageUrl: 'https://app.example/alice/',
  webId: 'https://app.example/alice/profile/card#me',
};

function transaction(overrides: Partial<WebIdLoginTransaction> = {}): WebIdLoginTransaction {
  return {
    id: createOpaqueTransactionId(),
    route,
    authorizationSurface: 'redirect',
    discovery: 'strict',
    returnTo: '/dashboard/overview',
    ...overrides,
  };
}

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
  } satisfies Storage;
}

describe('xpod login transaction store', () => {
  test('stores one opaque, versioned public transaction and reads it without consuming it', () => {
    const store = storage();
    const tx = transaction({ authorizationParameters: { scope: 'openid' }, selectedStorage: binding });
    const coordinator = createXpodLoginTransactionStore({ storage: store, origin: 'https://app.example', now: () => 1000 });

    coordinator.begin(tx);
    const pending = coordinator.readSinglePending();

    expect(pending?.id).toBe(tx.id);
    expect(pending?.route).toEqual(route);
    expect(pending?.returnTo).toBe('/dashboard/overview');
    expect(pending?.selectedStorage).toEqual(binding);
    expect(pending).not.toHaveProperty('authorizationParameters');
    expect(JSON.stringify(store)).not.toContain('scope');
    expect(store.setItem).toHaveBeenCalled();
    expect(coordinator.readSinglePending()?.id).toBe(tx.id);
  });

  test('rejects concurrent starts and permits only the matching exact local binding', () => {
    const coordinator = createXpodLoginTransactionStore({ storage: storage(), origin: 'https://app.example', now: () => 1000 });
    const first = transaction();
    coordinator.begin(first);

    expect(() => coordinator.begin(transaction())).toThrowError(XpodLoginTransactionError);
    expect(() => coordinator.updateSelectedStorage('other-id', binding)).toThrow(/transaction/i);
    expect(() => coordinator.updateSelectedStorage(first.id, {
      ...binding,
      storageUrl: 'https://evil.example/alice/',
    })).toThrow(/origin|local|binding/i);

    coordinator.updateSelectedStorage(first.id, binding);
    expect(coordinator.readSinglePending()?.selectedStorage).toEqual(binding);
  });

  test('expires, clears, consumes, and rejects replayed or malformed records deterministically', () => {
    const store = storage();
    let now = 1000;
    const coordinator = createXpodLoginTransactionStore({ storage: store, origin: 'https://app.example', now: () => now, ttlMs: 10 });
    const tx = transaction();
    coordinator.begin(tx);

    now = 1011;
    expect(() => coordinator.consume(tx.id)).toThrow(/expired/i);
    expect(coordinator.readSinglePending()).toBeUndefined();

    const fresh = createXpodLoginTransactionStore({ storage: store, origin: 'https://app.example', now: () => 2000 });
    const next = transaction();
    fresh.begin(next);
    expect(fresh.consume(next.id)).toMatchObject({ id: next.id });
    expect(() => fresh.consume(next.id)).toThrow(/unknown|consum/i);

    const malformedId = createOpaqueTransactionId();
    store.setItem('xpod.auth.transaction.v1.active', malformedId);
    store.setItem(`xpod.auth.transaction.v1.record.${malformedId}`, '{not-json');
    expect(() => fresh.readSinglePending()).toThrow(/malformed/i);
  });

  test('rejects unsafe return paths and cross-origin route records', () => {
    const coordinator = createXpodLoginTransactionStore({ storage: storage(), origin: 'https://app.example' });
    expect(() => coordinator.begin(transaction({ returnTo: 'https://evil.example/' }))).toThrow(/return|safe/i);
    expect(() => coordinator.begin(transaction({ returnTo: '/settings/../status' }))).toThrow(/return|safe/i);
    expect(() => coordinator.begin(transaction({
      route: {
        ...route,
        identityProvider: { url: 'https://evil.example', label: 'evil' },
      },
    }))).toThrow(/origin|route/i);
  });
});
