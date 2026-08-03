import type { IncomingMessage } from 'node:http';
import type { Authenticator, AuthResult } from '../../auth/Authenticator';
import type { SolidAuthContext } from '../../auth/AuthContext';
import type { GatewayDeployment, InvocationTokenClaims, InvocationTokenCodec } from './InvocationTokenCodec';
import { requireCanonicalOrigin } from './InvocationTokenCodec';

export interface InvocationTokenAuthenticatorOptions {
  codec: InvocationTokenCodec;
  deployment: GatewayDeployment;
  audience?: string;
  issuer?: string;
  now?: () => Date;
  maxClockSkewMs?: number;
}

const INVALID_INVOCATION_TOKEN = 'Invalid invocation token';
const CLIENT_CONFIG_PREFIX = '/api/ai/client-configuration/';
const CLIENT_CONFIG_CAPABILITY = '/api/ai/client-configuration/capability';
const ALLOWED_INVOCATION_SCOPES = new Set([
  'client-config:read',
  'client-config:write',
  'models:read',
  'inference:write',
]);

export class InvocationTokenAuthenticator implements Authenticator {
  private readonly codec: InvocationTokenCodec;
  private readonly deployment: GatewayDeployment;
  private readonly audience?: string;
  private readonly issuer?: string;
  private readonly now: () => Date;
  private readonly maxClockSkewMs: number;

  public constructor(options: InvocationTokenAuthenticatorOptions) {
    this.codec = options.codec;
    this.deployment = options.deployment;
    this.audience = options.audience ? requireCanonicalOrigin(options.audience, 'audience') : undefined;
    this.issuer = options.issuer ? requireCanonicalOrigin(options.issuer, 'issuer') : this.audience;
    this.now = options.now ?? (() => new Date());
    this.maxClockSkewMs = options.maxClockSkewMs ?? 5_000;
    if (!Number.isSafeInteger(this.maxClockSkewMs) || this.maxClockSkewMs < 0 || this.maxClockSkewMs > 30_000) {
      throw new Error('Invocation token clock skew must be between 0 and 30000 milliseconds');
    }
  }

  public canAuthenticate(request: IncomingMessage): boolean {
    const bearer = readBearer(request);
    return Boolean(bearer?.startsWith('xpod_inv_v1.') && requiredScope(request));
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    const bearer = readBearer(request);
    const claims = bearer?.startsWith('xpod_inv_v1.') ? this.codec.decode(bearer) : undefined;
    if (!bearer || !claims || !this.validClaims(claims, request)) {
      return invalidInvocationToken();
    }
    const context: SolidAuthContext = {
      type: 'solid',
      webId: claims.webId,
      accountId: claims.webId,
      internalInvocation: true,
      scopes: claims.scopes,
      tokenType: 'Bearer',
    };
    return { success: true, context };
  }

  private validClaims(claims: InvocationTokenClaims, request: IncomingMessage): boolean {
    const now = this.now().getTime();
    const scope = requiredScope(request);
    return (
      Boolean(scope)
      && claims.deployment === this.deployment
      && (!this.audience || claims.audience === this.audience)
      && (!this.issuer || claims.issuer === this.issuer)
      && claims.issuedAt.getTime() <= now + this.maxClockSkewMs
      && claims.expiresAt.getTime() > now
      && claims.scopes.length > 0
      && claims.scopes.every((scope) => ALLOWED_INVOCATION_SCOPES.has(scope))
      && claims.scopes.includes(scope!)
    );
  }
}

function requiredScope(request: IncomingMessage): string | undefined {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname === CLIENT_CONFIG_CAPABILITY || pathname.startsWith(CLIENT_CONFIG_PREFIX)) {
    return request.method === 'GET' ? 'client-config:read' : 'client-config:write';
  }
  if (pathname === '/v1/models') {
    return 'models:read';
  }
  if (pathname === '/v1/responses' || pathname === '/v1/messages' || pathname === '/v1/chat/completions') {
    return 'inference:write';
  }
  return undefined;
}

function readBearer(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    return undefined;
  }
  return authorization.slice(7).trim();
}

function invalidInvocationToken(): AuthResult {
  return {
    success: false,
    error: INVALID_INVOCATION_TOKEN,
    category: 'invalid_credentials',
    statusCode: 401,
  };
}
