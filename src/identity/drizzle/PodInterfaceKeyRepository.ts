import { eq } from 'drizzle-orm';
import { getLoggerFor } from 'global-logger-factory';
import type { IdentityDatabase } from './db';
import { ensurePodInterfaceKeyTable, getSchema, fromDbTimestamp, toDbTimestamp } from './db';

/**
 * The interface access key a Pod grants its owner's server-side components.
 *
 * It is an ordinary Pod credential - the same kind a browser holds - so the server reaches the
 * Pod through the standard interface as that user. The ciphertext lives here rather than in the
 * Pod, because this key is what opens the Pod.
 */
export interface PodInterfaceKeyRecord {
  ownerWebId: string;
  clientId: string;
  /** Vault-sealed JSON `{ clientSecret }`. */
  sealedSecret: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PodInterfaceKeyRepositoryPort {
  read(ownerWebId: string): Promise<PodInterfaceKeyRecord | undefined>;
  write(record: Omit<PodInterfaceKeyRecord, 'createdAt' | 'updatedAt'>): Promise<void>;
  remove(ownerWebId: string): Promise<void>;
}

export class PodInterfaceKeyRepository implements PodInterfaceKeyRepositoryPort {
  private readonly logger = getLoggerFor(this);
  private readonly schema: ReturnType<typeof getSchema>;
  private readonly ready: Promise<void>;
  private initError?: unknown;

  public constructor(private readonly db: IdentityDatabase) {
    this.schema = getSchema(db);
    // Bootstrap is lazy, and its failure belongs to the first caller that needs the table.
    // Leaving the rejection unobserved would surface as an unhandled rejection from a
    // constructor nobody awaits, which is both louder and less useful than a read error.
    this.ready = ensurePodInterfaceKeyTable(db).catch((error: unknown) => {
      this.initError = error;
    });
  }

  public async read(ownerWebId: string): Promise<PodInterfaceKeyRecord | undefined> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(this.schema.podInterfaceKeys)
      .where(eq(this.schema.podInterfaceKeys.ownerWebId, ownerWebId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      ownerWebId: String(row.ownerWebId),
      clientId: String(row.clientId),
      sealedSecret: String(row.sealedSecret),
      createdAt: fromDbTimestamp(row.createdAt) ?? new Date(),
      updatedAt: fromDbTimestamp(row.updatedAt) ?? new Date(),
    };
  }

  public async write(record: Omit<PodInterfaceKeyRecord, 'createdAt' | 'updatedAt'>): Promise<void> {
    await this.ensureReady();
    const existing = await this.read(record.ownerWebId);
    if (existing) {
      await this.db
        .update(this.schema.podInterfaceKeys)
        .set({
          clientId: record.clientId,
          sealedSecret: record.sealedSecret,
          updatedAt: toDbTimestamp(this.db, new Date()),
        })
        .where(eq(this.schema.podInterfaceKeys.ownerWebId, record.ownerWebId));
      this.logger.info(`Rotated the Pod interface key for ${record.ownerWebId}`);
      return;
    }
    await this.db.insert(this.schema.podInterfaceKeys).values({
      ownerWebId: record.ownerWebId,
      clientId: record.clientId,
      sealedSecret: record.sealedSecret,
      createdAt: toDbTimestamp(this.db, new Date()),
      updatedAt: toDbTimestamp(this.db, new Date()),
    });
    this.logger.info(`Stored a Pod interface key for ${record.ownerWebId}`);
  }

  public async remove(ownerWebId: string): Promise<void> {
    await this.ensureReady();
    await this.db
      .delete(this.schema.podInterfaceKeys)
      .where(eq(this.schema.podInterfaceKeys.ownerWebId, ownerWebId));
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
    if (this.initError) {
      throw this.initError instanceof Error
        ? this.initError
        : new Error(`pod_interface_key_table_unavailable:${String(this.initError)}`);
    }
  }
}
