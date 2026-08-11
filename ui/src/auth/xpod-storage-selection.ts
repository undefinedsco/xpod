import type { StorageBinding, StorageSelectionState } from '@undefineds.co/solid-sdk';

export const XPOD_REMEMBERED_STORAGE_BINDING_KEY = 'xpod.account.selected-binding.v1';

export interface ReconcileXpodStorageSelectionOptions {
  /** Undefined means Account enumeration has not completed yet. */
  bindings?: readonly StorageBinding[];
  /** A failed Account control request should never be treated as an empty list. */
  error?: unknown;
  remembered?: StorageBinding;
}

export type XpodStorageSelectionState = StorageSelectionState;

/**
 * Reconcile Account-owned bindings without positional fallback.
 *
 * Selection happens before a WebID session exists, so this host-level helper
 * intentionally considers every exact pair. The shared solid-sdk helper is
 * WebID-scoped and remains appropriate for generic authenticated hosts.
 */
export function reconcileXpodStorageSelection(
  options: ReconcileXpodStorageSelectionOptions,
): XpodStorageSelectionState {
  if (options.error !== undefined) {
    return { status: 'error', message: 'Unable to enumerate Account storage bindings.' };
  }
  if (options.bindings === undefined) {
    return { status: 'loading' };
  }
  if (!Array.isArray(options.bindings)) {
    return { status: 'error', message: 'Account storage bindings are malformed.' };
  }

  const candidates: StorageBinding[] = [];
  const seen = new Map<string, StorageBinding>();
  for (const candidate of options.bindings) {
    const normalized = normalizeBinding(candidate);
    if (!normalized) {
      return { status: 'error', message: 'Account storage bindings are malformed.' };
    }

    const key = storageBindingKey(normalized);
    const existing = seen.get(key);
    if (existing) {
      if (!areBindingMetadataCompatible(existing, normalized)) {
        return {
          status: 'conflict',
          message: `Storage binding ${normalized.storageUrl} is duplicated with incompatible metadata`,
        };
      }
      // An exact duplicate is not another candidate. Prefer the row carrying
      // the display metadata when one duplicate omits it.
      if (existing.label === undefined && normalized.label !== undefined) {
        const index = candidates.indexOf(existing);
        const merged = { ...existing, label: normalized.label };
        seen.set(key, merged);
        candidates[index] = merged;
      }
      continue;
    }
    seen.set(key, normalized);
    candidates.push(normalized);
  }

  if (options.remembered) {
    const remembered = normalizeBinding(options.remembered);
    if (remembered) {
      const exact = candidates.find((candidate) => storageBindingKey(candidate) === storageBindingKey(remembered));
      if (exact) {
        return { status: 'ready', selected: { ...exact } };
      }
      // Stale remembered state is intentionally ignored. If multiple fresh
      // candidates remain, the caller must render an explicit chooser.
    }
  }

  if (candidates.length === 0) {
    return { status: 'empty' };
  }
  if (candidates.length === 1) {
    return { status: 'ready', selected: { ...candidates[0] } };
  }
  return { status: 'selecting', candidates: candidates.map((candidate) => ({ ...candidate })) };
}

export function storageBindingKey(binding: StorageBinding): string {
  const normalized = normalizeBinding(binding);
  if (!normalized) {
    throw new TypeError('Storage binding is malformed');
  }
  return `${normalized.webId}|${normalized.storageUrl}`;
}

export function rememberXpodStorageBinding(
  binding: StorageBinding,
  storage: Pick<Storage, 'setItem'> = defaultSessionStorage(),
): void {
  storage.setItem(XPOD_REMEMBERED_STORAGE_BINDING_KEY, storageBindingKey(binding));
}

export function readRememberedXpodStorageBindingKey(
  storage: Pick<Storage, 'getItem'> = defaultSessionStorage(),
): string | undefined {
  const value = storage.getItem(XPOD_REMEMBERED_STORAGE_BINDING_KEY);
  return value && value.includes('|') ? value : undefined;
}

export function clearRememberedXpodStorageBinding(
  storage: Pick<Storage, 'removeItem'> = defaultSessionStorage(),
): void {
  storage.removeItem(XPOD_REMEMBERED_STORAGE_BINDING_KEY);
}

export const createXpodStorageSelection = reconcileXpodStorageSelection;
export const resolveXpodStorageSelection = reconcileXpodStorageSelection;

function normalizeBinding(binding: StorageBinding): StorageBinding | undefined {
  if (!binding || typeof binding.webId !== 'string' || typeof binding.storageUrl !== 'string') {
    return undefined;
  }
  try {
    const webId = new URL(binding.webId.trim());
    const storageUrl = new URL(binding.storageUrl.trim());
    if (
      !['http:', 'https:'].includes(webId.protocol)
      || !['http:', 'https:'].includes(storageUrl.protocol)
      || webId.username
      || webId.password
      || storageUrl.username
      || storageUrl.password
      || storageUrl.hash
      || storageUrl.search
    ) {
      return undefined;
    }
    storageUrl.pathname = storageUrl.pathname.endsWith('/') ? storageUrl.pathname : `${storageUrl.pathname}/`;
    return {
      webId: webId.href,
      storageUrl: storageUrl.href,
      ...(typeof binding.label === 'string' ? { label: binding.label } : {}),
    };
  } catch {
    return undefined;
  }
}

function areBindingMetadataCompatible(left: StorageBinding, right: StorageBinding): boolean {
  return left.label === undefined
    || right.label === undefined
    || left.label === right.label;
}

function defaultSessionStorage(): Storage {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    throw new Error('Session storage is unavailable');
  }
  return window.sessionStorage;
}
