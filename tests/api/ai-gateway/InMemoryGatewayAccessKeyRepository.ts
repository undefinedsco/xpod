import { hashGatewayApiKeySecret, verifyGatewayApiKeySecret } from '../../../src/api/ai-gateway/auth/GatewayApiKey';
import type {
  GatewayAccessKeyRecord,
  GatewayAccessKeyRepository,
  GatewayAccessKeyRepositoryContext,
} from '../../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';

export class InMemoryGatewayAccessKeyRepository implements GatewayAccessKeyRepository {
  private readonly records = new Map<string, GatewayAccessKeyRecord>();
  private dummyHash?: Promise<string>;

  public async create(
    record: GatewayAccessKeyRecord,
    _context?: GatewayAccessKeyRepositoryContext,
  ): Promise<GatewayAccessKeyRecord> {
    const stored = cloneRecord(record);
    this.records.set(record.id, stored);
    return cloneRecord(stored);
  }

  public async findById(id: string): Promise<GatewayAccessKeyRecord | undefined> {
    const record = this.records.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  public async listByOwner(
    owner: string,
    _context?: GatewayAccessKeyRepositoryContext,
  ): Promise<GatewayAccessKeyRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.owner === owner)
      .map(cloneRecord)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  public async revoke(
    id: string,
    revokedAt: Date,
    _context?: GatewayAccessKeyRepositoryContext,
  ): Promise<GatewayAccessKeyRecord | undefined> {
    const record = this.records.get(id);
    if (!record) {
      return undefined;
    }
    record.revokedAt = new Date(revokedAt);
    return cloneRecord(record);
  }

  public async touchLastUsed(id: string, lastUsedAt: Date): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      record.lastUsedAt = new Date(lastUsedAt);
    }
  }

  public async verifySecretHashForTimingOnly(secret: string): Promise<void> {
    this.dummyHash ??= hashGatewayApiKeySecret('xpod-gateway-dummy-secret');
    await verifyGatewayApiKeySecret(secret, await this.dummyHash);
  }
}

function cloneRecord(record: GatewayAccessKeyRecord): GatewayAccessKeyRecord {
  return {
    ...record,
    scopes: [...record.scopes],
    createdAt: new Date(record.createdAt),
    expiresAt: cloneOptionalDate(record.expiresAt),
    lastUsedAt: cloneOptionalDate(record.lastUsedAt),
    revokedAt: cloneOptionalDate(record.revokedAt),
  };
}

function cloneOptionalDate(value: Date | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}
