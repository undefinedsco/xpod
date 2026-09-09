import { describe, expect, it, vi } from 'vitest';
import type { StorageBinding, StorageSelectionState } from '@undefineds.co/solid-sdk';
import {
  XPOD_REMEMBERED_STORAGE_BINDING_KEY,
  readRememberedXpodStorageBindingKey,
  reconcileXpodStorageSelection,
  rememberXpodStorageBinding,
  storageBindingKey,
} from './xpod-storage-selection';

const alice = 'https://app.example/alice/profile/card#me';
const bob = 'https://app.example/bob/profile/card#me';
const aliceStorage = 'https://app.example/alice/';
const bobStorage = 'https://app.example/bob/';

const binding = (webId: string, storageUrl: string): StorageBinding => ({ webId, storageUrl });

describe('Xpod storage selection', () => {
  it('auto-selects one binding and requires an explicit choice for several', () => {
    expect(reconcileXpodStorageSelection({ bindings: [binding(alice, aliceStorage)] })).toEqual({
      status: 'ready',
      selected: binding(alice, aliceStorage),
    });
    expect(reconcileXpodStorageSelection({
      bindings: [binding(alice, aliceStorage), binding(bob, bobStorage)],
    })).toEqual({
      status: 'selecting',
      candidates: [binding(alice, aliceStorage), binding(bob, bobStorage)],
    });
  });

  it('restores only an exact remembered pair and never chooses the first after a stale key', () => {
    const remembered = binding(bob, bobStorage);
    expect(reconcileXpodStorageSelection({
      bindings: [binding(alice, aliceStorage), remembered],
      remembered,
    })).toEqual({ status: 'ready', selected: remembered });

    const stale = reconcileXpodStorageSelection({
      bindings: [binding(alice, aliceStorage), remembered],
      remembered: binding('https://app.example/old/profile/card#me', 'https://app.example/old/'),
    });
    expect(stale).toEqual({
      status: 'selecting',
      candidates: [binding(alice, aliceStorage), remembered],
    });
    expect((stale as Extract<StorageSelectionState, { status: 'selecting' }>).candidates[0]).toEqual(binding(alice, aliceStorage));
  });

  it('treats one storage owned by several WebIDs as separate exact candidates', () => {
    const aliceOnSharedStorage = binding(alice, 'https://app.example/shared/');
    const bobOnSharedStorage = binding(bob, 'https://app.example/shared/');

    expect(reconcileXpodStorageSelection({
      bindings: [aliceOnSharedStorage, bobOnSharedStorage, aliceOnSharedStorage],
    })).toEqual({
      status: 'selecting',
      candidates: [aliceOnSharedStorage, bobOnSharedStorage],
    });
  });

  it('reports empty, conflict, loading, and transport error states deterministically', () => {
    expect(reconcileXpodStorageSelection({ bindings: [] })).toEqual({ status: 'empty' });
    expect(reconcileXpodStorageSelection({ bindings: undefined })).toEqual({ status: 'loading' });
    expect(reconcileXpodStorageSelection({ error: new Error('403') })).toEqual({
      status: 'error',
      message: 'Unable to enumerate Account storage bindings.',
    });
    expect(reconcileXpodStorageSelection({ bindings: null as unknown as StorageBinding[] })).toEqual({
      status: 'error',
      message: 'Account storage bindings are malformed.',
    });
  });

  it('reports a conflict only when one exact pair has incompatible metadata', () => {
    expect(reconcileXpodStorageSelection({ bindings: [
      { ...binding(alice, aliceStorage), label: 'Alice Pod' },
      { ...binding(alice, aliceStorage), label: 'A different Pod' },
    ] })).toMatchObject({ status: 'conflict' });
  });

  it('persists only the public exact binding key', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    } satisfies Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    const selected = binding(alice, aliceStorage);

    expect(storageBindingKey(selected)).toBe(`${alice}|${aliceStorage}`);
    rememberXpodStorageBinding(selected, storage);
    expect(values.get(XPOD_REMEMBERED_STORAGE_BINDING_KEY)).toBe(storageBindingKey(selected));
    expect(readRememberedXpodStorageBindingKey(storage)).toBe(storageBindingKey(selected));
    expect(JSON.stringify(values)).not.toContain('storageUrl');
  });
});
