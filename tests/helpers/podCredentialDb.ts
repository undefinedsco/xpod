import {
  DeploymentRootKeyProvider,
  parseDeploymentRootKeyConfig,
  SecretCellVault,
} from '../../src/security/secret-cell';
import type { MatrixSigningKeyChannelDb } from '../../src/api/matrix/signingKeyChannel';

/**
 * The credentials document of one Pod, as far as the signing-key channel and the
 * identity provisioner are concerned. Enough of the drizzle surface to read, insert
 * and update a row, with the write log the tests assert on.
 */
export function fakePodCredentialDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const writes: string[] = [];
  const db: MatrixSigningKeyChannelDb = {
    async findById<T>(_resource: unknown, id: string) { return (rows.get(id) as T) ?? undefined; },
    insert() {
      return {
        values: (row: Record<string, unknown>) => ({
          execute: async () => {
            rows.set(String(row.id), row);
            writes.push('insert');
          },
        }),
      };
    },
    async updateById(_resource: unknown, id: string, value: Record<string, unknown>) {
      rows.set(id, { ...(rows.get(id) ?? { id }), ...value });
      writes.push('update');
    },
  };
  return { db, rows, writes };
}

/** A deployment root key for sealing in tests. Different seeds cannot open each other. */
export function testSecretCellVault(seed = 7): SecretCellVault {
  return new SecretCellVault({
    rootKeys: new DeploymentRootKeyProvider({
      activeKeyId: 'root-v1',
      keys: { 'root-v1': parseDeploymentRootKeyConfig(Buffer.alloc(32, seed).toString('base64')) },
    }),
  });
}
