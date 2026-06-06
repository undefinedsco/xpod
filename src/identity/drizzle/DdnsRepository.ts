/**
 * DDNS Repository
 *
 * 管理 Cloud 已分配的 DDNS 记录。
 *
 * 根域名、DNS provider 和 zone 等属于 Cloud 部署配置，不在控制面表中
 * 再维护一份域名池，避免配置事实和数据库事实分叉。
 */

import { eq } from 'drizzle-orm';
import type { IdentityDatabase } from './db';
import { getLoggerFor } from 'global-logger-factory';
import { ensureCloudClusterTables, getSchema, toDbTimestamp, fromDbTimestamp } from './db';

const logger = getLoggerFor('DdnsRepository');

export interface DdnsRecord {
  subdomain: string;
  domain: string;
  ipAddress?: string;
  ipv6Address?: string;
  recordType: 'A' | 'AAAA' | 'CNAME';
  nodeId?: string;
  username?: string;
  status: 'active' | 'banned';
  bannedReason?: string;
  ttl: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDdnsRecordInput {
  subdomain: string;
  domain: string;
  ipAddress?: string;
  ipv6Address?: string;
  recordType?: 'A' | 'AAAA' | 'CNAME';
  nodeId?: string;
  username?: string;
}

export interface UpdateDdnsRecordInput {
  ipAddress?: string | null;
  ipv6Address?: string | null;
  recordType?: 'A' | 'AAAA' | 'CNAME';
}

export class DdnsRepository {
  private readonly schema: ReturnType<typeof getSchema>;
  private readonly ready: Promise<void>;

  constructor(private readonly db: IdentityDatabase) {
    this.schema = getSchema(db);
    this.ready = ensureCloudClusterTables(db);
  }

  // ==================== DDNS Records ====================

  /**
   * 分配子域名
   */
  async allocateSubdomain(input: CreateDdnsRecordInput): Promise<DdnsRecord> {
    await this.ready;
    const { subdomain, domain, ipAddress, ipv6Address, nodeId, username } = input;

    // 检查是否已存在
    const existing = await this.getRecord(subdomain);
    if (existing) {
      throw new Error(`Subdomain ${subdomain} already allocated`);
    }

    const now = new Date();
    const recordType = input.recordType ?? (ipv6Address ? 'AAAA' : 'A');

    await this.db.insert(this.schema.ddnsRecords).values({
      subdomain,
      domain,
      ipAddress,
      ipv6Address,
      recordType,
      nodeId,
      username,
      status: 'active',
      ttl: 60,
      createdAt: toDbTimestamp(this.db, now),
      updatedAt: toDbTimestamp(this.db, now),
    });

    logger.info(`Allocated subdomain: ${subdomain}.${domain}`);

    return {
      subdomain,
      domain,
      ipAddress,
      ipv6Address,
      recordType,
      nodeId,
      username,
      status: 'active',
      ttl: 60,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 获取 DDNS 记录
   */
  async getRecord(subdomain: string): Promise<DdnsRecord | null> {
    await this.ready;
    const results = await this.db
      .select()
      .from(this.schema.ddnsRecords)
      .where(eq(this.schema.ddnsRecords.subdomain, subdomain))
      .limit(1);

    if (results.length === 0) {
      return null;
    }

    const row = results[0];
    return {
      subdomain: row.subdomain,
      domain: row.domain,
      ipAddress: row.ipAddress ?? undefined,
      ipv6Address: row.ipv6Address ?? undefined,
      recordType: (row.recordType as 'A' | 'AAAA' | 'CNAME') ?? 'A',
      nodeId: row.nodeId ?? undefined,
      username: row.username ?? undefined,
      status: (row.status as 'active' | 'banned') ?? 'active',
      bannedReason: row.bannedReason ?? undefined,
      ttl: row.ttl ?? 60,
      createdAt: fromDbTimestamp(row.createdAt) ?? new Date(0),
      updatedAt: fromDbTimestamp(row.updatedAt) ?? new Date(0),
    };
  }

  /**
   * 更新 DDNS 记录的 IP 地址
   */
  async updateRecordIp(
    subdomain: string,
    input: UpdateDdnsRecordInput,
  ): Promise<DdnsRecord | null> {
    await this.ready;
    const existing = await this.getRecord(subdomain);
    if (!existing) {
      return null;
    }

    if (existing.status === 'banned') {
      throw new Error(`Subdomain ${subdomain} is banned: ${existing.bannedReason}`);
    }

    const now = new Date();
    const updates: Record<string, unknown> = { updatedAt: toDbTimestamp(this.db, now) };

    if (input.ipAddress !== undefined) {
      updates.ipAddress = input.ipAddress;
      if (input.ipAddress !== null && input.recordType === undefined) {
        updates.recordType = 'A';
      }
    }
    if (input.ipv6Address !== undefined) {
      updates.ipv6Address = input.ipv6Address;
      if (input.ipv6Address !== null && !input.ipAddress && input.recordType === undefined) {
        updates.recordType = 'AAAA';
      }
    }
    if (input.recordType !== undefined) {
      updates.recordType = input.recordType;
    }

    await this.db
      .update(this.schema.ddnsRecords)
      .set(updates)
      .where(eq(this.schema.ddnsRecords.subdomain, subdomain));

    logger.info(`Updated DDNS record: ${subdomain} -> ${input.ipAddress ?? input.ipv6Address}`);

    return {
      ...existing,
      ipAddress: input.ipAddress === undefined ? existing.ipAddress : (input.ipAddress ?? undefined),
      ipv6Address: input.ipv6Address === undefined ? existing.ipv6Address : (input.ipv6Address ?? undefined),
      recordType: (updates.recordType as 'A' | 'AAAA' | 'CNAME') ?? existing.recordType,
      updatedAt: now,
    };
  }

  /**
   * 封禁子域名
   */
  async banSubdomain(subdomain: string, reason: string): Promise<void> {
    await this.ready;
    await this.db
      .update(this.schema.ddnsRecords)
      .set({
        status: 'banned',
        bannedReason: reason,
        updatedAt: toDbTimestamp(this.db, new Date()),
      })
      .where(eq(this.schema.ddnsRecords.subdomain, subdomain));

    logger.warn(`Banned subdomain: ${subdomain}, reason: ${reason}`);
  }

  /**
   * 解封子域名
   */
  async unbanSubdomain(subdomain: string): Promise<void> {
    await this.ready;
    await this.db
      .update(this.schema.ddnsRecords)
      .set({
        status: 'active',
        bannedReason: null,
        updatedAt: toDbTimestamp(this.db, new Date()),
      })
      .where(eq(this.schema.ddnsRecords.subdomain, subdomain));

    logger.info(`Unbanned subdomain: ${subdomain}`);
  }

  /**
   * 释放子域名
   */
  async releaseSubdomain(subdomain: string): Promise<boolean> {
    await this.ready;
    await this.db
      .delete(this.schema.ddnsRecords)
      .where(eq(this.schema.ddnsRecords.subdomain, subdomain));

    logger.info(`Released subdomain: ${subdomain}`);
    return true;
  }

  /**
   * 获取用户的所有子域名
   */
  async getRecordsByUsername(username: string): Promise<DdnsRecord[]> {
    await this.ready;
    const results = await this.db
      .select()
      .from(this.schema.ddnsRecords)
      .where(eq(this.schema.ddnsRecords.username, username));

    return results.map((row: typeof results[0]) => ({
      subdomain: row.subdomain,
      domain: row.domain,
      ipAddress: row.ipAddress ?? undefined,
      ipv6Address: row.ipv6Address ?? undefined,
      recordType: (row.recordType as 'A' | 'AAAA') ?? 'A',
      nodeId: row.nodeId ?? undefined,
      username: row.username ?? undefined,
      status: (row.status as 'active' | 'banned') ?? 'active',
      bannedReason: row.bannedReason ?? undefined,
      ttl: row.ttl ?? 60,
      createdAt: fromDbTimestamp(row.createdAt) ?? new Date(0),
      updatedAt: fromDbTimestamp(row.updatedAt) ?? new Date(0),
    }));
  }

  /**
   * 获取节点的子域名
   */
  async getRecordByNodeId(nodeId: string): Promise<DdnsRecord | null> {
    await this.ready;
    const results = await this.db
      .select()
      .from(this.schema.ddnsRecords)
      .where(eq(this.schema.ddnsRecords.nodeId, nodeId))
      .limit(1);

    if (results.length === 0) {
      return null;
    }

    const row = results[0];
    return {
      subdomain: row.subdomain,
      domain: row.domain,
      ipAddress: row.ipAddress ?? undefined,
      ipv6Address: row.ipv6Address ?? undefined,
      recordType: (row.recordType as 'A' | 'AAAA') ?? 'A',
      nodeId: row.nodeId ?? undefined,
      username: row.username ?? undefined,
      status: (row.status as 'active' | 'banned') ?? 'active',
      bannedReason: row.bannedReason ?? undefined,
      ttl: row.ttl ?? 60,
      createdAt: fromDbTimestamp(row.createdAt) ?? new Date(0),
      updatedAt: fromDbTimestamp(row.updatedAt) ?? new Date(0),
    };
  }

}
