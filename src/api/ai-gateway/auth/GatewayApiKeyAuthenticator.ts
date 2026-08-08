import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { Authenticator, AuthResult } from '../../auth/Authenticator';
import type { AuthContext, SolidAuthContext } from '../../auth/AuthContext';
import {
  type GatewayDeployment,
  hashGatewayApiKeySecret,
  parseGatewayApiKey,
  verifyGatewayApiKeySecret,
} from './GatewayApiKey';
import type { InvocationTokenClaims, InvocationTokenCodec } from './InvocationTokenCodec';
import { requireCanonicalOrigin } from './InvocationTokenCodec';

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
  createKeyId?(owner: string, deployment: GatewayDeployment): string;
  create(record: GatewayAccessKeyRecord, context?: GatewayAccessKeyRepositoryContext): Promise<GatewayAccessKeyRecord>;
  findById(id: string): Promise<GatewayAccessKeyRecord | undefined>;
  listByOwner(owner: string, context?: GatewayAccessKeyRepositoryContext): Promise<GatewayAccessKeyRecord[]>;
  revoke(id: string, revokedAt: Date, context?: GatewayAccessKeyRepositoryContext): Promise<GatewayAccessKeyRecord | undefined>;
  touchLastUsed(id: string, lastUsedAt: Date): Promise<void>;
}

export interface GatewayApiKeyAuthenticatorOptions {
  /** Persistent key storage is optional for stateless invocation-token auth. */
  repository?: GatewayAccessKeyRepository;
  deployment: GatewayDeployment;
  requiredScopes?: string[];
  invocationTokenCodec?: InvocationTokenCodec;
  invocationTokenAudience?: string;
  invocationTokenIssuer?: string;
  now?: () => Date;
  maxClockSkewMs?: number;
}

const INVALID_GATEWAY_API_KEY = 'Invalid gateway API key';
export const DEFAULT_GATEWAY_API_KEY_SCOPES = ['models:read', 'inference:write'] as const;

export class GatewayApiKeyAuthenticator implements Authenticator {
  private readonly repository?: GatewayAccessKeyRepository;
  private readonly deployment: GatewayDeployment;
  private readonly requiredScopes: string[];
  private readonly invocationTokenCodec?: InvocationTokenCodec;
  private readonly invocationTokenAudience?: string;
  private readonly invocationTokenIssuer?: string;
  private readonly now: () => Date;
  private readonly maxClockSkewMs: number;
  private readonly dummyHash: Promise<string>;

  public constructor(options: GatewayApiKeyAuthenticatorOptions) {
    this.repository = options.repository;
    this.deployment = options.deployment;
    this.requiredScopes = options.requiredScopes ?? [...DEFAULT_GATEWAY_API_KEY_SCOPES];
    this.invocationTokenCodec = options.invocationTokenCodec;
    this.invocationTokenAudience = options.invocationTokenAudience
      ? requireCanonicalOrigin(options.invocationTokenAudience, 'audience')
      : undefined;
    this.invocationTokenIssuer = options.invocationTokenIssuer
      ? requireCanonicalOrigin(options.invocationTokenIssuer, 'issuer')
      : this.invocationTokenAudience;
    this.now = options.now ?? (() => new Date());
    this.maxClockSkewMs = options.maxClockSkewMs ?? 5_000;
    if (!Number.isSafeInteger(this.maxClockSkewMs) || this.maxClockSkewMs < 0 || this.maxClockSkewMs > 30_000) {
      throw new Error('Gateway invocation token clock skew must be between 0 and 30000 milliseconds');
    }
    this.dummyHash = hashGatewayApiKeySecret('xpod-gateway-missing-key-dummy-secret');
  }

  public canAuthenticate(request: IncomingMessage): boolean {
    const bearer = this.readBearer(request);
    return Boolean(
      bearer
      && (bearer.startsWith('xpod_inv_v1.') || parseGatewayApiKey(bearer)),
    );
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    const bearer = this.readBearer(request);
    if (bearer?.startsWith('xpod_inv_v1.')) {
      return this.authenticateInvocationToken(bearer);
    }
    const parsed = bearer ? parseGatewayApiKey(bearer) : undefined;
    if (!parsed) {
      return { success: false, error: INVALID_GATEWAY_API_KEY };
    }

    // A locator-less deployment can still authenticate short-lived invocation
    // tokens. Persistent gateway keys require their backing repository and
    // must never be accepted or fabricated when it is unavailable.
    if (!this.repository) {
      return infrastructureError(new Error('Gateway API key repository is not configured'));
    }

    let record: GatewayAccessKeyRecord | undefined;
    try {
      record = await this.repository.findById(parsed.keyId);
    } catch (cause) {
      return infrastructureError(cause);
    }
    if (!record) {
      await verifyGatewayApiKeySecret(parsed.secret, await this.dummyHash);
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
    try {
      await this.repository.touchLastUsed(record.id, lastUsedAt);
    } catch (cause) {
      return infrastructureError(cause);
    }

    const context: SolidAuthContext = {
      type: 'solid',
      webId: record.owner,
      accountId: record.owner,
      viaGatewayApiKey: true,
      gatewayKeyId: record.id,
      gatewayKeyFingerprint: fingerprintGatewayBearer(bearer!),
      scopes: record.scopes,
      tokenType: 'Bearer',
    };
    return { success: true, context };
  }

  private authenticateInvocationToken(token: string): AuthResult {
    const claims = this.invocationTokenCodec?.decode(token);
    if (!claims || !this.validInvocationClaims(claims)) {
      return invalidGatewayApiKey();
    }
    const context: SolidAuthContext = {
      type: 'solid',
      webId: claims.webId,
      accountId: claims.webId,
      viaGatewayApiKey: true,
      internalInvocation: true,
      gatewayKeyId: claims.jti,
      gatewayKeyFingerprint: fingerprintGatewayBearer(token),
      scopes: claims.scopes,
      tokenType: 'Bearer',
    };
    return { success: true, context };
  }

  private validInvocationClaims(claims: InvocationTokenClaims): boolean {
    const now = this.now().getTime();
    return (
      claims.deployment === this.deployment
      && (!this.invocationTokenAudience || claims.audience === this.invocationTokenAudience)
      && (!this.invocationTokenIssuer || claims.issuer === this.invocationTokenIssuer)
      && claims.issuedAt.getTime() <= now + this.maxClockSkewMs
      && claims.expiresAt.getTime() > now
      && hasRequiredScopes(claims.scopes, this.requiredScopes)
    );
  }

  private readBearer(request: IncomingMessage): string | undefined {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return undefined;
    }
    return authorization.slice(7).trim();
  }
}

function fingerprintGatewayBearer(bearer: string): string {
  return `sha256:${createHash('sha256').update(bearer).digest('hex')}`;
}

function invalidGatewayApiKey(): AuthResult {
  return {
    success: false,
    error: INVALID_GATEWAY_API_KEY,
    category: 'invalid_credentials',
    statusCode: 401,
  };
}

function infrastructureError(cause: unknown): AuthResult {
  return {
    success: false,
    error: 'Gateway API key authentication unavailable',
    category: 'service_unavailable',
    statusCode: 503,
    cause,
  };
}

function isExpired(record: GatewayAccessKeyRecord, now: Date): boolean {
  return Boolean(record.expiresAt && record.expiresAt.getTime() <= now.getTime());
}

function hasRequiredScopes(scopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.every((scope) => scopes.includes(scope));
}
