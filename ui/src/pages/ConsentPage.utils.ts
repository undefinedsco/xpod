import type { StorageBinding } from '@undefineds.co/solid-sdk';

export interface OidcCancelRedirectOptions {
  cancelUrl: string;
  headers?: HeadersInit;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Convert the canonical scoped picker `entries` into exact bindings.
 *
 * The legacy `webIds` array is accepted by the caller for display fallback,
 * but it cannot safely produce a storage URL and therefore never creates a
 * canonical binding here.
 */
export function resolveConsentStorageBindings(
  entries: unknown,
  legacyWebIds: readonly string[] = [],
): StorageBinding[] {
  // Keep the compatibility parameter in the public helper signature, but
  // never use legacy WebID-only values to fabricate a storage binding.
  void legacyWebIds;
  if (!Array.isArray(entries)) {
    return [];
  }

  const bindings: StorageBinding[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.webId !== 'string' || typeof entry.storageUrl !== 'string') {
      continue;
    }
    const binding = normalizeConsentBinding(entry.webId, entry.storageUrl);
    if (!binding) {
      continue;
    }
    const key = `${binding.webId}\n${binding.storageUrl}`;
    if (!seen.has(key)) {
      seen.add(key);
      bindings.push(binding);
    }
  }
  return bindings;
}

export function resolveConsentDisplayWebIds(
  scopedWebIds: string[],
  currentWebId: string | null,
  isProvisionScopedSession: boolean,
): string[] {
  if (scopedWebIds.length > 0) {
    return scopedWebIds;
  }

  // Local SP sessions must fail closed: currentWebId can be a Cloud account
  // selection from the issuer and is not proof that the selected SP owns a Pod.
  if (isProvisionScopedSession) {
    return [];
  }

  return currentWebId ? [currentWebId] : [];
}

export function resolveOidcCancelUrl(
  controls: { oidc?: { cancel?: string } } | null | undefined,
  fallbackIdpIndex: string,
): string {
  return controls?.oidc?.cancel || `${fallbackIdpIndex}oidc/cancel`;
}

export async function fetchOidcCancelRedirectLocation(options: OidcCancelRedirectOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (controller) {
    timeout = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await fetchImpl(options.cancelUrl, {
      method: 'POST',
      headers: options.headers,
      credentials: 'include',
      body: JSON.stringify({}),
      signal: controller?.signal,
    });
    return await resolveOidcCancelRedirectLocation(res);
  } catch (err: unknown) {
    if (isErrorWithName(err, 'AbortError')) {
      throw new Error('Authorization cancellation timed out. Please close this tab and retry login.');
    }
    throw err;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function resolveOidcCancelRedirectLocation(res: Response): Promise<string> {
  const json = await res.json().catch(() => null) as unknown;
  if (!res.ok) {
    throw new Error(readResponseMessage(json) || `Authorization cancellation failed (${res.status}).`);
  }

  const bodyLocation = isRecord(json) && typeof json.location === 'string' ? json.location.trim() : '';
  const headerLocation = res.headers.get('Location')?.trim() || '';
  const location = bodyLocation || headerLocation;
  if (!location) {
    throw new Error('Authorization cancellation did not return a redirect URL.');
  }
  return location;
}

function isErrorWithName(value: unknown, name: string): boolean {
  return isRecord(value) && value.name === name;
}

function normalizeConsentBinding(webId: string, storageUrl: string): StorageBinding | undefined {
  try {
    const identity = new URL(webId.trim());
    const storage = new URL(storageUrl.trim());
    if (
      !['http:', 'https:'].includes(identity.protocol)
      || !['http:', 'https:'].includes(storage.protocol)
      || identity.username
      || identity.password
      || storage.username
      || storage.password
      || storage.search
      || storage.hash
    ) {
      return undefined;
    }
    storage.pathname = storage.pathname.endsWith('/') ? storage.pathname : `${storage.pathname}/`;
    return { webId: identity.href, storageUrl: storage.href };
  } catch {
    return undefined;
  }
}
import { isRecord, readResponseMessage } from '../utils/errors';
