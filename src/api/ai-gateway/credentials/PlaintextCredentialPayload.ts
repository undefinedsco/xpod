import type { ProviderSecret } from './CredentialVault';

export const PLAINTEXT_CREDENTIAL_STORAGE_MODE = 'plaintext-v1';
export const SECRET_CELL_CREDENTIAL_STORAGE_MODE = 'secret-cell-v1';

export type PlaintextCredentialStorageMode = typeof PLAINTEXT_CREDENTIAL_STORAGE_MODE;

export interface PlaintextCredentialRow {
  storageMode?: unknown;
  secretPayload?: unknown;
  encryptedSecret?: unknown;
  wrappedDataKey?: unknown;
  encryptionAlgorithm?: unknown;
}

export class UnsupportedCredentialStorageModeError extends Error {
  public readonly storageMode: string;

  public constructor(storageMode: string) {
    super(`Unsupported credential storage mode: ${storageMode}`);
    this.name = 'UnsupportedCredentialStorageModeError';
    this.storageMode = storageMode;
  }
}

export function encodePlaintextCredential(secret: ProviderSecret): string {
  if (!isPlainObject(secret)) {
    throw new UnsupportedCredentialStorageModeError(PLAINTEXT_CREDENTIAL_STORAGE_MODE);
  }
  return JSON.stringify(secret);
}

export function decodePlaintextCredential(row: PlaintextCredentialRow): ProviderSecret {
  const storageMode = storageModeFromRow(row);
  if (storageMode !== PLAINTEXT_CREDENTIAL_STORAGE_MODE) {
    throw new UnsupportedCredentialStorageModeError(storageMode);
  }
  if (typeof row.secretPayload !== 'string' || !row.secretPayload.trim()) {
    throw new UnsupportedCredentialStorageModeError(storageMode);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.secretPayload);
  } catch {
    throw new UnsupportedCredentialStorageModeError(storageMode);
  }
  if (!isPlainObject(parsed)) {
    throw new UnsupportedCredentialStorageModeError(storageMode);
  }
  return parsed;
}

function storageModeFromRow(row: PlaintextCredentialRow): string {
  if (
    row.encryptedSecret !== undefined
    || row.wrappedDataKey !== undefined
    || row.encryptionAlgorithm !== undefined
  ) {
    return SECRET_CELL_CREDENTIAL_STORAGE_MODE;
  }
  if (typeof row.storageMode === 'string' && row.storageMode.trim()) {
    return row.storageMode.trim();
  }
  return 'missing';
}

function isPlainObject(value: unknown): value is ProviderSecret {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
