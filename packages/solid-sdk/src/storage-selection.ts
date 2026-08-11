import type { StorageBinding } from './webid-auth';
import { normalizeStorageBinding } from './webid-auth';

export type StorageSelectionState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'selecting'; candidates: readonly StorageBinding[] }
  | { status: 'creating' }
  | { status: 'waiting_for_binding' }
  | { status: 'ready'; selected: StorageBinding }
  | { status: 'conflict'; message: string }
  | { status: 'error'; message: string };

export interface ReconcileStorageSelectionOptions {
  enabled?: boolean;
  webId?: string;
  candidates?: readonly StorageBinding[];
  remembered?: StorageBinding;
}

function normalizeIdentity(value: string): string {
  const trimmed = value.trim();
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
}

function normalizedBinding(binding: StorageBinding): StorageBinding {
  return {
    ...normalizeStorageBinding(binding),
    webId: normalizeIdentity(binding.webId),
  };
}

export function storageBindingMatches(
  expected: StorageBinding,
  actual: StorageBinding,
): boolean {
  const left = normalizedBinding(expected);
  const right = normalizedBinding(actual);
  return left.storageUrl === right.storageUrl && left.webId === right.webId;
}

export function reconcileStorageSelection(
  options?: ReconcileStorageSelectionOptions,
): StorageSelectionState | undefined;
export function reconcileStorageSelection(
  webId: string,
  candidates?: readonly StorageBinding[],
  remembered?: StorageBinding,
): StorageSelectionState;
export function reconcileStorageSelection(
  optionsOrWebId?: ReconcileStorageSelectionOptions | string,
  positionalCandidates: readonly StorageBinding[] = [],
  positionalRemembered?: StorageBinding,
): StorageSelectionState | undefined {
  if (optionsOrWebId === undefined) {
    return undefined;
  }

  const options: ReconcileStorageSelectionOptions = typeof optionsOrWebId === 'string'
    ? {
      webId: optionsOrWebId,
      candidates: positionalCandidates,
      remembered: positionalRemembered,
    }
    : optionsOrWebId;

  if (options.enabled === false) {
    return undefined;
  }

  // An omitted capability is intentionally different from an enabled
  // capability with an empty response. The former does not construct state.
  if (options.webId === undefined || options.candidates === undefined) {
    return undefined;
  }

  const webId = normalizeIdentity(options.webId);
  const candidates = options.candidates.map(normalizedBinding);
  const seenByStorage = new Map<string, string>();
  const uniqueCandidates: StorageBinding[] = [];

  for (const candidate of candidates) {
    const existingWebId = seenByStorage.get(candidate.storageUrl);
    if (existingWebId && existingWebId !== candidate.webId) {
      return {
        status: 'conflict',
        message: `Storage URL ${candidate.storageUrl} is bound to incompatible WebIDs`,
      };
    }
    seenByStorage.set(candidate.storageUrl, candidate.webId);

    if (!uniqueCandidates.some((existing) => storageBindingMatches(existing, candidate))) {
      uniqueCandidates.push(candidate);
    }
  }

  const eligible = uniqueCandidates.filter((candidate) => candidate.webId === webId);

  if (options.remembered) {
    const remembered = normalizedBinding(options.remembered);
    const exact = eligible.find((candidate) => storageBindingMatches(candidate, remembered));
    if (exact) {
      return { status: 'ready', selected: { ...exact } };
    }

    const rememberedWebId = seenByStorage.get(remembered.storageUrl);
    if (rememberedWebId && rememberedWebId !== webId) {
      return {
        status: 'conflict',
        message: `Remembered storage ${remembered.storageUrl} belongs to another WebID`,
      };
    }
    // A remembered binding that is no longer present is stale. Continue with
    // fresh candidates rather than silently selecting the first result.
  }

  if (eligible.length === 0) {
    return { status: 'empty' };
  }
  if (eligible.length === 1) {
    return { status: 'ready', selected: { ...eligible[0] } };
  }
  return {
    status: 'selecting',
    candidates: eligible.map((candidate) => ({ ...candidate })),
  };
}

export const createStorageSelectionState = reconcileStorageSelection;

export { type StorageBinding } from './webid-auth';
