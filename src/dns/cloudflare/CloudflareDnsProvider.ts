import { getLoggerFor } from 'global-logger-factory';
import type {
  DeleteDnsRecordInput,
  DnsRecordSummary,
  DnsRecordTypeValue,
  ListDnsRecordsInput,
  ListableDnsProvider,
  UpsertDnsRecordInput,
} from '../DnsProvider';

export interface CloudflareDnsProviderOptions {
  /** Cloudflare API Token（推荐使用受限 Token） */
  apiToken?: string | null;
  /** Zone ID，如果不提供会自动查找 */
  zoneId?: string | null;
  /** API 根地址，默认为 `https://api.cloudflare.com/client/v4` */
  baseUrl?: string | null;
  /** HTTP 请求超时毫秒数，默认 10s */
  timeoutMs?: number | string | null;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
  result_info?: {
    page: number;
    per_page: number;
    total_count: number;
    total_pages: number;
  };
}

interface CloudflareDnsRecord {
  id: string;
  zone_id: string;
  zone_name: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  ttl: number;
  created_on: string;
  modified_on: string;
}

interface CloudflareZone {
  id: string;
  name: string;
  status: string;
}

/**
 * 基于 Cloudflare API v4 的 DNS 提供方实现。
 */
export class CloudflareDnsProvider implements ListableDnsProvider {
  private readonly logger = getLoggerFor(this);
  private readonly apiToken: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly enabled: boolean;
  private readonly configuredZoneId?: string;
  
  /** 缓存 domain -> zoneId 的映射 */
  private readonly zoneIdCache = new Map<string, string>();

  public constructor(options: CloudflareDnsProviderOptions) {
    this.apiToken = this.normalizeString(options.apiToken) ?? '';
    this.baseUrl = (this.normalizeString(options.baseUrl) ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
    this.timeoutMs = this.normalizeTimeout(options.timeoutMs) ?? 10_000;
    this.configuredZoneId = this.normalizeString(options.zoneId);
    this.enabled = this.apiToken.length > 0;
    
    if (!this.enabled) {
      this.logger.info('CloudflareDnsProvider 未配置 apiToken，将以禁用状态运行。');
    }
  }

  public async upsertRecord(options: UpsertDnsRecordInput): Promise<void> {
    if (!this.enabled) {
      this.logger.debug('DNS provider disabled，跳过 upsert。');
      return;
    }

    const zoneId = await this.getZoneId(options.domain);
    const fullName = this.buildFullName(options.subdomain, options.domain);
    const ttl = options.ttl ?? 1; // Cloudflare: 1 = auto

    // 一次拉回该名字下的全部记录，再按类型判断（审计 N14）。
    // 旧实现只取第一条、类型不同就删除——于是 `_acme-challenge` 的 TXT 或同一名字下的 MX
    // 会被“为写 A 记录”误删。
    const records = await this.findRecords(zoneId, fullName);
    const existing = records.find((record) => record.type === options.type);

    if (existing) {
      // 类型相同，检查内容是否需要更新
      if (existing.content === options.value && (existing.ttl === ttl || ttl === 1)) {
        this.logger.debug(`DNS 记录已存在且一致，跳过更新 ${fullName} ${options.type}`);
        return;
      }

      // 更新现有记录
      await this.callApi<CloudflareDnsRecord>(
        `zones/${zoneId}/dns_records/${existing.id}`,
        'PATCH',
        {
          type: options.type,
          name: fullName,
          content: options.value,
          ttl,
          proxied: false, // DNS-01 验证需要关闭代理
        }
      );
      this.logger.info(`已更新 DNS 记录 ${fullName} ${options.type}`);
      return;
    }

    // 只有 CNAME 与其他记录类型互斥（RFC 1034）：写 A/AAAA 前要清掉同名 CNAME，写 CNAME 前
    // 要清掉同名 A/AAAA。MX/TXT 等类型可以与 A/AAAA 共存，必须原样保留。
    const conflicting = records.find((record) => CloudflareDnsProvider.isMutuallyExclusive(options.type, record.type));
    if (conflicting) {
      this.logger.info(
        `发现互斥 DNS 记录 (现有: ${conflicting.type}, 目标: ${options.type})，删除该记录 ${conflicting.id} (${fullName})...`,
      );
      await this.callApi(`zones/${zoneId}/dns_records/${conflicting.id}`, 'DELETE');
    }

    // 创建新记录
    await this.callApi<CloudflareDnsRecord>(
      `zones/${zoneId}/dns_records`,
      'POST',
      {
        type: options.type,
        name: fullName,
        content: options.value,
        ttl,
        proxied: false,
      }
    );
    this.logger.info(`已创建 DNS 记录 ${fullName} ${options.type}`);
  }

  public async deleteRecord(options: DeleteDnsRecordInput): Promise<void> {
    if (!this.enabled) {
      this.logger.debug('DNS provider disabled，跳过 delete。');
      return;
    }

    const zoneId = await this.getZoneId(options.domain);
    const fullName = this.buildFullName(options.subdomain, options.domain);
    // 删除必须带类型（接口里 type 是必填）：按“同名 + 同类型（+ 同内容）”精确匹配，
    // 绝不退化成“删这个名字下的第一条记录”。
    const matches = await this.findRecords(zoneId, fullName, options.type, options.value);
    const existing = matches[0];

    if (!existing) {
      this.logger.debug(`DNS 记录不存在，跳过删除 ${fullName} ${options.type}`);
      return;
    }

    if (existing.type !== options.type) {
      // API 不该返回别的类型；真返回了就宁可不删，也不动别人的记录。
      this.logger.warn(
        `拒绝删除类型不匹配的记录 ${fullName}：请求 ${options.type}，返回 ${existing.type}`,
      );
      return;
    }

    await this.callApi<{ id: string }>(
      `zones/${zoneId}/dns_records/${existing.id}`,
      'DELETE'
    );
    this.logger.info(`已删除 DNS 记录 ${fullName} ${options.type}`);
  }

  public async listRecords(options: ListDnsRecordsInput): Promise<DnsRecordSummary[]> {
    if (!this.enabled) {
      return [];
    }

    const zoneId = await this.getZoneId(options.domain);
    const params = new URLSearchParams();
    
    if (options.subdomain) {
      params.set('name', this.buildFullName(options.subdomain, options.domain));
    }
    if (options.type) {
      params.set('type', options.type);
    }
    params.set('per_page', '100');

    const queryString = params.toString();
    const endpoint = `zones/${zoneId}/dns_records${queryString ? `?${queryString}` : ''}`;
    const response = await this.callApi<CloudflareDnsRecord[]>(endpoint, 'GET');

    return response.map((record) => this.toRecordSummary(record, options.domain));
  }

  /**
   * 获取 Zone ID，优先使用配置的，否则自动查找
   * 支持从子域名向上递归查找 Zone
   */
  private async getZoneId(domain: string): Promise<string> {
    if (this.configuredZoneId) {
      return this.configuredZoneId;
    }

    const cached = this.zoneIdCache.get(domain);
    if (cached) {
      return cached;
    }

    // 自动查找 Zone ID，如果找不到则尝试向上级域名查找
    let currentDomain = domain;
    while (currentDomain.includes('.')) {
      const response = await this.callApi<CloudflareZone[]>(
        `zones?name=${encodeURIComponent(currentDomain)}&status=active`,
        'GET'
      );

      if (response.length > 0) {
        const zoneId = response[0].id;
        // 注意：这里缓存的是原始查询域名 -> 找到的 zoneId
        this.zoneIdCache.set(domain, zoneId);
        this.logger.debug(`已查找到域名 ${domain} 的所属 Zone (${currentDomain}) ID: ${zoneId}`);
        return zoneId;
      }

      // 移除第一段 (如 a.b.com -> b.com)
      const parts = currentDomain.split('.');
      if (parts.length <= 2) break; // 已经到了顶级域名，停止
      currentDomain = parts.slice(1).join('.');
    }

    throw new Error(`找不到域名 ${domain} 的任何所属 Zone，请检查域名是否正确或手动提供 zoneId`);
  }

  /**
   * 查找现有 DNS 记录。
   *
   * `type` 与 `value` 都会下推到 API 查询里，返回**全部**匹配项而不是 `response[0]`：
   * 调用方要按类型判断能不能动这条记录，靠“第一条”猜类型正是 N14 的成因。
   */
  private async findRecords(
    zoneId: string,
    fullName: string,
    type?: DnsRecordTypeValue,
    value?: string
  ): Promise<CloudflareDnsRecord[]> {
    const params = new URLSearchParams({
      name: fullName,
    });
    if (type) {
      params.set('type', type);
    }
    if (value) {
      params.set('content', value);
    }

    const response = await this.callApi<CloudflareDnsRecord[]>(
      `zones/${zoneId}/dns_records?${params.toString()}`,
      'GET'
    );

    return Array.isArray(response) ? response : [];
  }

  private async findRecord(
    zoneId: string,
    fullName: string,
    type?: DnsRecordTypeValue,
    value?: string
  ): Promise<CloudflareDnsRecord | undefined> {
    return (await this.findRecords(zoneId, fullName, type, value)).find(
      (record) => type === undefined || record.type === type,
    );
  }

  /**
   * 是否与目标类型互斥：CNAME 不能与任何其他记录共存（RFC 1034），其余组合（含 TXT 与
   * A/AAAA、MX 与 A/AAAA）都可以并存。
   */
  private static isMutuallyExclusive(target: DnsRecordTypeValue, existing: string): boolean {
    if (existing === target) {
      return false;
    }
    if (target === 'TXT') {
      return false;
    }
    if (existing === 'CNAME') {
      return true;
    }
    return target === 'CNAME' && (existing === 'A' || existing === 'AAAA');
  }

  /**
   * 调用 Cloudflare API
   */
  private async callApi<T>(endpoint: string, method: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json() as CloudflareApiResponse<T>;

      if (!data.success) {
        const errorMsg = data.errors.map((e) => `${e.code}: ${e.message}`).join(', ');
        throw new Error(`Cloudflare API 错误: ${errorMsg}`);
      }

      return data.result;
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error(`Cloudflare API 请求超时 (${this.timeoutMs}ms)`);
      }
      throw error;
    }
  }

  /**
   * 构建完整域名
   */
  private buildFullName(subdomain: string, domain: string): string {
    if (subdomain === '@' || subdomain === '') {
      return domain;
    }
    return `${subdomain}.${domain}`;
  }

  /**
   * 转换为通用记录摘要
   */
  private toRecordSummary(record: CloudflareDnsRecord, domain: string): DnsRecordSummary {
    const subdomain = record.name === domain ? '@' : record.name.replace(`.${domain}`, '');
    return {
      id: record.id,
      domain,
      subdomain,
      type: record.type as DnsRecordTypeValue,
      value: record.content,
      ttl: record.ttl,
      line: 'default',
      lineId: 'default',
    };
  }

  private normalizeString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeTimeout(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return undefined;
  }
}