import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { Authenticator, AuthResult } from '../../auth/Authenticator';
import type { SolidAuthContext } from '../../auth/AuthContext';
import type { GatewayDeployment, InvocationTokenClaims, InvocationTokenCodec } from './InvocationTokenCodec';
import { requireCanonicalOrigin } from './InvocationTokenCodec';

/**
 * Verifies AI-Connections invocation tokens for the model gateway.
 *
 * This used to verify two kinds of bearer: an `xpod_gw_v1.*` Gateway API Key looked up in its
 * owner's Pod, and an `xpod_inv_v1.*` invocation token. The Gateway API Key half is gone: no code
 * issues those keys any more, and a key holder was already refused Pod access. Only the invocation
 * half remains, unchanged.
 *
 * The name and the `viaGatewayApiKey` context flag it sets are kept deliberately. The flag is how
 * `GatewayPrincipal.isGatewayApiKeyPrincipal`, `AiGatewayService.isGatewayKeySolidPrincipal`,
 * `CallerPodAccess`, `AiConfigHandler` and `AiConnectionsInvocationKeyIssuer` recognise an
 * invocation principal, so renaming it here would ripple through the very path this file must keep
 * working. The `Invalid gateway API key` error text is likewise the wire behaviour invocation
 * failures already produce.
 */
export interface GatewayApiKeyAuthenticatorOptions {
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

const INVOCATION_TOKEN_PREFIX = 'xpod_inv_v1.';

export class GatewayApiKeyAuthenticator implements Authenticator {
  private readonly deployment: GatewayDeployment;
  private readonly requiredScopes: string[];
  private readonly invocationTokenCodec?: InvocationTokenCodec;
  private readonly invocationTokenAudience?: string;
  private readonly invocationTokenIssuer?: string;
  private readonly now: () => Date;
  private readonly maxClockSkewMs: number;

  public constructor(options: GatewayApiKeyAuthenticatorOptions) {
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
  }

  public canAuthenticate(request: IncomingMessage): boolean {
    return Boolean(this.readBearer(request)?.startsWith(INVOCATION_TOKEN_PREFIX));
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    const bearer = this.readBearer(request);
    if (!bearer?.startsWith(INVOCATION_TOKEN_PREFIX)) {
      return invalidGatewayApiKey();
    }
    return this.authenticateInvocationToken(bearer);
  }

  private authenticateInvocationToken(token: string): AuthResult {
    const claims = this.invocationTokenCodec?.decode(token);
    if (!claims || !this.validInvocationClaims(claims)) {
      return invalidGatewayApiKey();
    }
    const context = {
      type: 'solid',
      webId: claims.webId,
      accountId: claims.webId,
      viaGatewayApiKey: true,
      internalInvocation: true,
      gatewayKeyId: claims.jti,
      gatewayKeyFingerprint: fingerprintGatewayBearer(token),
      scopes: claims.scopes,
      tokenType: 'Bearer',
    } as SolidAuthContext & {
      viaGatewayApiKey: true;
      internalInvocation: true;
      gatewayKeyId: string;
      gatewayKeyFingerprint: string;
      scopes: string[];
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

function hasRequiredScopes(scopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.every((scope) => scopes.includes(scope));
}
