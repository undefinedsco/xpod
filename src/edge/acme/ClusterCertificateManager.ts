import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { X509Certificate } from 'node:crypto';
import acme from 'acme-client';
import { getLoggerFor } from '@solid/community-server';

interface ClusterCertificateManagerOptions {
  signalEndpoint: string;
  nodeId: string;
  nodeToken: string;
  certificateKeyPath: string;
  certificatePath: string;
  fullChainPath?: string;
  renewBeforeDays?: number;
  checkIntervalMs?: number;
  onCertificateInstalled?: () => Promise<void> | void;
}

interface CertificateStatus {
  expiresAt?: Date;
  domains?: string[];
  updatedAt?: Date;
}

interface CertificateResponse {
  status: string;
  certificate: {
    pem: string;
    fullChain: string;
    expiresAt: string;
    domains: string[];
  };
}

export class ClusterCertificateManager {
  private readonly logger = getLoggerFor(this);
  private readonly endpoint: string;
  private readonly nodeId: string;
  private readonly nodeToken: string;
  private readonly certificateKeyPath: string;
  private readonly certificatePath: string;
  private readonly fullChainPath?: string;
  private readonly renewBeforeMs: number;
  private readonly checkIntervalMs: number;
  private readonly onCertificateInstalled?: () => Promise<void> | void;
  private assignedDomain?: string;
  private status: CertificateStatus = {};
  private interval?: NodeJS.Timeout;
  private issuing = false;

  public constructor(options: ClusterCertificateManagerOptions) {
    this.endpoint = `${options.signalEndpoint.replace(/\/$/u, '')}/certificate`;
    this.nodeId = options.nodeId;
    this.nodeToken = options.nodeToken;
    this.certificateKeyPath = options.certificateKeyPath;
    this.certificatePath = options.certificatePath;
    this.fullChainPath = options.fullChainPath;
    this.renewBeforeMs = (options.renewBeforeDays ?? 15) * 24 * 60 * 60 * 1000;
    this.checkIntervalMs = options.checkIntervalMs ?? 6 * 60 * 60 * 1000;
    this.onCertificateInstalled = options.onCertificateInstalled;
  }

  public async start(): Promise<void> {
    await this.refreshCertificateStatus();
    await this.ensureCertificate();
    this.interval = setInterval(() => {
      void this.ensureCertificate().catch((error: unknown) => {
        this.logger.error(`定期检查证书失败：${(error as Error).message}`);
      });
    }, this.checkIntervalMs);
  }

  public stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  public handleHeartbeatMetadata(metadata?: Record<string, unknown>): void {
    const subdomain = typeof metadata?.subdomain === 'string' ? metadata.subdomain.trim() : undefined;
    if (subdomain && subdomain.length > 0) {
      this.assignedDomain = subdomain.toLowerCase();
    }
  }

  public getHeartbeatPayload(): Record<string, unknown> | undefined {
    if (!this.status.expiresAt) {
      return undefined;
    }
    return {
      deployment: {
        expiresAt: this.status.expiresAt.toISOString(),
        domains: this.status.domains ?? [],
        updatedAt: this.status.updatedAt?.toISOString(),
      },
    };
  }

  private async ensureCertificate(): Promise<void> {
    if (this.issuing) {
      return;
    }
    if (!this.assignedDomain) {
      this.logger.debug('尚未分配域名，等待下一次心跳。');
      return;
    }
    const valid = await this.isCertificateValid();
    if (valid) {
      return;
    }

    this.issuing = true;
    try {
      await this.requestCertificate();
      await this.refreshCertificateStatus();
      if (this.onCertificateInstalled) {
        await this.onCertificateInstalled();
      }
    } finally {
      this.issuing = false;
    }
  }

  private async isCertificateValid(): Promise<boolean> {
    if (!this.status.expiresAt || !this.assignedDomain) {
      return false;
    }
    const remaining = this.status.expiresAt.getTime() - Date.now();
    if (remaining <= this.renewBeforeMs) {
      return false;
    }
    if (!this.status.domains?.includes(this.assignedDomain)) {
      return false;
    }
    return true;
  }

  private async refreshCertificateStatus(): Promise<void> {
    try {
      const pem = await fs.readFile(this.certificatePath, 'utf8');
      const cert = new X509Certificate(pem);
      const expiresAt = cert.validTo ? new Date(cert.validTo) : undefined;
      const domains = this.extractDomainsFromCertificate(cert);
      this.status = {
        expiresAt,
        domains,
        updatedAt: new Date(),
      };
    } catch {
      this.status = {};
    }
  }

  private extractDomainsFromCertificate(cert: X509Certificate): string[] {
    const result = new Set<string>();
    const subject = cert.subject;
    if (subject) {
      const match = /CN=([^,]+)/u.exec(subject);
      if (match?.[1]) {
        result.add(match[1].trim().toLowerCase());
      }
    }
    const altNames = cert.subjectAltName?.split(',');
    if (altNames) {
      for (const entry of altNames) {
        const trimmed = entry.trim();
        if (trimmed.toLowerCase().startsWith('dns:')) {
          result.add(trimmed.slice(4).trim().toLowerCase());
        }
      }
    }
    return Array.from(result);
  }

  private async requestCertificate(): Promise<void> {
    if (!this.assignedDomain) {
      throw new Error('无法申请证书：尚未分配域名。');
    }
    this.logger.info(`节点 ${this.nodeId} 正在向集群申请证书 (${this.assignedDomain})`);
    const { privateKey, csr } = await this.generateKeyAndCsr(this.assignedDomain);

    await this.ensureDirectory(dirname(this.certificateKeyPath));
    await fs.writeFile(this.certificateKeyPath, privateKey, 'utf8');

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeId: this.nodeId,
        token: this.nodeToken,
        csr,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`申请证书失败：${response.status} ${response.statusText} ${text}`);
    }

    const payload = await response.json() as CertificateResponse;
    if (!payload.certificate?.fullChain) {
      throw new Error('集群返回数据缺少证书内容。');
    }

    await this.ensureDirectory(dirname(this.certificatePath));
    await fs.writeFile(this.certificatePath, payload.certificate.fullChain, 'utf8');
    if (this.fullChainPath) {
      await this.ensureDirectory(dirname(this.fullChainPath));
      await fs.writeFile(this.fullChainPath, payload.certificate.fullChain, 'utf8');
    }
    this.logger.info(`节点 ${this.nodeId} 已获取最新证书，有效期至 ${payload.certificate.expiresAt}`);
  }

  private async generateKeyAndCsr(domain: string): Promise<{ privateKey: string; csr: string }> {
    const privateKey = await acme.crypto.createPrivateKey();
    const [, csr] = await acme.crypto.createCsr({
      commonName: domain,
      altNames: [ domain ],
    }, privateKey);
    return {
      privateKey: privateKey.toString(),
      csr: csr.toString(),
    };
  }

  private async ensureDirectory(target: string): Promise<void> {
    if (!target || target === '.') {
      return;
    }
    await fs.mkdir(target, { recursive: true });
  }
}
