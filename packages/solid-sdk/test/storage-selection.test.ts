import { describe, expect, it } from 'vitest';
import {
  reconcileStorageSelection,
  storageBindingMatches,
  type StorageSelectionState,
} from '../src/storage-selection';
import type { StorageBinding } from '../src/webid-auth';

const WEB_ID = 'https://id.example/alice#me';
const OTHER_WEB_ID = 'https://id.example/bob#me';
const STORAGE_A = 'https://pod.example/alice/';
const STORAGE_B = 'https://pod.example/alice-secondary/';

function binding(storageUrl: string, webId = WEB_ID): StorageBinding {
  return { storageUrl, webId };
}

describe('storage selection contracts', () => {
  it('does not construct storage state for an identity-only host', () => {
    expect(reconcileStorageSelection()).toBeUndefined();
    expect(reconcileStorageSelection({ enabled: false, webId: WEB_ID, candidates: [] })).toBeUndefined();
  });

  it('marks one compatible candidate ready', () => {
    const state = reconcileStorageSelection({
      webId: WEB_ID,
      candidates: [binding(STORAGE_A)],
    });

    expect(state).toEqual({ status: 'ready', selected: binding(STORAGE_A) });
  });

  it('requires explicit selection when several candidates exist', () => {
    const state = reconcileStorageSelection({
      webId: WEB_ID,
      candidates: [binding(STORAGE_A), binding(STORAGE_B)],
    });

    expect(state).toEqual({
      status: 'selecting',
      candidates: [binding(STORAGE_A), binding(STORAGE_B)],
    });
  });

  it('reports empty only when storage selection is enabled and no candidates are eligible', () => {
    const state = reconcileStorageSelection({
      webId: WEB_ID,
      candidates: [binding(STORAGE_A, OTHER_WEB_ID)],
    });

    expect(state).toEqual({ status: 'empty' });
    expect((state as StorageSelectionState).status).toBe('empty');
  });

  it('discards stale remembered storage and never substitutes another storage for the same WebID', () => {
    const state = reconcileStorageSelection({
      webId: WEB_ID,
      candidates: [binding(STORAGE_B)],
      remembered: binding(STORAGE_A),
    });

    expect(state).toEqual({ status: 'ready', selected: binding(STORAGE_B) });
    expect(storageBindingMatches(binding(STORAGE_A), binding(STORAGE_B))).toBe(false);
  });

  it('requires an exact WebID plus storageUrl pair for remembered bindings', () => {
    expect(storageBindingMatches(binding(STORAGE_A), binding(STORAGE_A))).toBe(true);
    expect(storageBindingMatches(binding(STORAGE_A), binding(STORAGE_B))).toBe(false);
    expect(storageBindingMatches(binding(STORAGE_A), binding(STORAGE_A, OTHER_WEB_ID))).toBe(false);
  });

  it('reports incompatible duplicate bindings as conflict', () => {
    const state = reconcileStorageSelection({
      webId: WEB_ID,
      candidates: [binding(STORAGE_A), binding(STORAGE_A, OTHER_WEB_ID)],
    });

    expect(state).toEqual({
      status: 'conflict',
      message: expect.stringMatching(/incompatible|conflict/i),
    });
  });
});
