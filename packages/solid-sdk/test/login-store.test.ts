import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROVIDERS,
  createLoginStore,
  getAllProviders,
  getRememberedAccount,
  type LoginStoreStorage,
  type ProviderOption,
  type StoredAccount,
} from '../src/login-store';

const LOGIN_STORE_KEY = 'linx-login';
const REMEMBERED_ACCOUNT_KEY = 'linx-remembered-account';

class MemoryStorage implements LoginStoreStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const alice: StoredAccount = {
  displayName: 'Alice',
  avatarUrl: 'https://id.example/alice.png',
  issuerUrl: 'https://id.example',
  issuerLabel: 'Identity',
  storageProviderUrl: 'https://pod.example',
  storageProviderLabel: 'Pod',
  webId: 'https://id.example/alice/profile/card#me',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function readRememberedAccount(
  storage: LoginStoreStorage,
  key = REMEMBERED_ACCOUNT_KEY,
): StoredAccount | null {
  const value = storage.getItem(key);
  return value ? JSON.parse(value) as StoredAccount : null;
}

describe('LinX login store migration', () => {
  it('starts in restoring because LinX partialize persists only account and providers', () => {
    const storage = new MemoryStorage();
    storage.setItem(LOGIN_STORE_KEY, JSON.stringify({
      state: {
        storedAccount: alice,
        customProviders: [{ id: 'custom', url: 'https://custom.example', label: 'Custom' }],
      },
      version: 1,
    }));

    const store = createLoginStore({ storage });
    const state = store.getState();

    expect(state.state).toBe('restoring');
    expect(state.error).toBeNull();
    expect(state.storedAccount).toEqual(alice);
    expect(state.customProviders).toEqual([
      { id: 'custom', url: 'https://custom.example', label: 'Custom' },
    ]);
  });

  it('persists remembered account under its own key and reset returns to idle', () => {
    const storage = new MemoryStorage();
    const store = createLoginStore({ storage });
    const state = store.getState();

    state.setState('connecting');
    state.setError('network failed');
    state.loginSuccess(alice);
    state.reset();

    expect(store.getState().state).toBe('idle');
    expect(store.getState().error).toBeNull();
    expect(store.getState().storedAccount).toEqual(alice);
    expect(readRememberedAccount(storage)).toEqual(alice);
    expect(JSON.parse(storage.getItem(LOGIN_STORE_KEY) ?? '{}')).toEqual({
      state: {
        storedAccount: alice,
        customProviders: [],
      },
      version: 1,
    });
    expect(storage.getItem(REMEMBERED_ACCOUNT_KEY)).not.toBeNull();
  });

  it('loginSuccess stores the authenticated account and clears an old error', () => {
    const storage = new MemoryStorage();
    const store = createLoginStore({ storage });
    const state = store.getState();

    state.setError('old error');
    state.loginSuccess(alice);

    expect(store.getState()).toMatchObject({
      state: 'authenticated',
      error: null,
      storedAccount: alice,
    });
    expect(readRememberedAccount(storage)).toEqual(alice);
  });

  it('setStoredAccount(null) removes only the remembered identity record', () => {
    const storage = new MemoryStorage();
    const store = createLoginStore({ storage });
    const state = store.getState();

    state.loginSuccess(alice);
    state.setStoredAccount(null);

    expect(store.getState().storedAccount).toBeNull();
    expect(readRememberedAccount(storage)).toBeNull();
    expect(storage.getItem(REMEMBERED_ACCOUNT_KEY)).toBeNull();
    expect(storage.getItem(LOGIN_STORE_KEY)).not.toBeNull();
  });

  it('keeps custom providers newest-first and caps ten', () => {
    const storage = new MemoryStorage();
    const store = createLoginStore({
      storage,
    });
    const state = store.getState();

    for (let index = 0; index < 12; index += 1) {
      state.addCustomProvider({
        id: `provider-${index}`,
        url: `https://provider-${index}.example`,
        label: `Provider ${index}`,
      });
    }
    state.addCustomProvider({ id: 'override', url: 'https://id.example', label: 'Override' });

    expect(store.getState().customProviders).toHaveLength(10);
    expect(store.getState().customProviders[0]).toEqual({
      id: 'override',
      url: 'https://id.example',
      label: 'Override',
    });
  });

  it('notifies subscribers with next and previous state and supports unsubscribe', () => {
    const store = createLoginStore({ storage: new MemoryStorage() });
    const snapshots: Array<[string, string | null, string, string | null]> = [];
    const unsubscribe = store.subscribe((next, previous) => {
      snapshots.push([next.state, next.error, previous.state, previous.error]);
    });

    store.getState().setState('restoring');
    store.getState().setState('idle');
    store.getState().setError('failed');
    store.getState().setError('failed');
    unsubscribe();
    store.getState().setState('connecting');

    expect(snapshots).toEqual([
      ['idle', null, 'restoring', null],
      ['idle', 'failed', 'idle', null],
    ]);
  });

  it('exposes the same Zustand imperative API as the LinX source store', () => {
    const store = createLoginStore({ storage: null });

    store.setState({ state: 'idle', error: 'failed' });

    expect(store.getState()).toMatchObject({ state: 'idle', error: 'failed' });
  });

  it('supports host-provided storage keys without changing LinX behavior', () => {
    const storage = new MemoryStorage();
    const store = createLoginStore({
      storage,
      rememberedAccountKey: 'xpod-remembered-account',
      persistKey: 'xpod-login',
    });

    store.getState().loginSuccess(alice);

    expect(storage.getItem(REMEMBERED_ACCOUNT_KEY)).toBeNull();
    expect(storage.getItem(LOGIN_STORE_KEY)).toBeNull();
    expect(storage.getItem('xpod-remembered-account')).not.toBeNull();
    expect(storage.getItem('xpod-login')).not.toBeNull();
  });

  it('runs the LinX migration for an older persisted store version', () => {
    const storage = new MemoryStorage();
    storage.setItem(LOGIN_STORE_KEY, JSON.stringify({
      state: {
        storedAccount: {
          displayName: 'Legacy Alice',
          providerUrl: 'https://legacy-id.example',
          providerLabel: 'Legacy Pod',
        },
        customProviders: [{ id: 'legacy', url: 'https://legacy.example', label: 'Legacy' }],
      },
      version: 0,
    }));

    const store = createLoginStore({ storage });
    expect(store.getState().storedAccount).toEqual({
      displayName: 'Legacy Alice',
      avatarUrl: undefined,
      issuerUrl: 'https://legacy-id.example',
      issuerLabel: undefined,
      storageProviderUrl: 'https://legacy-id.example',
      storageProviderLabel: 'Legacy Pod',
      webId: undefined,
    });
    expect(store.getState().customProviders).toEqual([
      { id: 'legacy', url: 'https://legacy.example', label: 'Legacy' },
    ]);
  });

  it('preserves the LinX cloud-backed local-account migration', () => {
    const storage = new MemoryStorage();
    storage.setItem(LOGIN_STORE_KEY, JSON.stringify({
      state: {
        storedAccount: {
          displayName: 'Cloud Alice',
          providerLabel: 'Local',
          webId: 'https://id.undefineds.co/alice/profile/card#me',
        },
        customProviders: [],
      },
      version: 0,
    }));

    const store = createLoginStore({ storage });
    expect(store.getState().storedAccount?.issuerUrl).toBe('https://id.undefineds.co');
  });

  it('ignores structurally invalid remembered accounts without deleting the stored record', () => {
    const storage = new MemoryStorage();
    storage.setItem(REMEMBERED_ACCOUNT_KEY, JSON.stringify({ displayName: 'No issuer' }));
    vi.stubGlobal('window', { localStorage: storage });

    expect(getRememberedAccount()).toBeNull();
    expect(storage.getItem(REMEMBERED_ACCOUNT_KEY)).not.toBeNull();
  });

  it('removes remembered-account records that are not valid JSON', () => {
    const storage = new MemoryStorage();
    storage.setItem(REMEMBERED_ACCOUNT_KEY, '{not-json');
    vi.stubGlobal('window', { localStorage: storage });

    expect(getRememberedAccount()).toBeNull();
    expect(storage.getItem(REMEMBERED_ACCOUNT_KEY)).toBeNull();
  });
});

describe('provider helpers', () => {
  it('keeps default insertion order while custom providers override by URL', () => {
    const custom: ProviderOption[] = [
      { id: 'extra', url: 'https://extra.example', label: 'Extra' },
      { id: 'override', url: 'https://id.undefineds.co', label: 'Override' },
    ];

    expect(getAllProviders(custom)).toEqual([
      { id: 'override', url: 'https://id.undefineds.co', label: 'Override', isDefault: false },
      { id: 'extra', url: 'https://extra.example', label: 'Extra', isDefault: false },
    ]);
    expect(DEFAULT_PROVIDERS[0]).toMatchObject({ id: 'linx-cloud', isDefault: true });
  });
});
