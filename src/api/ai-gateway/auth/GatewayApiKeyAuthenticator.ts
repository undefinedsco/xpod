import type { IncomingMessage } from 'node:http';
import type { Authenticator, AuthResult } from '../../auth/Authenticator';
import type { SolidAuthContext } from '../../auth/AuthContext';
import {
  type GatewayDeployment,
  hashGatewayApiKeySecret,
  parseGatewayApiKey,
  verifyGatewayApiKeySecret,
} from './GatewayApiKey';

export interface GatewayAccessKeyRecord {
  id: string;
  owner: string;
  secretHash: string;
  deployment: GatewayDeployment;
  scopes: string[];
  createdAt: Date;
  expiresAt?: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
  name?: string;
}

export interface GatewayAccessKeyRepository {
  create(record: GatewayAccessKeyRecord): Promise<GatewayAccessKeyRecord>;
  findById(id: string): Promise<GatewayAccessKeyRecord | undefined>;
  listByOwner(owner: string): Promise<GatewayAccessKeyRecord[]>;
  revoke(id: string, revokedAt: Date): Promise<GatewayAccessKeyRecord | undefined>;
  touchLastUsed(id: string, lastUsedAt: Date): Promise<void>;
  verifySecretHashForTimingOnly(secret: string): Promise<void>;
}

export interface GatewayApiKeyAuthenticatorOptions {
  repository: GatewayAccessKeyRepository;
  deployment: GatewayDeployment;
  requiredScopes?: string[];
  now?: () => Date;
}

const INVALID_GATEWAY_API_KEY = 'Invalid gateway API key';

export class GatewayApiKeyAuthenticator implements Authenticator {
  private readonly repository: GatewayAccessKeyRepository;
  private readonly deployment: GatewayDeployment;
  private readonly requiredScopes: string[];
  private readonly now: () => Date;

  public constructor(options: GatewayApiKeyAuthenticatorOptions) {
    this.repository = options.repository;
    this.deployment = options.deployment;
    this.requiredScopes = options.requiredScopes ?? ['gateway:invoke'];
    this.now = options.now ?? (() => new Date());
  }

  public canAuthenticate(request: IncomingMessage): boolean {
    return Boolean(this.readGatewayKey(request));
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    const parsed = this.readGatewayKey(request);
    if (!parsed) {
      return { success: false, error: INVALID_GATEWAY_API_KEY };
    }

    const record = await this.repository.findById(parsed.keyId);
    if (!record) {
      await this.repository.verifySecretHashForTimingOnly(parsed.secret);
      return invalidGatewayApiKey();
    }

    const secretMatches = await verifyGatewayApiKeySecret(parsed.secret, record.secretHash);
    if (
      !secretMatches
      || parsed.deployment !== this.deployment
      || record.deployment !== this.deployment
      || record.revokedAt
      || isExpired(record, this.now())
      || !hasRequiredScopes(record.scopes, this.requiredScopes)
    ) {
      return invalidGatewayApiKey();
    }

    const lastUsedAt = this.now();
    await this.repository.touchLastUsed(record.id, lastUsedAt);

    const context: SolidAuthContext = {
      type: 'solid',
      webId: record.owner,
      accountId: record.owner,
      viaGatewayApiKey: true,
      gatewayKeyId: record.id,
      scopes: record.scopes,
      tokenType: 'Bearer',
    };
    return { success: true, context };
  }

  private readGatewayKey(request: IncomingMessage): ReturnType<typeof parseGatewayApiKey> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return undefined;
    }
    return parseGatewayApiKey(authorization.slice(7).trim());
  }
}

export class InMemoryGatewayAccessKeyRepository implements GatewayAccessKeyRepository {
  private readonly records = new Map<string, GatewayAccessKeyRecord>();
  private dummyHash?: Promise<string>;

  public async create(record: GatewayAccessKeyRecord): Promise<GatewayAccessKeyRecord> {
    const stored = cloneRecord(record);
    this.records.set(record.id, stored);
    return cloneRecord(stored);
  }

  public async findById(id: string): Promise<GatewayAccessKeyRecord | undefined> {
    const record = this.records.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  public async listByOwner(owner: string): Promise<GatewayAccessKeyRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.owner === owner)
      .map(cloneRecord)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  public async revoke(id: string, revokedAt: Date): Promise<GatewayAccessKeyRecord | undefined> {
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

function invalidGatewayApiKey(): AuthResult {
  return { success: false, error: INVALID_GATEWAY_API_KEY };
}

function isExpired(record: GatewayAccessKeyRecord, now: Date): boolean {
  return Boolean(record.expiresAt && record.expiresAt.getTime() <= now.getTime());
}

function hasRequiredScopes(scopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.every((scope) => scopes.includes(scope));
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
