/**
 * Deployment policy for embedding models and their endpoint.
 *
 * The ai-gateway provider catalog is the authority for which models a
 * deployment provides. A Cloud deployment must not offer arbitrary embedding
 * models — not even through a BYOK credential — and a Cloud user cannot supply an
 * endpoint: the catalog names the provider and the endpoint, the user only brings
 * an API key. A Local deployment may use any model and any endpoint the user
 * configures. This module is the single decision point so the registration,
 * configuration and runtime paths cannot drift apart.
 */

export const EMBEDDING_MODEL_NOT_ALLOWED = 'embedding_model_not_allowed';
export const EMBEDDING_ENDPOINT_NOT_PROVIDED = 'embedding_endpoint_not_provided';

const POLICY_REJECTION_CODES = new Set<string>([
  EMBEDDING_MODEL_NOT_ALLOWED,
  EMBEDDING_ENDPOINT_NOT_PROVIDED,
]);

/** Port over the ai-gateway provider catalog. */
export interface EmbeddingModelCatalog {
  /** True only for models this catalog provides as embedding models. */
  isManagedEmbeddingModel(provider: string, modelId: string): boolean;
  /** Endpoint this deployment provides for that provider, if it provides one. */
  managedEmbeddingBaseUrl(provider: string): string | undefined;
}

export interface EmbeddingModelPolicyInput {
  deployment: string;
  catalog?: EmbeddingModelCatalog;
}

export interface EmbeddingModelRequest {
  provider: string;
  model: string;
}

/** Endpoint inputs a Pod may carry. A Cloud deployment ignores the Pod values. */
export interface EmbeddingEndpointRequest {
  provider: string;
  baseUrl?: string;
  proxyUrl?: string;
}

export interface EmbeddingEndpoint {
  baseUrl?: string;
  proxyUrl?: string;
  /** Whether the endpoint came from the deployment catalog or from the Pod. */
  source: 'catalog' | 'pod';
}

export class EmbeddingPolicyError extends Error {
  public readonly code: string;

  protected constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

export class EmbeddingModelNotAllowedError extends EmbeddingPolicyError {
  public constructor(provider: string, model: string) {
    super(
      EMBEDDING_MODEL_NOT_ALLOWED,
      `Embedding model "${model}" is not provided for provider "${provider}" in this deployment`,
    );
  }
}

export class EmbeddingEndpointNotProvidedError extends EmbeddingPolicyError {
  public constructor(provider: string) {
    super(
      EMBEDDING_ENDPOINT_NOT_PROVIDED,
      `No embedding endpoint is provided for provider "${provider}" in this deployment`,
    );
  }
}

export class EmbeddingModelPolicy {
  private readonly catalog?: EmbeddingModelCatalog;

  private constructor(catalog?: EmbeddingModelCatalog) {
    this.catalog = catalog;
  }

  /** Local deployments (and runtimes without a catalog) keep arbitrary BYOK models. */
  public static allowAll(): EmbeddingModelPolicy {
    return new EmbeddingModelPolicy(undefined);
  }

  public static fromCatalog(catalog: EmbeddingModelCatalog): EmbeddingModelPolicy {
    return new EmbeddingModelPolicy(catalog);
  }

  public isEnforced(): boolean {
    return this.catalog !== undefined;
  }

  public isAllowed(input: EmbeddingModelRequest): boolean {
    if (!this.catalog) {
      return true;
    }
    const provider = input.provider.trim();
    const model = input.model.trim();
    if (!provider || !model) {
      return false;
    }
    return this.catalog.isManagedEmbeddingModel(provider, model);
  }

  public assertAllowed(input: EmbeddingModelRequest): void {
    if (!this.isAllowed(input)) {
      throw new EmbeddingModelNotAllowedError(input.provider, input.model);
    }
  }

  /**
   * Resolve the endpoint an embedding call may use.
   *
   * Local (and catalog-less runtimes) keep whatever the Pod carries. A Cloud
   * deployment replaces the Pod endpoint with the one its catalog provides and
   * drops any Pod proxy, so a BYOK key can never redirect Cloud egress.
   */
  public resolveEndpoint(input: EmbeddingEndpointRequest): EmbeddingEndpoint {
    if (!this.catalog) {
      return { baseUrl: input.baseUrl, proxyUrl: input.proxyUrl, source: 'pod' };
    }
    const baseUrl = this.catalog.managedEmbeddingBaseUrl(input.provider);
    if (!baseUrl) {
      throw new EmbeddingEndpointNotProvidedError(input.provider);
    }
    return { baseUrl, proxyUrl: undefined, source: 'catalog' };
  }
}

export function createEmbeddingModelPolicy(input: EmbeddingModelPolicyInput): EmbeddingModelPolicy {
  if (input.deployment !== 'cloud' || !input.catalog) {
    return EmbeddingModelPolicy.allowAll();
  }
  return EmbeddingModelPolicy.fromCatalog(input.catalog);
}

/** True for every deployment rejection, so callers never retry a policy decision. */
export function isEmbeddingPolicyRejection(error: unknown): boolean {
  if (error instanceof EmbeddingPolicyError) {
    return true;
  }
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && POLICY_REJECTION_CODES.has(code);
}

export function isEmbeddingModelNotAllowedError(error: unknown): boolean {
  if (error instanceof EmbeddingModelNotAllowedError) {
    return true;
  }
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === EMBEDDING_MODEL_NOT_ALLOWED;
}

/**
 * Parse an AI Config model assignment (`settings/providers/<provider>.ttl#<model>`
 * or its absolute form) into the provider/model pair the policy checks. A ref
 * that does not name both cannot be proven to be provided, so it resolves to
 * `undefined` and an enforcing policy rejects it.
 */
export function parseEmbeddingModelRef(ref: string): EmbeddingModelRequest | undefined {
  const trimmed = ref.trim();
  const hashIndex = trimmed.lastIndexOf('#');
  if (hashIndex < 0) {
    return undefined;
  }
  const provider = /(?:^|\/)settings\/providers\/([^/]+)\.ttl$/u.exec(trimmed.slice(0, hashIndex))?.[1];
  const model = trimmed.slice(hashIndex + 1).trim();
  if (!provider || !model) {
    return undefined;
  }
  return { provider: decodeURIComponent(provider), model: decodeURIComponent(model) };
}
