import {
  normalizeWebIdLoginTransaction,
  type StorageBinding,
  type WebIdLoginTransaction,
} from '@undefineds.co/solid-sdk';
import {
  assertXpodLoginRoute,
  normalizeXpodReturnTo,
} from './xpod-login-route';

export const XPOD_LOGIN_TRANSACTION_VERSION = 1 as const;
export const XPOD_LOGIN_TRANSACTION_PREFIX = 'xpod.auth.transaction.v1';
export const XPOD_LOGIN_TRANSACTION_TTL_MS = 10 * 60 * 1000;

type TransactionErrorCode =
  | 'already_active'
  | 'unknown'
  | 'expired'
  | 'malformed'
  | 'cross_origin'
  | 'mismatch'
  | 'consumed'
  | 'storage_unavailable';

export class XpodLoginTransactionError extends Error {
  readonly code: TransactionErrorCode;

  constructor(code: TransactionErrorCode, message: string) {
    super(message);
    this.name = 'XpodLoginTransactionError';
    this.code = code;
  }
}

export interface XpodLoginTransactionStore {
  begin(transaction: WebIdLoginTransaction): WebIdLoginTransaction;
  readSinglePending(): WebIdLoginTransaction | undefined;
  updateSelectedStorage(id: string, binding: StorageBinding): void;
  consume(id: string): WebIdLoginTransaction;
  cancel(id: string): void;
}

export interface CreateXpodLoginTransactionStoreOptions {
  storage?: Storage;
  origin?: string;
  now?: () => number;
  ttlMs?: number;
  prefix?: string;
}

interface StoredTransaction {
  version: typeof XPOD_LOGIN_TRANSACTION_VERSION;
  createdAt: number;
  expiresAt: number;
  transaction: {
    id: string;
    route: WebIdLoginTransaction['route'];
    returnTo?: string;
    selectedStorage?: StorageBinding;
  };
}

export function createOpaqueTransactionId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = new Uint8Array(24);
    cryptoApi.getRandomValues(bytes);
    return `xpod-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  throw new XpodLoginTransactionError('storage_unavailable', 'Secure transaction id generation is unavailable');
}

export function createXpodLoginTransactionStore(
  options: CreateXpodLoginTransactionStoreOptions = {},
): XpodLoginTransactionStore {
  const storage = options.storage ?? getSessionStorage();
  const origin = new URL(options.origin ?? getWindowOrigin()).origin;
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? XPOD_LOGIN_TRANSACTION_TTL_MS;
  const prefix = options.prefix ?? XPOD_LOGIN_TRANSACTION_PREFIX;
  const activeKey = `${prefix}.active`;
  const recordKey = (id: string) => `${prefix}.record.${id}`;
  const consumedKey = (id: string) => `${prefix}.consumed.${id}`;

  const clearActive = (id: string) => {
    if (storage.getItem(activeKey) === id) storage.removeItem(activeKey);
    storage.removeItem(recordKey(id));
  };

  const parseRecord = (id: string, expectedActive = true): StoredTransaction => {
    if (!isSafeTransactionId(id)) {
      throw new XpodLoginTransactionError('malformed', 'Transaction id is malformed');
    }
    if (storage.getItem(consumedKey(id)) === '1') {
      throw new XpodLoginTransactionError('consumed', 'Transaction has already been consumed');
    }
    if (expectedActive && storage.getItem(activeKey) !== id) {
      throw new XpodLoginTransactionError('unknown', 'Transaction is not the active Xpod login transaction');
    }

    const raw = storage.getItem(recordKey(id));
    if (!raw) {
      if (expectedActive && storage.getItem(activeKey) === id) storage.removeItem(activeKey);
      throw new XpodLoginTransactionError('unknown', 'Xpod login transaction was not found');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      clearActive(id);
      throw new XpodLoginTransactionError('malformed', 'Xpod login transaction is malformed');
    }

    if (!isStoredTransaction(parsed) || parsed.transaction.id !== id) {
      clearActive(id);
      throw new XpodLoginTransactionError('malformed', 'Xpod login transaction is malformed');
    }
    if (parsed.expiresAt <= now()) {
      clearActive(id);
      throw new XpodLoginTransactionError('expired', 'Xpod login transaction has expired');
    }

    try {
      const transaction = normalizePublicTransaction({
        ...parsed.transaction,
        authorizationSurface: 'redirect',
        discovery: 'strict',
      }, origin);
      parsed.transaction = {
        id: transaction.id,
        route: transaction.route,
        ...(transaction.returnTo === undefined ? {} : { returnTo: transaction.returnTo }),
        ...(transaction.selectedStorage === undefined ? {} : { selectedStorage: transaction.selectedStorage }),
      };
      return parsed;
    } catch (error) {
      clearActive(id);
      if (error instanceof XpodLoginTransactionError) throw error;
      throw new XpodLoginTransactionError('malformed', 'Xpod login transaction is malformed');
    }
  };

  const begin = (transaction: WebIdLoginTransaction): WebIdLoginTransaction => {
    const currentId = storage.getItem(activeKey);
    if (currentId) {
      try {
        parseRecord(currentId);
      } catch (error) {
        if (error instanceof XpodLoginTransactionError && (error.code === 'expired' || error.code === 'malformed' || error.code === 'unknown')) {
          // A stale/missing record does not block a new login attempt.
        } else {
          throw error;
        }
      }
      if (storage.getItem(activeKey) === currentId) {
        throw new XpodLoginTransactionError('already_active', 'An Xpod login transaction is already pending in this tab');
      }
    }

    const suppliedId = isSafeTransactionId(transaction.id) ? transaction.id : createOpaqueTransactionId();
    const normalized = normalizePublicTransaction({ ...transaction, id: suppliedId }, origin);
    const createdAt = now();
    const expiresAt = createdAt + ttlMs;
    const record: StoredTransaction = {
      version: XPOD_LOGIN_TRANSACTION_VERSION,
      createdAt,
      expiresAt,
      transaction: {
        id: normalized.id,
        route: normalized.route,
        ...(normalized.returnTo === undefined ? {} : { returnTo: normalized.returnTo }),
        ...(normalized.selectedStorage === undefined ? {} : { selectedStorage: normalized.selectedStorage }),
      },
    };
    storage.setItem(recordKey(normalized.id), JSON.stringify(record));
    storage.setItem(activeKey, normalized.id);
    return normalized;
  };

  return {
    begin,

    readSinglePending() {
      const id = storage.getItem(activeKey);
      if (!id) return undefined;
      return materialize(parseRecord(id).transaction);
    },

    updateSelectedStorage(id, binding) {
      const parsed = parseRecord(id);
      const transaction = materialize(parsed.transaction);
      const selectedStorage = normalizeBinding(binding, origin, transaction.route.storageProvider?.url);
      const updated: StoredTransaction = {
        ...parsed,
        transaction: {
          ...parsed.transaction,
          selectedStorage,
        },
      };
      storage.setItem(recordKey(id), JSON.stringify(updated));
    },

    consume(id) {
      const parsed = parseRecord(id);
      const transaction = materialize(parsed.transaction);
      storage.removeItem(activeKey);
      storage.removeItem(recordKey(id));
      storage.setItem(consumedKey(id), '1');
      return transaction;
    },

    cancel(id) {
      parseRecord(id);
      storage.removeItem(activeKey);
      storage.removeItem(recordKey(id));
      storage.setItem(consumedKey(id), '1');
    },
  };
}

function normalizePublicTransaction(
  transaction: WebIdLoginTransaction,
  origin: string,
): WebIdLoginTransaction {
  let normalized: WebIdLoginTransaction;
  try {
    normalized = normalizeWebIdLoginTransaction(transaction);
  } catch (error) {
    throw new XpodLoginTransactionError('malformed', error instanceof Error ? error.message : 'Transaction is malformed');
  }

  let route;
  try {
    route = assertXpodLoginRoute(normalized.route, origin);
  } catch (error) {
    throw new XpodLoginTransactionError('cross_origin', error instanceof Error ? error.message : 'Transaction route is not local');
  }

  let returnTo: string | undefined;
  try {
    returnTo = normalizeXpodReturnTo(normalized.returnTo);
  } catch (error) {
    throw new XpodLoginTransactionError('mismatch', error instanceof Error ? error.message : 'Transaction return path is unsafe');
  }

  if (normalized.selectedStorage !== undefined) {
    try {
      const selectedStorage = normalizeBinding(normalized.selectedStorage, origin, route.storageProvider?.url);
      return {
        id: normalized.id,
        route,
        selectedStorage,
        authorizationSurface: 'redirect',
        discovery: 'strict',
        ...(returnTo === undefined ? {} : { returnTo }),
      };
    } catch (error) {
      throw error instanceof XpodLoginTransactionError
        ? error
        : new XpodLoginTransactionError('mismatch', 'Selected storage binding is invalid');
    }
  }

  return {
    id: normalized.id,
    route,
    authorizationSurface: 'redirect',
    discovery: 'strict',
    ...(returnTo === undefined ? {} : { returnTo }),
  };
}

function normalizeBinding(binding: StorageBinding, origin: string, expectedStorageOrigin?: string): StorageBinding {
  if (!binding || typeof binding.storageUrl !== 'string' || typeof binding.webId !== 'string') {
    throw new XpodLoginTransactionError('malformed', 'Selected storage binding is malformed');
  }
  let storageUrl: URL;
  let webId: URL;
  try {
    storageUrl = new URL(binding.storageUrl);
    webId = new URL(binding.webId);
  } catch {
    throw new XpodLoginTransactionError('malformed', 'Selected storage binding is malformed');
  }
  if (!['http:', 'https:'].includes(storageUrl.protocol) || !['http:', 'https:'].includes(webId.protocol)) {
    throw new XpodLoginTransactionError('cross_origin', 'Selected storage binding must use web URLs');
  }
  if (
    storageUrl.origin !== origin
    || webId.origin !== origin
    || (expectedStorageOrigin && storageUrl.origin !== new URL(expectedStorageOrigin).origin)
  ) {
    throw new XpodLoginTransactionError('cross_origin', 'Selected storage binding is not local to this Xpod');
  }
  if (storageUrl.username || storageUrl.password || storageUrl.hash || webId.username || webId.password) {
    throw new XpodLoginTransactionError('malformed', 'Selected storage binding contains unsafe URL data');
  }
  return {
    storageUrl: storageUrl.href,
    webId: webId.href,
    ...(binding.label === undefined ? {} : { label: binding.label }),
  };
}

function materialize(transaction: StoredTransaction['transaction']): WebIdLoginTransaction {
  return {
    id: transaction.id,
    route: transaction.route,
    authorizationSurface: 'redirect',
    discovery: 'strict',
    ...(transaction.returnTo === undefined ? {} : { returnTo: transaction.returnTo }),
    ...(transaction.selectedStorage === undefined ? {} : { selectedStorage: transaction.selectedStorage }),
  };
}

function isSafeTransactionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function isStoredTransaction(value: unknown): value is StoredTransaction {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<StoredTransaction>;
  return record.version === XPOD_LOGIN_TRANSACTION_VERSION
    && typeof record.createdAt === 'number'
    && typeof record.expiresAt === 'number'
    && Boolean(record.transaction && typeof record.transaction === 'object');
}

function getSessionStorage(): Storage {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
  } catch {
    // Fall through to the explicit error below.
  }
  throw new XpodLoginTransactionError('storage_unavailable', 'Session storage is unavailable');
}

function getWindowOrigin(): string {
  if (typeof window !== 'undefined' && window.location.origin !== 'null') return window.location.origin;
  return 'http://localhost';
}
