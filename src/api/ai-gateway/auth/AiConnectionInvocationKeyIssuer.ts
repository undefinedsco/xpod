import type { AuthContext, SolidAuthContext } from '../../auth/AuthContext';
import type { StoreContext } from '../../chatkit/store';
import type { AIConnectionInvocationConfig } from '../../../agents/types';
import { createGatewayApiKey, type GatewayDeployment } from './GatewayApiKey';
import {
  DEFAULT_GATEWAY_API_KEY_SCOPES,
  type GatewayAccessKeyRepository,
} from './GatewayApiKeyAuthenticator';

const DEFAULT_INVOCATION_KEY_TTL_MS = 5 * 60_000;
const MAX_INVOCATION_KEY_TTL_MS = 15 * 60_000;

export interface AiConnectionInvocationKeyIssuerOptions {
  repository: GatewayAccessKeyRepository;
  deployment: GatewayDeployment;
  baseUrl: string;
  ttlMs?: number;
  now?: () => Date;
}

/**
 * Produces a short-lived Gateway key at the trusted execution boundary.
 * Only its hash record is durable; plaintext exists solely in the returned
 * invocation context.
 */
export class AiConnectionInvocationKeyIssuer {
  private readonly repository: GatewayAccessKeyRepository;
  private readonly deployment: GatewayDeployment;
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  public constructor(options: AiConnectionInvocationKeyIssuerOptions) {
    this.repository = options.repository;
    this.deployment = options.deployment;
    this.baseUrl = requireBaseUrl(options.baseUrl);
    this.ttlMs = normalizeTtl(options.ttlMs);
    this.now = options.now ?? (() => new Date());
  }

  public async issue(context: StoreContext): Promise<AIConnectionInvocationConfig> {
    const auth = requireTrustedSolidAuth(context.auth as AuthContext | undefined);
    const createdAt = this.now();
    const issued = await createGatewayApiKey({
      deployment: this.deployment,
      keyId: this.repository.createKeyId?.(auth.webId, this.deployment),
    });
    await this.repository.create({
      ...issued.record,
      owner: auth.webId,
      scopes: [...DEFAULT_GATEWAY_API_KEY_SCOPES],
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.ttlMs),
      name: 'Agent Runtime invocation',
    }, { auth });

    return {
      baseUrl: this.baseUrl,
      gatewayKey: issued.plaintext,
    };
  }
}

function requireTrustedSolidAuth(auth: AuthContext | undefined): SolidAuthContext {
  if (
    auth?.type !== 'solid'
    || typeof auth.webId !== 'string'
    || auth.webId.trim().length === 0
    || auth.viaGatewayApiKey === true
  ) {
    throw new Error('AI Connection invocation key requires an authenticated Solid WebID');
  }
  return auth;
}

function requireBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, '');
  if (!normalized) {
    throw new Error('AI Connection invocation baseUrl is required');
  }
  return normalized;
}

function normalizeTtl(value: number | undefined): number {
  const ttlMs = value ?? DEFAULT_INVOCATION_KEY_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_INVOCATION_KEY_TTL_MS) {
    throw new Error(`AI Connection invocation key TTL must be between 1 and ${MAX_INVOCATION_KEY_TTL_MS} milliseconds`);
  }
  return ttlMs;
}
