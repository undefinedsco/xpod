import { randomUUID, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getLoggerFor } from 'global-logger-factory';
import type { IdentityDatabase } from './db';
import { serviceTokens } from './schema';

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

  public constructor(private readonly db: IdentityDatabase) {}

  /**
   * Create a new service token. Returns the plaintext token (only available at creation time).
   */
  public async createToken(options: CreateServiceTokenOptions): Promise<{ id: string; token: string }> {
    const id = randomUUID();
    const token = `svc-${randomUUID().replace(/-/g, '')}`;
    const tokenHash = this.hashToken(token);

    await this.db.insert(serviceTokens).values({
      id,
      tokenHash,
      serviceType: options.serviceType,
      serviceId: options.serviceId,
      scopes: JSON.stringify(options.scopes),
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: options.expiresAt ?? null,
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
      await this.db.update(serviceTokens)
        .set({
          tokenHash,
          scopes: JSON.stringify(options.scopes),
          expiresAt: options.expiresAt ?? null,
        })
        .where(eq(serviceTokens.id, existing.id));
      this.logger.info(`Updated service token ${existing.id} for ${options.serviceType}:${options.serviceId}`);
      return existing.id;
    }

    const id = randomUUID();
    await this.db.insert(serviceTokens).values({
      id,
      tokenHash,
      serviceType: options.serviceType,
      serviceId: options.serviceId,
      scopes: JSON.stringify(options.scopes),
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: options.expiresAt ?? null,
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
      .from(serviceTokens)
      .where(eq(serviceTokens.tokenHash, tokenHash));

    if (!rows || rows.length === 0) {
      return undefined;
    }

    const row = rows[0];

    // Check expiration
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
      this.logger.debug(`Service token ${row.id} has expired`);
      return undefined;
    }

    return this.toRecord(row);
  }

  /**
   * Find a token record by service type and service ID.
   */
  public async findByService(serviceType: ServiceType, serviceId: string): Promise<ServiceTokenRecord | undefined> {
    const rows = await this.db.select()
      .from(serviceTokens)
      .where(eq(serviceTokens.serviceType, serviceType));

    const match = rows.find((r: any) => r.serviceId === serviceId);
    return match ? this.toRecord(match) : undefined;
  }

  /**
   * Delete a service token by ID.
   */
  public async deleteToken(id: string): Promise<void> {
    await this.db.delete(serviceTokens).where(eq(serviceTokens.id, id));
    this.logger.info(`Deleted service token ${id}`);
  }

  /**
   * List all service tokens (without hashes).
   */
  public async listTokens(): Promise<ServiceTokenRecord[]> {
    const rows = await this.db.select({
      id: serviceTokens.id,
      serviceType: serviceTokens.serviceType,
      serviceId: serviceTokens.serviceId,
      scopes: serviceTokens.scopes,
      createdAt: serviceTokens.createdAt,
      expiresAt: serviceTokens.expiresAt,
    }).from(serviceTokens);

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
