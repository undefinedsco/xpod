import { randomUUID, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getLoggerFor } from 'global-logger-factory';
import type { IdentityDatabase } from './db';
import { getSchema } from './db';

export type ServiceType = 'local' | 'business' | 'cloud' | 'compute';

export interface ServiceTokenRecord {
  id: string;
  serviceType: ServiceType;
  serviceId: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
}

export interface CreateServiceTokenOptions {
  serviceType: ServiceType;
  serviceId: string;
  scopes: string[];
  expiresAt?: Date | null;
}

export class ServiceTokenRepository {
  private readonly logger = getLoggerFor(this);
  private readonly schema: ReturnType<typeof getSchema>;

  public constructor(private readonly db: IdentityDatabase) {
    this.schema = getSchema(db);
  }

  /**
   * Create a new service token. Returns the plaintext token (only available at creation time).
   */
  public async createToken(options: CreateServiceTokenOptions): Promise<{ id: string; token: string }> {
    const id = randomUUID();
    const token = `svc-${randomUUID().replace(/-/g, '')}`;
    const tokenHash = this.hashToken(token);

    await this.db.insert(this.schema.serviceTokens).values({
      id,
      tokenHash,
      serviceType: options.serviceType,
      serviceId: options.serviceId,
      scopes: JSON.stringify(options.scopes),
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: options.expiresAt ? Math.floor(options.expiresAt.getTime() / 1000) : null,
    });

    this.logger.info(`Created service token ${id} for ${options.serviceType}:${options.serviceId}`);
    return { id, token };
  }

  /**
   * Register a token from a known plaintext value (e.g. XPOD_BUSINESS_TOKEN env var).
   * Upserts by serviceType + serviceId to avoid duplicates.
   */
  public async registerToken(
    token: string,
    options: CreateServiceTokenOptions,
  ): Promise<string> {
    const tokenHash = this.hashToken(token);

    // Check if a token already exists for this service
    const existing = await this.findByService(options.serviceType, options.serviceId);
    if (existing) {
      // Update the hash in case the token changed
      await this.db.update(this.schema.serviceTokens)
        .set({
          tokenHash,
          scopes: JSON.stringify(options.scopes),
          expiresAt: options.expiresAt ? Math.floor(options.expiresAt.getTime() / 1000) : null,
        })
        .where(eq(this.schema.serviceTokens.id, existing.id));
      this.logger.info(`Updated service token ${existing.id} for ${options.serviceType}:${options.serviceId}`);
      return existing.id;
    }

    const id = randomUUID();
    await this.db.insert(this.schema.serviceTokens).values({
      id,
      tokenHash,
      serviceType: options.serviceType,
      serviceId: options.serviceId,
      scopes: JSON.stringify(options.scopes),
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: options.expiresAt ? Math.floor(options.expiresAt.getTime() / 1000) : null,
    });

    this.logger.info(`Registered service token ${id} for ${options.serviceType}:${options.serviceId}`);
    return id;
  }

  /**
   * Verify a plaintext token and return the matching record if valid.
   */
  public async verifyToken(token: string): Promise<ServiceTokenRecord | undefined> {
    const tokenHash = this.hashToken(token);

    const rows = await this.db.select()
      .from(this.schema.serviceTokens)
      .where(eq(this.schema.serviceTokens.tokenHash, tokenHash));

    if (!rows || rows.length === 0) {
      return undefined;
    }

    const row = rows[0];

    // Check expiration (expiresAt is Unix timestamp in seconds)
    if (row.expiresAt) {
      const expiresAtMs = typeof row.expiresAt === 'number' ? row.expiresAt * 1000 : new Date(row.expiresAt).getTime();
      if (expiresAtMs < Date.now()) {
        this.logger.debug(`Service token ${row.id} has expired`);
        return undefined;
      }
    }

    return this.toRecord(row);
  }

  /**
   * Find a token record by service type and service ID.
   */
  public async findByService(serviceType: ServiceType, serviceId: string): Promise<ServiceTokenRecord | undefined> {
    const rows = await this.db.select()
      .from(this.schema.serviceTokens)
      .where(eq(this.schema.serviceTokens.serviceType, serviceType));

    const match = rows.find((r: any) => r.serviceId === serviceId);
    return match ? this.toRecord(match) : undefined;
  }

  /**
   * Delete a service token by ID.
   */
  public async deleteToken(id: string): Promise<void> {
    await this.db.delete(this.schema.serviceTokens).where(eq(this.schema.serviceTokens.id, id));
    this.logger.info(`Deleted service token ${id}`);
  }

  /**
   * List all service tokens (without hashes).
   */
  public async listTokens(): Promise<ServiceTokenRecord[]> {
    const rows = await this.db.select({
      id: this.schema.serviceTokens.id,
      serviceType: this.schema.serviceTokens.serviceType,
      serviceId: this.schema.serviceTokens.serviceId,
      scopes: this.schema.serviceTokens.scopes,
      createdAt: this.schema.serviceTokens.createdAt,
      expiresAt: this.schema.serviceTokens.expiresAt,
    }).from(this.schema.serviceTokens);

    return rows.map((r: any) => this.toRecord(r));
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toRecord(row: any): ServiceTokenRecord {
    let scopes: string[];
    try {
      scopes = typeof row.scopes === 'string' ? JSON.parse(row.scopes) : row.scopes;
    } catch {
      scopes = [];
    }

    return {
      id: row.id,
      serviceType: row.serviceType ?? row.service_type,
      serviceId: row.serviceId ?? row.service_id,
      scopes,
      createdAt: row.createdAt instanceof Date ? row.createdAt : new Date((row.createdAt ?? row.created_at) * 1000),
      expiresAt: row.expiresAt || row.expires_at
        ? (row.expiresAt instanceof Date ? row.expiresAt : new Date((row.expiresAt ?? row.expires_at) * 1000))
        : null,
    };
  }
}
