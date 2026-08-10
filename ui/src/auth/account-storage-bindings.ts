import type { StorageBinding } from '@undefineds.co/solid-sdk';
import { storedAccountTokenHeaders } from '../utils/account-session';
import type { Controls } from '../context/AuthContextValue';

export type AccountStorageBindingsErrorCode =
  | 'missing-control'
  | 'cross-origin'
  | 'forbidden'
  | 'request-failed'
  | 'invalid-response';

export class AccountStorageBindingsError extends Error {
  public readonly code: AccountStorageBindingsErrorCode;

  public constructor(code: AccountStorageBindingsErrorCode, message: string) {
    super(message);
    this.name = 'AccountStorageBindingsError';
    this.code = code;
  }
}

export interface AccountStorageBindingsClientOptions {
  controls?: Pick<Controls, 'account'> | null;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  origin?: string;
}

/**
 * Fetches the Account's canonical WebID/storage pairs.
 *
 * The account WebID and Pod controls intentionally are not accepted here:
 * callers must consume the server's exact ownership associations instead of
 * rebuilding pairs from independent arrays.
 */
export async function fetchAccountStorageBindings(
  options: AccountStorageBindingsClientOptions,
): Promise<StorageBinding[]> {
  const origin = resolveOrigin(options.origin);
  const controlUrl = options.controls?.account?.bindings;
  if (typeof controlUrl !== 'string' || controlUrl.trim() === '') {
    throw new AccountStorageBindingsError('missing-control', 'Account storage bindings control is unavailable');
  }

  const url = resolveSameOriginUrl(controlUrl, origin);
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = storedAccountTokenHeaders({
    Accept: 'application/json',
    ...options.headers,
  });

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers,
      credentials: 'include',
    });
  } catch (error) {
    throw new AccountStorageBindingsError(
      'request-failed',
      error instanceof Error ? error.message : 'Failed to load Account storage bindings',
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AccountStorageBindingsError('forbidden', 'Account storage bindings require an authenticated Account');
  }
  if (!response.ok) {
    throw new AccountStorageBindingsError('request-failed', `Account storage bindings request failed (${response.status})`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AccountStorageBindingsError('invalid-response', 'Account storage bindings response is not valid JSON');
  }

  return parseAccountStorageBindings(payload, origin);
}

export function parseAccountStorageBindings(value: unknown, origin: string): StorageBinding[] {
  if (!isRecord(value) || !Array.isArray(value.bindings)) {
    throw new AccountStorageBindingsError('invalid-response', 'Account storage bindings response is malformed');
  }

  const normalized: StorageBinding[] = [];
  const seen = new Set<string>();
  for (const entry of value.bindings) {
    if (!isRecord(entry) || typeof entry.webId !== 'string' || typeof entry.storageUrl !== 'string') {
      throw new AccountStorageBindingsError('invalid-response', 'Account storage binding row is malformed');
    }

    const webId = normalizeWebId(entry.webId, origin);
    const storageUrl = normalizeStorageUrl(entry.storageUrl, origin);
    if (!webId || !storageUrl) {
      throw new AccountStorageBindingsError('cross-origin', 'Account storage binding is not same-origin');
    }

    const binding: StorageBinding = {
      webId,
      storageUrl,
      ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
    };
    const key = `${binding.webId}\n${binding.storageUrl}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(binding);
    }
  }

  return normalized;
}

export const loadAccountStorageBindings = fetchAccountStorageBindings;
export const getAccountStorageBindings = fetchAccountStorageBindings;

function resolveOrigin(value: string | undefined): string {
  try {
    return new URL(value ?? (typeof window === 'undefined' ? 'http://localhost' : window.location.origin)).origin;
  } catch {
    throw new AccountStorageBindingsError('cross-origin', 'Current Xpod origin is invalid');
  }
}

function resolveSameOriginUrl(value: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    throw new AccountStorageBindingsError('cross-origin', 'Account storage bindings control is not a valid URL');
  }
  if (url.origin !== origin || url.username || url.password || url.hash) {
    throw new AccountStorageBindingsError('cross-origin', 'Account storage bindings control is not same-origin');
  }
  return url.href;
}

function normalizeWebId(value: string, origin: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function normalizeStorageUrl(value: string, origin: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (
      url.origin !== origin
      || !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return undefined;
    }
    url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    return url.href;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
