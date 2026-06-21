import { createPaddleOcrReader } from '@undefineds.co/extensions';
import type { ReadResult, ReaderOutput } from '@undefineds.co/extensions';
import type { EmbeddingService } from '../ai/service/EmbeddingService';
import type { AiCredential } from '../ai/service/types';
import type {
  CredentialResolver,
  ExtensionContext,
  ExtensionEmbedInput,
  ExtensionEmbedResult,
  ExtensionFetch,
  ExtensionReadInput,
  ExtensionRuntime,
  ResolvedCredential,
} from './types';

type ApiKeyResolvedCredential = ResolvedCredential & { apiKey: string };

interface RuntimeModelRef {
  iri: string;
  provider: string;
  model: string;
}

export interface DefaultExtensionRuntimeOptions {
  credentialResolver: CredentialResolver;
  embeddingService?: Pick<EmbeddingService, 'embedBatch'>;
  fetch?: ExtensionFetch;
}

export class DefaultExtensionRuntime implements ExtensionRuntime {
  private readonly credentialResolver: CredentialResolver;
  private readonly embeddingService?: Pick<EmbeddingService, 'embedBatch'>;
  private readonly providerFetch?: ExtensionFetch;

  public constructor(options: DefaultExtensionRuntimeOptions) {
    this.credentialResolver = options.credentialResolver;
    this.embeddingService = options.embeddingService;
    this.providerFetch = options.fetch;
  }

  public async read(context: ExtensionContext, input: ExtensionReadInput): Promise<ReadResult> {
    const model = parseModelRef(input.model);
    if (model.provider !== 'paddleocr') {
      throw new Error(`No reader extension registered for provider: ${model.provider}`);
    }

    const startedAt = Date.now();
    try {
      const credential = await this.resolveApiKeyCredential({
        service: 'ai',
        capability: 'reader',
        provider: model.provider,
        credentialId: normalizeResourceKey(input.credential),
        model: model.iri,
      }, context);

      const reader = createPaddleOcrReader({
        endpoint: credential.baseUrl,
        apiKey: credential.apiKey,
        model: model.model,
        fetch: this.providerFetch,
      });

      const result = await reader.read({
        source: input.source,
        output: normalizeReaderOutput(input.output),
        pages: input.pages,
        model: model.model,
        options: input.options,
      }, {
        signal: input.signal ?? context.signal,
      });

      context.emit?.({
        type: 'extension.completed',
        capability: 'reader',
        provider: model.provider,
        model: model.model,
        latencyMs: Date.now() - startedAt,
        usage: result.usage,
      });
      return result;
    } catch (error) {
      context.emit?.({
        type: 'extension.failed',
        capability: 'reader',
        provider: model.provider,
        model: model.model,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public async embed(context: ExtensionContext, input: ExtensionEmbedInput): Promise<ExtensionEmbedResult> {
    if (!this.embeddingService) {
      throw new Error('No embedding service registered for ExtensionRuntime');
    }

    const model = parseModelRef(input.model);
    const startedAt = Date.now();
    try {
      const credential = await this.resolveApiKeyCredential({
        service: 'ai',
        capability: 'embedding',
        provider: model.provider,
        credentialId: normalizeResourceKey(input.credential),
        model: model.iri,
      }, context);
      const vectors = await this.embeddingService.embedBatch(input.texts, toAiCredential(credential), model.model);
      context.emit?.({
        type: 'extension.completed',
        capability: 'embedding',
        provider: model.provider,
        model: model.model,
        latencyMs: Date.now() - startedAt,
      });
      return { vectors };
    } catch (error) {
      context.emit?.({
        type: 'extension.failed',
        capability: 'embedding',
        provider: model.provider,
        model: model.model,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async resolveApiKeyCredential(
    input: {
      service: string;
      capability: string;
      provider: string;
      credentialId?: string;
      model?: string;
    },
    context: ExtensionContext,
  ): Promise<ApiKeyResolvedCredential> {
    const credential = await this.credentialResolver.resolve(input, context);
    if (!hasApiKeyCredential(credential)) {
      throw new Error(`No API key credential available for provider: ${input.provider}`);
    }
    return credential;
  }
}

function hasApiKeyCredential(credential: ResolvedCredential | null): credential is ApiKeyResolvedCredential {
  return typeof credential?.apiKey === 'string' && credential.apiKey.length > 0;
}

function toAiCredential(credential: ApiKeyResolvedCredential): AiCredential {
  return {
    provider: credential.provider,
    apiKey: credential.apiKey,
    credentialId: credential.credentialId,
    baseUrl: credential.baseUrl,
    proxyUrl: credential.proxyUrl,
  };
}

function parseModelRef(model: string): RuntimeModelRef {
  const trimmed = model.trim();
  if (!trimmed) {
    throw new Error('Model URI is required');
  }

  const [withoutFragment, fragment] = trimmed.split('#');
  const provider = providerFromModelPath(withoutFragment);
  const modelId = fragment?.trim() || lastPathSegment(withoutFragment);
  if (!provider || !modelId) {
    throw new Error(`Cannot derive provider/model from model URI: ${model}`);
  }
  return {
    iri: trimmed,
    provider,
    model: decodeURIComponent(modelId),
  };
}

function providerFromModelPath(value: string): string {
  const clean = value.replace(/\/+$/u, '');
  const segments = clean.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  if (last.endsWith('.ttl')) {
    return normalizeProviderId(last.slice(0, -4));
  }
  const providerSegment = segments[segments.length - 2] ?? last;
  return normalizeProviderId(providerSegment.replace(/\.ttl$/u, ''));
}

function lastPathSegment(value: string): string {
  const clean = value.replace(/\/+$/u, '');
  return clean.split('/').filter(Boolean).pop() ?? '';
}

function normalizeProviderId(value: string): string {
  const id = decodeURIComponent(value).trim().toLowerCase();
  return id === 'paddle' ? 'paddleocr' : id;
}

function normalizeResourceKey(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed.includes('#')) return trimmed.split('#').pop() || trimmed;
  const clean = trimmed.replace(/\/+$/u, '');
  const tail = clean.split('/').filter(Boolean).pop() ?? clean;
  return tail.endsWith('.ttl') ? tail.slice(0, -4) : tail;
}

function normalizeReaderOutput(output: ExtensionReadInput['output']): ReaderOutput {
  if (output === 'text') return 'text';
  if (output === 'structured') return 'structured';
  return 'markdown';
}
