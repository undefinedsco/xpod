import type { StorageBinding } from '@undefineds.co/solid-sdk';
import { AccountStorageBindingsError, fetchAccountStorageBindings } from '../auth/account-storage-bindings';
import type { Controls } from '../context/AuthContextValue';
import { resolveCurrentTargetStorage } from './consent-first-pod';
import { resolveCurrentProvisionTarget } from './pod';
import { storageUrlBelongsToRoot } from './provision-scope';

export type FirstPodCurrentBindingStatus = 'ready' | 'none' | 'unreadable';

export interface FirstPodCurrentBindings {
  status: FirstPodCurrentBindingStatus;
  /** Exact current-target bindings; only populated for `ready`. */
  bindings: StorageBinding[];
}

export interface ResolveFirstPodCurrentBindingsOptions {
  controls?: Pick<Controls, 'account'> | null;
  fetchImpl?: typeof fetch;
  idpIndex: string;
  origin?: string;
}

/**
 * Read whether the Account already owns storage for the *current* provision
 * target — the only thing that proves this deployment is ready.
 *
 * A durable binding on a different root (e.g. a Cloud Pod seen from a Local
 * node) never proves the current target, so it must not resume the pending
 * authorization. When no durable pair names the current root, the Account's own
 * WebIDs are the Local lookup candidates; if the Account advertised no durable
 * pair *and* no readable WebID control, the answer is `unreadable` rather than
 * "no storage". Every failed read fails closed.
 */
export async function resolveFirstPodCurrentBindings(
  options: ResolveFirstPodCurrentBindingsOptions,
): Promise<FirstPodCurrentBindings> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = options.origin ?? (typeof window === 'undefined' ? undefined : window.location.origin);
  const { activeProvisionCode, storageRoot } = await resolveCurrentProvisionTarget();

  let accountBindings: StorageBinding[] = [];
  try {
    accountBindings = await fetchAccountStorageBindings({
      controls: options.controls,
      fetchImpl,
      origin,
      trustedAccountIndex: options.idpIndex,
    });
  } catch (error) {
    // No advertised bindings control means this deployment records no durable
    // pairs. Any other read failure is not evidence of "no storage".
    if (!(error instanceof AccountStorageBindingsError) || error.code !== 'missing-control') {
      return { status: 'unreadable', bindings: [] };
    }
  }

  const durable = storageRoot
    ? accountBindings.filter((binding) => storageUrlBelongsToRoot(binding.storageUrl, storageRoot))
    : accountBindings;
  if (durable.length > 0) {
    return { status: 'ready', bindings: durable };
  }
  // No current target: there is no local deployment whose own SP could already
  // hold this Account's storage, so nothing more can be proven.
  if (!storageRoot) {
    return { status: 'none', bindings: [] };
  }

  const accountWebIdUrl = typeof options.controls?.account?.webId === 'string'
    ? options.controls.account.webId.trim()
    : '';
  // A durable pair already names the Account's WebIDs, so the scoped lookup can
  // run from those candidates. With none, the Account's own WebID control is the
  // only candidate source: a missing control is a failed read, not "no storage".
  if (accountBindings.length === 0 && !accountWebIdUrl) {
    return { status: 'unreadable', bindings: [] };
  }

  const resolved = await resolveCurrentTargetStorage({
    accountBindings,
    accountWebIdUrl: accountBindings.length === 0 ? accountWebIdUrl : undefined,
    fetchImpl,
    idpIndex: options.idpIndex,
    provisionCode: activeProvisionCode,
    provisionStorageRoot: storageRoot,
  });
  return {
    status: resolved.status === 'exists' ? 'ready' : resolved.status,
    bindings: resolved.bindings,
  };
}
