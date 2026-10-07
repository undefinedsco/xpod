import { DeploymentRootKeyProvider } from '../security/secret-cell/DeploymentRootKeyProvider';
import { sqliteDatabaseFilePath } from './database-url';
import { localSecretPathForDatabase, readOrCreateLocalSecret } from './local-secret-file';

const LOCAL_KEY_ID = 'local-v1';

export function secretPathForSecretCellDatabase(databaseUrl: string): string | undefined {
  const databasePath = sqliteDatabaseFilePath(databaseUrl);
  return databasePath ? localSecretPathForDatabase(databasePath, 'secret-cell-root-key') : undefined;
}

/** Independent from locator keys so rotating one purpose cannot strand another. */
export function resolvePersistentSecretCellRootKey(options: {
  databaseUrl: string;
  edition: 'local' | 'cloud';
}): DeploymentRootKeyProvider {
  if (options.edition !== 'local') {
    throw new Error('XPOD_SECRET_CELL_KEY_ID and XPOD_SECRET_CELL_KEY are required for Cloud SecretCell encryption; configure stable shared root keys across replicas.');
  }
  const databasePath = sqliteDatabaseFilePath(options.databaseUrl);
  if (!databasePath) {
    throw new Error('XPOD_SECRET_CELL_KEY_ID and XPOD_SECRET_CELL_KEY are required when the identity database is not file-backed SQLite.');
  }
  const encoded = readOrCreateLocalSecret({
    databasePath,
    purpose: 'secret-cell-root-key',
    label: 'SecretCell root key',
    isValid: value => /^[A-Za-z0-9_-]{43}$/u.test(value)
      && Buffer.from(value, 'base64url').byteLength === 32
      && Buffer.from(value, 'base64url').toString('base64url') === value,
  });
  const key = Buffer.from(encoded, 'base64url');
  try {
    return new DeploymentRootKeyProvider({ activeKeyId: LOCAL_KEY_ID, keys: { [LOCAL_KEY_ID]: key } });
  } finally {
    key.fill(0);
  }
}
