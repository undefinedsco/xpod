import { sqliteDatabaseFilePath } from './database-url';
import { localSecretPathForDatabase, readOrCreateLocalSecret } from './local-secret-file';

export function resolvePersistentGatewayLocatorSecret(options: {
  databaseUrl: string;
  edition: 'local' | 'cloud';
}): string {
  if (options.edition === 'cloud') {
    throw new Error('XPOD_GATEWAY_LOCATOR_SECRET is required for Cloud Gateway API keys; configure one stable shared value across replicas.');
  }

  const databasePath = sqliteDatabaseFilePath(options.databaseUrl);
  if (!databasePath) {
    throw new Error('XPOD_GATEWAY_LOCATOR_SECRET is required when CSS_IDENTITY_DB_URL is not a file-backed SQLite database.');
  }

  return readOrCreateLocalSecret({
    databasePath,
    purpose: 'gateway-locator-secret',
    label: 'Gateway locator secret',
    // Keep existing locator strings readable; only newly generated values are fixed at 32 bytes.
    isValid: value => /^[A-Za-z0-9_-]{32,}$/u.test(value),
  });
}

export function secretPathForGatewayLocatorDatabase(databaseUrl: string): string | undefined {
  const databasePath = sqliteDatabaseFilePath(databaseUrl);
  return databasePath ? secretPathForDatabase(databasePath) : undefined;
}

function secretPathForDatabase(databasePath: string): string {
  return localSecretPathForDatabase(databasePath, 'gateway-locator-secret');
}
