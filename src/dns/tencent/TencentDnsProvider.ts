import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { getLoggerFor } from '@solid/community-server';
import type {
  DeleteDnsRecordInput,
  DnsProvider,
  DnsRecordSummary,
  DnsRecordTypeValue,
  ListDnsRecordsInput,
  ListableDnsProvider,
  UpsertDnsRecordInput,
} from '../DnsProvider';

interface TencentDnsProviderOptions {
  tokenId?: string | null;
  token?: string | null;
  /** API 根地址，默认为 `https://dnsapi.cn`。 */
  baseUrl?: string | null;
  /**
   * 默认线路 ID，腾讯云 DNS 默认线路为 `0`。
   * 若未指定且记录已存在，将复用已有线路。
   */
  defaultLineId?: string | null;
  /** HTTP 请求超时毫秒数，默认 10s。 */
  timeoutMs?: number | string | null;
  /** User-Agent 标识，便于审计。 */
  userAgent?: string | null;
}

interface TencentApiStatus {
  code: string;
  message: string;
  created_at?: string;
}

type TencentApiResponse<T> = T & { status: TencentApiStatus };

interface TencentRecordInfo {
  id: string;
  name: string;
  type: string;
  value: string;
  ttl: number | string;
  line: string;
  line_id: string;
}

/**
 * 基于腾讯云 DNSPod v2 API 的 DNS 提供方实现。
 */
export class TencentDnsProvider implements ListableDnsProvider {
  private readonly logger = getLoggerFor(this);
  private readonly tokenId: string;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly defaultLineId: string;
  private readonly timeoutMs: number;
  private readonly userAgent?: string;
  private readonly enabled: boolean;

  public constructor(options: TencentDnsProviderOptions) {
    this.tokenId = this.normalizeString(options.tokenId) ?? '';
    this.token = this.normalizeString(options.token) ?? '';
    this.baseUrl = (this.normalizeString(options.baseUrl) ?? 'https://dnsapi.cn').replace(/\/$/, '');
    this.defaultLineId = this.normalizeString(options.defaultLineId) ?? '0';
    this.timeoutMs = this.normalizeTimeout(options.timeoutMs) ?? 10_000;
    this.userAgent = this.normalizeString(options.userAgent) ?? undefined;
    this.enabled = this.tokenId.length > 0 && this.token.length > 0;
    if (!this.enabled) {
      this.logger.info('TencentDnsProvider 未配置 token，将以禁用状态运行。');
    }
  }

  public async upsertRecord(options: UpsertDnsRecordInput): Promise<void> {
    if (!this.enabled) {
      this.logger.debug('DNS provider disabled，跳过 upsert。');
      return;
    }
    const existing = await this.findRecord(options.domain, options.subdomain, options.type);
    const lineId = options.lineId ?? existing?.line_id ?? this.defaultLineId;
    const ttl = this.normalizeTtl(options.ttl ?? (typeof existing?.ttl === 'number' ? existing.ttl : undefined));

    if (existing) {
      if (existing.value === options.value && this.compareLine(existing, lineId) && this.compareTtl(existing, ttl)) {
        this.logger.debug(`DNS 记录已存在且一致，跳过更新 ${options.subdomain}.${options.domain} ${options.type}`);
        return;
      }

      await this.callApi('Record.Modify', {
        domain: options.domain,
        record_id: existing.id,
        sub_domain: options.subdomain,
        record_type: options.type,
        value: options.value,
        record_line_id: lineId,
        ttl,
      });
      this.logger.info(`已更新 DNS 记录 ${options.subdomain}.${options.domain} ${options.type}`);
      return;
    }

    await this.callApi('Record.Create', {
      domain: options.domain,
      sub_domain: options.subdomain,
      record_type: options.type,
      value: options.value,
      record_line_id: lineId,
      ttl,
    });
    this.logger.info(`已创建 DNS 记录 ${options.subdomain}.${options.domain} ${options.type}`);
  }

  public async deleteRecord(options: DeleteDnsRecordInput): Promise<void> {
    if (!this.enabled) {
      this.logger.debug('DNS provider disabled，跳过 delete。');
      return;
    }
    const record = await this.findRecord(options.domain, options.subdomain, options.type, options.value);
    if (!record) {
      this.logger.debug(`未找到可删除的 DNS 记录 ${options.subdomain}.${options.domain} ${options.type}`);
      return;
    }

    await this.callApi('Record.Delete', {
      domain: options.domain,
      record_id: record.id,
    });
    this.logger.info(`已删除 DNS 记录 ${options.subdomain}.${options.domain} ${options.type}`);
  }

  public async listRecords(options: ListDnsRecordsInput): Promise<DnsRecordSummary[]> {
    if (!this.enabled) {
      return [];
    }
    const records = await this.callApi<'records', TencentRecordInfo[]>(
      'Record.List',
      {
        domain: options.domain,
        sub_domain: options.subdomain,
        record_type: options.type,
      }
    );
    const list = Array.isArray(records.records) ? records.records : [];
    return list.map((record) => this.toSummary(options.domain, record));
  }

  private toSummary(domain: string, record: TencentRecordInfo): DnsRecordSummary {
    return {
      id: String(record.id),
      domain,
      subdomain: record.name,
      type: record.type as DnsRecordTypeValue,
      value: record.value,
      ttl: typeof record.ttl === 'number' ? record.ttl : Number.parseInt(record.ttl, 10),
      line: record.line,
      lineId: record.line_id,
    };
  }

  private async findRecord(domain: string, subdomain: string, type: DnsRecordTypeValue, value?: string): Promise<TencentRecordInfo | undefined> {
    if (!this.enabled) {
      return undefined;
    }
    const response = await this.callApi<'records', TencentRecordInfo[]>(
      'Record.List',
      {
        domain,
        sub_domain: subdomain,
        record_type: type,
      }
    );
    const records = Array.isArray(response.records) ? response.records : [];
    const normalizedValue = value?.trim().toLowerCase();
    return records.find((record) => {
      if (record.type?.toUpperCase() !== type.toUpperCase()) {
        return false;
      }
      if (!normalizedValue) {
        return true;
      }
      return String(record.value ?? '').trim().toLowerCase() === normalizedValue;
    });
  }

  private compareLine(record: TencentRecordInfo, lineId: string): boolean {
    return String(record.line_id ?? '').trim() === lineId.trim();
  }

  private compareTtl(record: TencentRecordInfo, ttl?: number): boolean {
    if (ttl == null) {
      return true;
    }
    const current = typeof record.ttl === 'number' ? record.ttl : Number.parseInt(record.ttl, 10);
    return Number.isFinite(current) ? current === ttl : true;
  }

  private normalizeTtl(ttl?: number): number | undefined {
    if (ttl == null) {
      return undefined;
    }
    const value = Math.max(1, Math.trunc(ttl));
    return Number.isFinite(value) ? value : undefined;
  }

  private async callApi<K extends string, R>(endpoint: string, payload: Record<string, string | number | undefined>): Promise<TencentApiResponse<{ [key in K]: R }>> {
    if (!this.enabled) {
      throw new Error('Tencent DNS provider 已禁用，无法调用 API。');
    }
    const url = new URL(`/` + endpoint.replace(/^\//, ''), this.baseUrl);
    const body = new URLSearchParams({
      login_token: `${this.tokenId},${this.token}`,
      format: 'json',
      lang: 'en',
      error_on_empty: 'no',
    });

    for (const [ key, value ] of Object.entries(payload)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      body.append(key, String(value));
    }

    const bodyString = body.toString();

    const responseText = await new Promise<string>((resolve, reject) => {
      const request = httpsRequest({
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: url.pathname,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(bodyString),
          ...(this.userAgent ? { 'User-Agent': this.userAgent } : {}),
        },
        timeout: this.timeoutMs,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`Tencent DNS API ${endpoint} HTTP ${res.statusCode ?? 0}: ${data}`));
          }
        });
      });

      request.on('error', (error) => reject(error));
      request.on('timeout', () => {
        request.destroy(new Error(`Tencent DNS API ${endpoint} request timed out after ${this.timeoutMs}ms`));
      });
      request.write(bodyString);
      request.end();
    });

    let parsed: TencentApiResponse<{ [key in K]: R }>;
    try {
      parsed = JSON.parse(responseText) as TencentApiResponse<{ [key in K]: R }>;
    } catch (error: unknown) {
      throw new Error(`Tencent DNS API ${endpoint} 返回非法 JSON: ${(error as Error).message}`);
    }

    if (parsed.status?.code !== '1') {
      throw new Error(`Tencent DNS API ${endpoint} 调用失败: ${parsed.status?.message ?? 'Unknown error'}`);
    }

    return parsed;
  }

  private normalizeString(value?: string | null): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeTimeout(value?: number | string | null): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.trunc(parsed);
      }
    }
    return undefined;
  }
}
