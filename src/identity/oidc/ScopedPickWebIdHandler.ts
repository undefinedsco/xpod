import { boolean, object, string } from 'yup';
import { getLoggerFor } from 'global-logger-factory';
import {
  BadRequestHttpError,
  FoundHttpError,
  JsonInteractionHandler,
  assertAccountId,
  assertOidcInteraction,
  finishInteraction,
  forgetWebId,
  parseSchema,
  validateWithError,
} from '@solid/community-server';
import type {
  Json,
  JsonInteractionHandlerInput,
  JsonRepresentation,
  JsonView,
  ProviderFactory,
} from '@solid/community-server';
import type {
  OwnedWebIdEntry,
  PodOwnershipResolver,
  PodOwnershipTarget,
} from './PodOwnershipResolver';
import { ProvisionCodeCodec } from '../../provision/ProvisionCodeCodec';

const inSchema = object({
  webId: string().trim().required(),
  remember: boolean().default(false),
});

export interface ScopedPickWebIdHandlerOptions {
  ownershipResolver: PodOwnershipResolver;
  providerFactory: ProviderFactory;
  storageBaseUrl?: string;
  provisionBaseUrl?: string;
}

type WebIdEntry = OwnedWebIdEntry & Record<string, Json | undefined>;

/**
 * CSS-compatible WebID picker scoped to the current storage provider.
 *
 * The handler owns only the OIDC interaction flow. WebID account links and
 * Pod placement are resolved behind the injected PodOwnershipResolver so the
 * consent path does not know which database or storage implementation backs
 * CSS identity data.
 */
export class ScopedPickWebIdHandler extends JsonInteractionHandler implements JsonView {
  private readonly logger = getLoggerFor(this);
  private readonly ownershipResolver: PodOwnershipResolver;
  private readonly providerFactory: ProviderFactory;
  private readonly storageBaseUrl?: string;
  private readonly provisionBaseUrl?: string;

  public constructor(options: ScopedPickWebIdHandlerOptions) {
    super();
    this.ownershipResolver = options.ownershipResolver;
    this.providerFactory = options.providerFactory;
    this.storageBaseUrl = normalizeOptionalUrl(options.storageBaseUrl);
    this.provisionBaseUrl = normalizeOptionalUrl(options.provisionBaseUrl);
  }

  public async getView({ accountId, oidcInteraction }: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    assertAccountId(accountId);
    const provider = await this.providerFactory.getProvider();
    const description = parseSchema(inSchema);
    const target = await this.resolveTargetStorage(provider, oidcInteraction);
    const entries = await this.resolveScopedEntries(accountId, target);

    return {
      json: {
        ...description,
        webIds: entries.map((entry) => entry.webId),
        entries,
      },
    };
  }

  public async handle({ oidcInteraction, accountId, json }: JsonInteractionHandlerInput): Promise<never> {
    assertOidcInteraction(oidcInteraction);
    assertAccountId(accountId);
    const { webId, remember } = await validateWithError(inSchema, json);
    const provider = await this.providerFactory.getProvider();
    const target = await this.resolveTargetStorage(provider, oidcInteraction);
    const entries = await this.resolveScopedEntries(accountId, target);

    if (!entries.some((entry) => entry.webId === webId)) {
      this.logger.warn('Rejected an unverified WebID selection; ownership could not be established');
      throw new BadRequestHttpError('WebID does not belong to this storage provider.');
    }

    await forgetWebId(provider, oidcInteraction);
    const location = await finishInteraction(oidcInteraction, {
      login: {
        accountId: webId,
        remember,
      },
    }, true);
    throw new FoundHttpError(location);
  }

  private async resolveScopedEntries(accountId: string, target: PodOwnershipTarget): Promise<WebIdEntry[]> {
    try {
      const candidateWebIds = await this.ownershipResolver.listAccountWebIds(accountId);
      if (!Array.isArray(candidateWebIds)) {
        this.logger.warn('Pod ownership resolver returned no candidate WebIDs; refusing unverified choices');
        return [];
      }

      const entries = await this.ownershipResolver.resolveOwnedWebIds({
        accountId,
        candidateWebIds,
        target,
      });
      if (!Array.isArray(entries)) {
        this.logger.warn('Pod ownership resolver returned no owned WebIDs; refusing unverified choices');
        return [];
      }

      return entries.filter(isOwnedWebIdEntry);
    } catch {
      // Resolver implementations may wrap database or remote failures. Do
      // not expose those details (which can include credentials) to OIDC.
      this.logger.warn('Pod ownership resolver failed; refusing unverified WebIDs');
      return [];
    }
  }

  private async resolveTargetStorage(
    provider: { issuer: string },
    oidcInteraction?: JsonInteractionHandlerInput['oidcInteraction'],
  ): Promise<PodOwnershipTarget> {
    const provisionCode = extractProvisionCode(oidcInteraction);
    if (!provisionCode) {
      return { storageUrl: ensureTrailingSlash(this.storageBaseUrl ?? provider.issuer) };
    }

    const payload = new ProvisionCodeCodec(this.provisionBaseUrl ?? provider.issuer).decode(provisionCode);
    if (!payload) {
      throw new BadRequestHttpError('Invalid or expired provisionCode.');
    }

    const storageUrl = payload.spDomain
      ? `https://${payload.spDomain}`
      : payload.spUrl;
    return {
      storageUrl: ensureTrailingSlash(storageUrl),
      lookupUrl: ensureTrailingSlash(payload.spUrl),
      serviceAccessToken: payload.serviceAccessToken ?? payload.serviceToken,
    };
  }
}

function isOwnedWebIdEntry(value: OwnedWebIdEntry): value is WebIdEntry {
  return Boolean(value)
    && typeof value.webId === 'string'
    && value.webId.length > 0
    && typeof value.storageUrl === 'string'
    && value.storageUrl.length > 0
    && (value.storageMode === 'cloud' || value.storageMode === 'local' || value.storageMode === 'custom');
}

function ensureTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, '') + '/';
}

function normalizeOptionalUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  return trimmed ? trimmed : undefined;
}

function extractProvisionCode(oidcInteraction: JsonInteractionHandlerInput['oidcInteraction']): string | undefined {
  const params = oidcInteraction?.params as Record<string, unknown> | undefined;
  const value = params?.provisionCode;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
