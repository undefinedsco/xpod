import type { ReadResult } from '@undefineds.co/extensions';

export type ExtensionFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ExtensionCapability = 'chat' | 'embedding' | 'reader' | string;
export type ModelUri = string;
export type CredentialUri = string;
export type SourceUri = string;

export interface ExtensionEvent {
  type: 'extension.completed' | 'extension.failed';
  capability: ExtensionCapability;
  provider?: string;
  model?: string;
  latencyMs?: number;
  usage?: Record<string, unknown>;
  error?: string;
}

export interface ExtensionContext {
  webId: string;
  podBaseUrl: string;
  fetch: ExtensionFetch;
  signal?: AbortSignal;
  emit?: (event: ExtensionEvent) => void;
}

export interface CredentialResolveInput {
  provider: string;
  credentialId?: string;
  service?: string;
  capability?: string;
  /** Durable model resource URI/IRI that selected this provider. */
  model?: ModelUri;
}

export interface ResolvedCredential {
  provider: string;
  credentialId?: string;
  service?: string;
  capability?: string;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string | Date;
  baseUrl?: string;
  proxyUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface CredentialResolver {
  resolve(input: CredentialResolveInput, context: ExtensionContext): Promise<ResolvedCredential | null>;
}

export interface ExtensionReadInput {
  /** Durable Model URI/IRI. Provider and provider-native model id are derived from this. */
  model: ModelUri;
  /** Optional durable Credential URI/IRI. If omitted, resolver chooses provider default. */
  credential?: CredentialUri;
  /** Source URI. Metadata is resolved by source/host layers, not supplied as the primary API. */
  source: SourceUri;
  output?: 'text' | 'markdown' | 'structured';
  pages?: string;
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ExtensionEmbedInput {
  /** Durable Model URI/IRI. Provider and provider-native model id are derived from this. */
  model: ModelUri;
  /** Optional durable Credential URI/IRI. If omitted, resolver chooses provider default. */
  credential?: CredentialUri;
  texts: string[];
}

export interface ExtensionEmbedResult {
  vectors: number[][];
  usage?: Record<string, unknown>;
}

export interface ExtensionRuntime {
  read(context: ExtensionContext, input: ExtensionReadInput): Promise<ReadResult>;
  embed(context: ExtensionContext, input: ExtensionEmbedInput): Promise<ExtensionEmbedResult>;
}
