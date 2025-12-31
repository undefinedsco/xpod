import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import acme from 'acme-client';
import type { Authorization } from 'acme-client';
import { getLoggerFor } from 'global-logger-factory';
import { DnsChallengeClient } from './DnsChallengeClient';
import { toDns01Value } from './utils';

export interface AcmeCertificateManagerOptions {
  signalEndpoint: string;
  nodeId: string;
  nodeToken: string;
  email: string;
  domains: string[];
  directoryUrl?: string;
  fallbackDirectoryUrls?: string[]; // CA failover support
  accountKeyPath: string;
  certificateKeyPath: string;
  certificatePath: string;
  fullChainPath?: string;
  renewBeforeDays?: number;
  propagationDelayMs?: number;
}

const DEFAULT_DIRECTORY_URL = acme.directory.letsencrypt.production;
const DEFAULT_FALLBACK_URLS = [
  acme.directory.letsencrypt.staging, // Staging as fallback for testing
  'https://acme.zerossl.com/v2/DV90', // ZeroSSL as alternative CA
];

export class AcmeCertificateManager {
  private readonly logger = getLoggerFor(this);
  private readonly dnsClient: DnsChallengeClient;
  private readonly email: string;
  private readonly domains: string[];
  private readonly directoryUrl: string;
  private readonly fallbackDirectoryUrls: string[];
  private readonly accountKeyPath: string;
  private readonly certificateKeyPath: string;
  private readonly certificatePath: string;
  private readonly fullChainPath?: string;
  private readonly renewBeforeDays: number;
  private readonly propagationDelayMs: number;

  public constructor(options: AcmeCertificateManagerOptions) {
    this.dnsClient = new DnsChallengeClient({
      signalEndpoint: options.signalEndpoint,
      nodeId: options.nodeId,
      nodeToken: options.nodeToken,
    });
    this.email = options.email;
    this.domains = options.domains;
    this.directoryUrl = options.directoryUrl ?? DEFAULT_DIRECTORY_URL;
    this.fallbackDirectoryUrls = options.fallbackDirectoryUrls ?? DEFAULT_FALLBACK_URLS;
    this.accountKeyPath = options.accountKeyPath;
    this.certificateKeyPath = options.certificateKeyPath;
    this.certificatePath = options.certificatePath;
    this.fullChainPath = options.fullChainPath;
    this.renewBeforeDays = options.renewBeforeDays ?? 15;
    this.propagationDelayMs = options.propagationDelayMs ?? 15_000;
  }

  public async ensureCertificate(): Promise<boolean> {
    if (await this.isCertificateValid()) {
      this.logger.debug('现有证书仍在有效期内，跳过 ACME 申请。');
      return false;
    }
    await this.issueCertificate();
    return true;
  }

  private async isCertificateValid(): Promise<boolean> {
    try {
      const certPem = await fs.readFile(this.certificatePath, 'utf8');
      const cert = new X509Certificate(certPem);
      const expiresAt = cert.validTo ? new Date(cert.validTo).getTime() : NaN;
      if (!Number.isFinite(expiresAt)) {
        return false;
      }
      const remainingMs = expiresAt - Date.now();
      const thresholdMs = this.renewBeforeDays * 24 * 60 * 60 * 1000;
      const containsAllDomains = this.domains.every((domain) => cert.subjectAltName?.includes(domain));
      return remainingMs > thresholdMs && containsAllDomains;
    } catch {
      return false;
    }
  }

  private async issueCertificate(): Promise<void> {
    this.logger.info(`申请 ACME 证书：${this.domains.join(', ')}`);
    await this.ensureDirectory(dirname(this.accountKeyPath));
    await this.ensureDirectory(dirname(this.certificateKeyPath));
    await this.ensureDirectory(dirname(this.certificatePath));
    if (this.fullChainPath) {
      await this.ensureDirectory(dirname(this.fullChainPath));
    }

    // Try primary CA first, then fallback CAs
    const directoryUrls = [this.directoryUrl, ...this.fallbackDirectoryUrls];
    let lastError: Error | undefined;

    for (const directoryUrl of directoryUrls) {
      try {
        await this.issueCertificateFromCA(directoryUrl);
        return; // Success!
      } catch (error: unknown) {
        lastError = error as Error;
        this.logger.warn(`ACME CA ${directoryUrl} 失败: ${lastError.message}`);
        if (directoryUrl !== directoryUrls[directoryUrls.length - 1]) {
          this.logger.info('尝试下一个 ACME CA...');
        }
      }
    }

    // All CAs failed
    throw new Error(`所有 ACME CA 都失败。最后错误: ${lastError?.message}`);
  }

  private async issueCertificateFromCA(directoryUrl: string): Promise<void> {
    this.logger.info(`使用 ACME CA: ${directoryUrl}`);
    
    const accountKey = await this.loadOrCreateAccountKey(this.accountKeyPath);
    const client = new acme.Client({
      directoryUrl,
      accountKey,
    });

    await this.ensureAccount(client);

    const existingCertKey = await this.readOptionalFile(this.certificateKeyPath);
    const [ privateKey, csr ] = await acme.crypto.createCsr({
      altNames: this.domains,
      commonName: this.domains[0],
    }, existingCertKey ?? undefined);

    const certificate = await client.auto({
      csr,
      email: this.email,
      termsOfServiceAgreed: true,
      challengePriority: [ 'dns-01' ],
      challengeCreateFn: async (authz: Authorization, _challenge: unknown, keyAuthorization: string): Promise<void> => {
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        const value = toDns01Value(keyAuthorization);
        await this.dnsClient.setChallenge(recordName, value);
        await this.delay(this.propagationDelayMs);
      },
      challengeRemoveFn: async (authz: Authorization): Promise<void> => {
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        await this.dnsClient.removeChallenge(recordName);
      },
    });

    await fs.writeFile(this.certificateKeyPath, privateKey.toString());
    await fs.writeFile(this.certificatePath, certificate);
    if (this.fullChainPath) {
      await fs.writeFile(this.fullChainPath, certificate);
    }
    this.logger.info(`ACME 证书申请成功 (CA: ${directoryUrl})`);
  }

  private async ensureAccount(client: acme.Client): Promise<void> {
    try {
      await client.createAccount({
        termsOfServiceAgreed: true,
        contact: [ `mailto:${this.email}` ],
      });
      this.logger.debug('ACME 账户已创建。');
    } catch (error: unknown) {
      if (this.isConflictError(error)) {
        this.logger.debug('ACME 账户已存在，跳过创建。');
      } else {
        throw error;
      }
    }
  }

  private async loadOrCreateAccountKey(path: string): Promise<string> {
    const existing = await this.readOptionalFile(path);
    if (existing) {
      return existing.toString();
    }
    await this.ensureDirectory(dirname(path));
    const key = await acme.crypto.createPrivateKey();
    await fs.writeFile(path, key);
    return key.toString();
  }

  private async readOptionalFile(path: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(path);
    } catch {
      return undefined;
    }
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (!path || path === '.') {
      return;
    }
    await mkdir(path, { recursive: true });
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isConflictError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'status' in error && (error as any).status === 409);
  }
}
