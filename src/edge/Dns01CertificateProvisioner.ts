import { getLoggerFor } from '@solid/community-server';
import type { DnsProvider } from '../dns/DnsProvider';
import type { EdgeNodeCertificateProvisioner } from './EdgeNodeCertificateProvisioner';

interface Dns01CertificateProvisionerOptions {
  provider: DnsProvider;
  rootDomain?: string | null;
  ttl?: number | string | null;
}

interface DnsChallengePayload {
  subdomain?: string;
  /** 完整主机名，若提供将覆盖 subdomain。 */
  host?: string;
  value?: string;
  action?: string;
}

export class Dns01CertificateProvisioner implements EdgeNodeCertificateProvisioner {
  private readonly logger = getLoggerFor(this);
  private readonly provider: DnsProvider;
  private readonly rootDomain?: string;
  private readonly ttl?: number;
  private readonly enabled: boolean;

  public constructor(options: Dns01CertificateProvisionerOptions) {
    this.provider = options.provider;
    this.rootDomain = this.normalizeRootDomain(options.rootDomain);
    this.ttl = this.normalizeTtl(options.ttl);
    this.enabled = true;
  }

  public async handleCertificateRequest(nodeId: string, metadata: Record<string, unknown>): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const payload = this.extractPayload(metadata);
    if (!payload) {
      return;
    }

    const host = payload.host ?? this.composeHost(payload.subdomain ?? this.extractSubdomain(metadata));
    if (!host) {
      this.logger.warn(`节点 ${nodeId} 未提供有效的证书域名，跳过 DNS-01 编排。`);
      return;
    }

    const action = (payload.action ?? 'set').toLowerCase();
    if (action === 'remove') {
      await this.removeRecord(nodeId, host);
      return;
    }

    const value = payload.value?.trim();
    if (!value) {
      this.logger.warn(`节点 ${nodeId} 未提供 DNS-01 challenge 值，跳过处理。`);
      return;
    }

    await this.publishChallenge(host, value, nodeId);
  }

  public async publishChallenge(host: string, value: string, nodeId?: string): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const { domain, subdomain } = this.splitHost(host);

    try {
      await this.provider.upsertRecord({
        domain,
        subdomain,
        type: 'TXT',
        value,
        ttl: this.ttl,
      });
      this.logger.debug(`已写入 DNS-01 challenge 记录 ${subdomain}.${domain}${nodeId ? `（节点 ${nodeId}）` : ''}`);
    } catch (error: unknown) {
      this.logger.error(`DNS-01 编排失败${nodeId ? `（节点 ${nodeId}）` : ''}: ${(error as Error).message}`);
      throw error;
    }
  }

  public async removeChallenge(host: string, nodeId?: string): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const { domain, subdomain } = this.splitHost(host);
    try {
      await this.provider.deleteRecord({
        domain,
        subdomain,
        type: 'TXT',
      });
      this.logger.debug(`已移除 DNS-01 记录 ${subdomain}.${domain}${nodeId ? `（节点 ${nodeId}）` : ''}`);
    } catch (error: unknown) {
      this.logger.warn(`删除 DNS-01 记录失败${nodeId ? `（节点 ${nodeId}）` : ''}：${(error as Error).message}`);
    }
  }

  private extractPayload(metadata: Record<string, unknown>): DnsChallengePayload | undefined {
    const certificate = metadata?.certificate;
    if (!certificate || typeof certificate !== 'object') {
      return undefined;
    }
    const dns01 = (certificate as Record<string, unknown>).dns01;
    if (!dns01 || typeof dns01 !== 'object') {
      return undefined;
    }
    const record = dns01 as Record<string, unknown>;
    return {
      subdomain: this.asString(record.subdomain),
      host: this.asString(record.host),
      value: this.asString(record.value),
      action: this.asString(record.action),
    };
  }

  private extractSubdomain(metadata: Record<string, unknown>): string | undefined {
    const dns = metadata?.dns;
    if (!dns || typeof dns !== 'object') {
      return undefined;
    }
    return this.asString((dns as Record<string, unknown>).subdomain);
  }

  private asString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private composeHost(subdomain?: string): string | undefined {
    if (!subdomain || !this.rootDomain) {
      return undefined;
    }
    return `${subdomain}.${this.rootDomain}`;
  }

  private splitHost(host: string): { domain: string; subdomain: string } {
    const normalized = host.replace(/\s+/gu, '.').replace(/\.+/gu, '.').replace(/\.$/, '');
    if (this.rootDomain && normalized.endsWith(`.${this.rootDomain}`)) {
      const sub = normalized.slice(0, -1 * (`.${this.rootDomain}`.length));
      return { domain: this.rootDomain, subdomain: sub.length > 0 ? sub : '@' };
    }
    const parts = normalized.split('.');
    const fallbackDomain = this.rootDomain ?? normalized;
    if (parts.length <= 1) {
      return { domain: fallbackDomain, subdomain: '@' };
    }
    const domain = this.rootDomain ?? parts.slice(-2).join('.');
    const subdomain = parts.slice(0, -2).join('.') || '@';
    return { domain, subdomain };
  }

  private normalizeRootDomain(value?: string | null): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    let trimmed = value.trim();
    if (trimmed.includes('://')) {
      try {
        trimmed = new URL(trimmed).hostname;
      } catch {
        // ignore
      }
    }
    trimmed = trimmed.replace(/\.$/, '');
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeTtl(value?: number | string | null): number | undefined {
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

  private async removeRecord(nodeId: string, host: string): Promise<void> {
    await this.removeChallenge(host, nodeId);
  }
}
