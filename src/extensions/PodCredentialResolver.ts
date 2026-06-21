import { drizzle, and, eq } from '@undefineds.co/drizzle-solid';
import { CredentialReaderImpl } from '../ai/service/CredentialReaderImpl';
import type { AiCredential } from '../ai/service/types';
import { Credential } from '../credential/schema/tables';
import { CredentialStatus } from '../credential/schema/types';
import type { CredentialResolveInput, CredentialResolver, ExtensionContext, ExtensionFetch, ResolvedCredential } from './types';

const genericCredentialSchema = {
  credential: Credential,
};

export interface CredentialReaderLike {
  getAiCredential(
    podBaseUrl: string,
    providerId: string,
    authenticatedFetch: ExtensionFetch,
    webId?: string,
    options?: { credentialId?: string },
  ): Promise<AiCredential | null>;
}

export interface PodCredentialResolverOptions {
  credentialReader?: CredentialReaderLike;
  genericCredentialReader?: GenericCredentialReaderLike;
}

export interface GenericCredentialReaderLike {
  getCredential(input: CredentialResolveInput, context: ExtensionContext): Promise<ResolvedCredential | null>;
}

export class PodCredentialResolver implements CredentialResolver {
  private readonly credentialReader: CredentialReaderLike;
  private readonly genericCredentialReader: GenericCredentialReaderLike;

  public constructor(options: PodCredentialResolverOptions = {}) {
    this.credentialReader = options.credentialReader ?? new CredentialReaderImpl();
    this.genericCredentialReader = options.genericCredentialReader ?? new PodGenericCredentialReader();
  }

  public async resolve(input: CredentialResolveInput, context: ExtensionContext): Promise<ResolvedCredential | null> {
    const service = input.service ?? 'ai';
    if (service !== 'ai') {
      return this.genericCredentialReader.getCredential({ ...input, service }, context);
    }

    const credential = await this.credentialReader.getAiCredential(
      context.podBaseUrl,
      input.provider,
      context.fetch,
      context.webId,
      { credentialId: input.credentialId },
    );
    if (!credential?.apiKey) {
      return null;
    }

    return {
      service,
      capability: input.capability,
      provider: credential.provider,
      credentialId: credential.credentialId ?? input.credentialId,
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl,
      proxyUrl: credential.proxyUrl,
    };
  }
}

export class PodGenericCredentialReader implements GenericCredentialReaderLike {
  public async getCredential(input: CredentialResolveInput, context: ExtensionContext): Promise<ResolvedCredential | null> {
    const service = input.service ?? 'ai';
    const session = {
      info: { isLoggedIn: true, webId: context.webId },
      fetch: context.fetch,
    };
    const db: any = drizzle(session, { schema: genericCredentialSchema });
    const credentials = await db.select().from(Credential).where(and(
      eq(Credential.service, service),
      eq(Credential.status, CredentialStatus.ACTIVE),
    ));
    const credential = selectGenericCredential(credentials, input.provider, input.credentialId);
    if (!credential) {
      return null;
    }

    return {
      service,
      capability: input.capability,
      provider: normalizeProviderId(credential.provider) || input.provider,
      credentialId: normalizeCredentialId(credential.id ?? credential['@id']) || input.credentialId,
      apiKey: typeof credential.apiKey === 'string' ? credential.apiKey : undefined,
      accessToken: typeof credential.oauthAccessToken === 'string' ? credential.oauthAccessToken : undefined,
      refreshToken: typeof credential.oauthRefreshToken === 'string' ? credential.oauthRefreshToken : undefined,
      expiresAt: credential.oauthExpiresAt,
      baseUrl: typeof credential.baseUrl === 'string' ? credential.baseUrl : undefined,
      proxyUrl: typeof credential.proxyUrl === 'string' ? credential.proxyUrl : undefined,
      metadata: credentialMetadata(credential),
    };
  }
}

function selectGenericCredential(credentials: any[], provider: string, credentialId?: string): any | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedCredentialId = normalizeCredentialId(credentialId);
  return [...credentials]
    .filter((credential) => {
      if (normalizedCredentialId && !matchesCredentialId(credential, normalizedCredentialId)) {
        return false;
      }
      return normalizeProviderId(credential?.provider) === normalizedProvider;
    })
    .sort(compareCredentialPriority)[0];
}

function compareCredentialPriority(left: any, right: any): number {
  const defaultDelta = Number(isTruthy(right?.isDefault)) - Number(isTruthy(left?.isDefault));
  if (defaultDelta !== 0) return defaultDelta;
  const failDelta = (left?.failCount ?? 0) - (right?.failCount ?? 0);
  if (failDelta !== 0) return failDelta;
  const usedDelta = timestamp(right?.lastUsedAt) - timestamp(left?.lastUsedAt);
  if (usedDelta !== 0) return usedDelta;
  return normalizeCredentialId(left?.id ?? left?.['@id']).localeCompare(normalizeCredentialId(right?.id ?? right?.['@id']));
}

function matchesCredentialId(credential: any, requestedId: string): boolean {
  return normalizeCredentialId(credential?.id) === requestedId
    || normalizeCredentialId(credential?.['@id']) === requestedId;
}

function normalizeProviderId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('#')) return trimmed.split('#').pop() || trimmed;
  const clean = trimmed.replace(/\/$/u, '');
  const tail = clean.split('/').filter(Boolean).pop() ?? clean;
  return tail.endsWith('.ttl') ? tail.slice(0, -4) : tail;
}

function normalizeCredentialId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('#')) return trimmed.split('#').pop() || trimmed;
  const clean = trimmed.replace(/\/$/u, '');
  return clean.split('/').filter(Boolean).pop() ?? clean;
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function credentialMetadata(credential: any): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (typeof credential.projectId === 'string' && credential.projectId) metadata.projectId = credential.projectId;
  if (typeof credential.organizationId === 'string' && credential.organizationId) metadata.organizationId = credential.organizationId;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}
