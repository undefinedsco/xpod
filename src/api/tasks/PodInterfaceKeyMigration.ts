import { getLoggerFor } from 'global-logger-factory';
import type { PodInterfaceKeySource } from '../ai-gateway/pod/PodInterfaceKeyStore';
import type { TaskCredentialStore } from './TaskCredentialStore';

export interface PodInterfaceKeyMigrationResult {
  scanned: number;
  migrated: number;
  skipped: number;
  failed: number;
}

export interface MigratePodInterfaceKeysOptions {
  /** Legacy store: one sealed owner key per WebID. Read-only here. */
  keys: PodInterfaceKeySource & { listOwners(): Promise<string[]> };
  /** Where the rows are moved to. */
  taskCredentials: TaskCredentialStore;
  /** Issuer the legacy rows belong to. */
  issuer: string;
}

/**
 * Move the deployment's stored owner keys into the task layer.
 *
 * Runs once per boot and is safe to repeat: a row that is already a grant of the same owner and
 * issuer resolves to the same reference, and the grant is idempotent when the secret matches. A
 * row that cannot be opened is reported and left alone - the legacy table stays readable, which is
 * what keeps a failed migration reversible.
 */
export async function migratePodInterfaceKeysToTaskCredentials(
  options: MigratePodInterfaceKeysOptions,
): Promise<PodInterfaceKeyMigrationResult> {
  const logger = getLoggerFor('PodInterfaceKeyMigration');
  const result: PodInterfaceKeyMigrationResult = { scanned: 0, migrated: 0, skipped: 0, failed: 0 };

  let owners: string[];
  try {
    owners = await options.keys.listOwners();
  } catch (error) {
    logger.warn(`Legacy Pod interface keys could not be listed: ${String(error)}`);
    return result;
  }

  for (const ownerWebId of owners) {
    result.scanned += 1;
    try {
      const credential = await options.keys.read(ownerWebId);
      if (!credential) {
        result.skipped += 1;
        continue;
      }
      await options.taskCredentials.grant({
        ownerWebId,
        issuer: options.issuer,
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
        status: 'active',
      });
      result.migrated += 1;
    } catch (error) {
      // The row stays readable; nothing is deleted here, so a failure is never a data loss.
      logger.warn(`Legacy Pod interface key for ${ownerWebId} was not migrated: ${String(error)}`);
      result.failed += 1;
    }
  }

  if (result.scanned > 0) {
    logger.info(
      `Legacy Pod interface keys: ${result.migrated} migrated, ${result.skipped} skipped, `
      + `${result.failed} failed of ${result.scanned}`,
    );
  }
  return result;
}
