import type { StorageBinding } from '@undefineds.co/solid-sdk';
import { storageUrlBelongsToRoot } from '../utils/provision-scope';
import { fetchAccountStorageBindings, type AccountStorageBindingsClientOptions } from './account-storage-bindings';

/** A provision response is not proof that the Account committed the ownership pair. */
export async function waitForCurrentAccountStorageBindings(
  options: AccountStorageBindingsClientOptions & {
    storageRoot: string;
    maxAttempts?: number;
    pollIntervalMs?: number;
  },
): Promise<StorageBinding[]> {
  const attempts = Math.max(1, options.maxAttempts ?? 20);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const bindings = (await fetchAccountStorageBindings(options))
      .filter((binding) => storageUrlBelongsToRoot(binding.storageUrl, options.storageRoot));
    if (bindings.length > 0) return bindings;
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, options.pollIntervalMs ?? 500)));
    }
  }
  throw new Error('Current Local storage binding is not committed yet');
}
