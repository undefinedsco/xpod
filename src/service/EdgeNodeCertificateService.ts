import path from 'node:path';
import { promises as fs } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import acme from 'acme-client';
import { getLoggerFor } from 'global-logger-factory';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';
import type { Dns01CertificateProvisioner } from '../edge/Dns01CertificateProvisioner';
import { toDns01Value } from '../edge/acme/utils';

export interface EdgeNodeCertificateServiceOptions {
  identityDbUrl?: string;
  repository?: EdgeNodeRepository;
  provisioner: Dns01CertificateProvisioner;
  accountKeyPath: string;
  certificateStorePath: string;
  directoryUrl?: string;
  email: string;
  propagationDelayMs?: number;
}

export interface EdgeNodeCertificateRequest {
  nodeId: string;
  csr: string;
  subdomain: string;
}

export interface EdgeNodeCertificateResponse {
  certificate: string;
  fullChain: string;
  expiresAt: string;
  domains: string[];
}

export class EdgeNodeCertificateService {
  private readonly logger = getLoggerFor(this);
  private readonly repository: EdgeNodeRepository;
  private readonly provisioner: Dns01CertificateProvisioner;
  private readonly accountKeyPath: string;
  private readonly certificateStorePath: string;
  private readonly directoryUrl: string;
  private readonly email: string;
  private readonly propagationDelayMs: number;
  private readonly pending: Map<string, Promise<EdgeNodeCertificateResponse>> = new Map();

  public constructor(options: EdgeNodeCertificateServiceOptions) {
    let db;
    if (!options.repository) {
      if (!options.identityDbUrl) {
        throw new Error('EdgeNodeCertificateService 需要 identityDbUrl 或 repository。');
      }
      db = getIdentityDatabase(options.identityDbUrl);
    }

    this.repository = options.repository ?? new EdgeNodeRepository(db!);
    this.provisioner = options.provisioner;
    this.accountKeyPath = options.accountKeyPath;
    this.certificateStorePath = options.certificateStorePath;
    this.directoryUrl = options.directoryUrl ?? acme.directory.letsencrypt.production;
    this.email = options.email;
    this.propagationDelayMs = options.propagationDelayMs ?? 15_000;
  }

  public async issueCertificate(request: EdgeNodeCertificateRequest): Promise<EdgeNodeCertificateResponse> {
    if (this.pending.has(request.nodeId)) {
      return this.pending.get(request.nodeId)!;
    }

    const job = this.issueCertificateInternal(request)
      .finally(() => {
        this.pending.delete(request.nodeId);
      });

    this.pending.set(request.nodeId, job);
    return job;
  }

  private async issueCertificateInternal(request: EdgeNodeCertificateRequest): Promise<EdgeNodeCertificateResponse> {
    const domains = this.extractDomains(request);
    await this.validateDomains(domains, request.subdomain);

    const client = await this.createClient();
    await this.ensureAccount(client);

    const certificate = await client.auto({
      csr: request.csr,
      email: this.email,
      termsOfServiceAgreed: true,
      challengePriority: [ 'dns-01' ],
      challengeCreateFn: async (authz, _challenge, keyAuthorization) => {
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        const value = toDns01Value(keyAuthorization);
        await this.provisioner.publishChallenge(recordName, value, request.nodeId);
        await this.delay(this.propagationDelayMs);
      },
      challengeRemoveFn: async (authz) => {
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        await this.provisioner.removeChallenge(recordName, request.nodeId);
      },
    });

    const [ leaf, ...restChain ] = acme.crypto.splitPemChain(certificate);
    const leafCert = leaf ?? certificate;
    const expiresAt = this.readExpiration(leafCert);
    await this.persistCertificate(request.nodeId, certificate, leafCert);

    await this.repository.mergeNodeMetadata(request.nodeId, {
      certificate: {
        issuedAt: new Date().toISOString(),
        expiresAt,
        domains,
      },
    });

    return {
      certificate: leafCert,
      fullChain: certificate,
      expiresAt,
      domains,
    };
  }

  private extractDomains(request: EdgeNodeCertificateRequest): string[] {
    try {
      const info = acme.crypto.readCsrDomains(request.csr);
      const set = new Set<string>();
      if (info.commonName) {
        set.add(info.commonName.toLowerCase());
      }
      for (const alt of info.altNames ?? []) {
        if (alt) {
          set.add(alt.toLowerCase());
        }
      }
      return Array.from(set);
    } catch (error: unknown) {
      throw new Error(`无法解析 CSR 域名: ${(error as Error).message}`);
    }
  }

  private async validateDomains(domains: string[], expected: string): Promise<void> {
    const normalizedExpected = expected.toLowerCase();
    if (domains.length === 0) {
      throw new Error('CSR 中未包含任何域名。');
    }
    if (domains.length !== 1 || domains[0] !== normalizedExpected) {
      throw new Error(`CSR 域名必须与分配域名一致：${normalizedExpected}`);
    }
  }

  private async createClient(): Promise<acme.Client> {
    const accountKey = await this.loadOrCreateAccountKey();
    return new acme.Client({
      directoryUrl: this.directoryUrl,
      accountKey,
    });
  }

  private async ensureAccount(client: acme.Client): Promise<void> {
    try {
      await client.createAccount({
        termsOfServiceAgreed: true,
        contact: [ `mailto:${this.email}` ],
      });
      this.logger.debug('ACME 账户已创建。');
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'status' in error && (error as any).status === 409) {
        this.logger.debug('ACME 账户已存在，跳过创建。');
      } else {
        throw error;
      }
    }
  }

  private async loadOrCreateAccountKey(): Promise<string> {
    try {
      return await fs.readFile(this.accountKeyPath, 'utf8');
    } catch {
      await fs.mkdir(path.dirname(this.accountKeyPath), { recursive: true });
      const key = await acme.crypto.createPrivateKey();
      await fs.writeFile(this.accountKeyPath, key.toString());
      return key.toString();
    }
  }

  private async persistCertificate(nodeId: string, fullChain: string, leaf: string): Promise<void> {
    const nodeDir = path.join(this.certificateStorePath, nodeId);
    await fs.mkdir(nodeDir, { recursive: true });
    await fs.writeFile(path.join(nodeDir, 'fullchain.pem'), fullChain, 'utf8');
    await fs.writeFile(path.join(nodeDir, 'cert.pem'), leaf, 'utf8');
  }

  private readExpiration(pem: string): string {
    const cert = new X509Certificate(pem);
    return cert.validTo ? new Date(cert.validTo).toISOString() : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
