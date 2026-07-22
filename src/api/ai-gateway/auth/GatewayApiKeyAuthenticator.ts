import type { IncomingMessage } from 'node:http';
import type { Authenticator, AuthResult } from '../../auth/Authenticator';
import type { AuthContext, SolidAuthContext } from '../../auth/AuthContext';
import {
  type GatewayDeployment,
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

export interface GatewayAccessKeyRepositoryContext {
  auth?: AuthContext;
}

export interface GatewayAccessKeyRepository {
  create(record: GatewayAccessKeyRecord, context?: GatewayAccessKeyRepositoryContext): Promise<GatewayAccessKeyRecord>;
  findById(id: string): Promise<GatewayAccessKeyRecord | undefined>;
  listByOwner(owner: string, context?: GatewayAccessKeyRepositoryContext): Promise<GatewayAccessKeyRecord[]>;
  revoke(id: string, revokedAt: Date, context?: GatewayAccessKeyRepositoryContext): Promise<GatewayAccessKeyRecord | undefined>;
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
export const DEFAULT_GATEWAY_API_KEY_SCOPES = ['models:read', 'inference:write'] as const;

export class GatewayApiKeyAuthenticator implements Authenticator {
  private readonly repository: GatewayAccessKeyRepository;
  private readonly deployment: GatewayDeployment;
  private readonly requiredScopes: string[];
  private readonly now: () => Date;

  public constructor(options: GatewayApiKeyAuthenticatorOptions) {
    this.repository = options.repository;
    this.deployment = options.deployment;
    this.requiredScopes = options.requiredScopes ?? [...DEFAULT_GATEWAY_API_KEY_SCOPES];
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

function invalidGatewayApiKey(): AuthResult {
  return { success: false, error: INVALID_GATEWAY_API_KEY };
}

function isExpired(record: GatewayAccessKeyRecord, now: Date): boolean {
  return Boolean(record.expiresAt && record.expiresAt.getTime() <= now.getTime());
}

function hasRequiredScopes(scopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.every((scope) => scopes.includes(scope));
}
