import type { RepresentationPreferences, ResourceStore } from '@solid/community-server';
import type { AiCredential } from '../ai/service/types';
import type { EmbeddingService } from '../ai/service/EmbeddingService';
import type { SparqlEngine } from './sparql/SubgraphQueryEngine';
import { UDFS, normalizeAIConfigProviderId } from '@undefineds.co/models';
import type { ResourceChangeEvent, ResourceChangeListener } from './ObservableResourceStore';
import { chunkRdfTextSource } from './rdf/RdfTextIndex';
import type {
  RdfTextSourceInput,
  RdfVectorChunkInput,
  RdfVectorSourceInput,
} from './rdf/types';

export interface RdfDerivedIndexEngine {
  indexTextSource(source: RdfTextSourceInput, text: string): Promise<void>;
  deleteTextSource(source: string): Promise<number>;
  indexVectorSource(source: RdfVectorSourceInput, chunks: RdfVectorChunkInput[]): Promise<void>;
  deleteVectorSource(source: string): Promise<number>;
}

export interface RdfDerivedIndexingListenerOptions {
  rdfEngine?: RdfDerivedIndexEngine;
  resourceStore?: ResourceStore;
  embeddingService?: EmbeddingService;
  sparqlEngine?: SparqlEngine;
  resolveCredential?: (podScope: string) => Promise<AiCredential | null>;
  defaultModel?: string;
  supportedExtensions?: string[];
}

/** Rebuilds the canonical PostgreSQL text/vector derivations consumed by native RDF queries. */
export class RdfDerivedIndexingListener implements ResourceChangeListener {
  public readonly consumerId: string;
  private readonly options: RdfDerivedIndexingListenerOptions & {
    rdfEngine: RdfDerivedIndexEngine;
    resourceStore: ResourceStore;
  };
  private readonly supportedExtensions: Set<string>;
  private readonly defaultModel: string;

  public constructor(
    rdfEngine: RdfDerivedIndexEngine,
    resourceStore: ResourceStore,
    embeddingService?: EmbeddingService,
    sparqlEngine?: SparqlEngine,
    resolveCredential?: (podScope: string) => Promise<AiCredential | null>,
    defaultModel = 'text-embedding-004',
    supportedExtensions: string[] = ['.txt', '.md', '.html', '.json', '.ttl', '.jsonld'],
    consumerId = 'rdf-fts-vec-v1',
  ) {
    this.options = { rdfEngine, resourceStore, embeddingService, sparqlEngine, resolveCredential, defaultModel };
    this.defaultModel = defaultModel;
    this.supportedExtensions = new Set(supportedExtensions);
    this.consumerId = consumerId;
  }

  public async onResourceChanged(event: ResourceChangeEvent): Promise<void> {
    if (event.isContainer || !this.supportedExtensions.has(extension(event.path))) {
      return;
    }
    if (event.action === 'delete') {
      await this.options.rdfEngine.deleteTextSource(event.path);
      await this.options.rdfEngine.deleteVectorSource(event.path);
      return;
    }

    const { text, contentType } = await this.readAuthority(event.path);
    const workspace = podScope(event.path);
    const source: RdfTextSourceInput = {
      source: event.path,
      workspace,
      localPath: localPath(event.path, workspace),
      contentType,
    };
    await this.options.rdfEngine.indexTextSource(source, text);

    if (!this.options.embeddingService || (!this.options.resolveCredential && !this.options.sparqlEngine)) {
      return;
    }
    const credential = await this.resolveCredential(workspace);
    if (!credential) {
      return;
    }
    const textChunks = chunkRdfTextSource(source, text);
    if (textChunks.length === 0) {
      await this.options.rdfEngine.deleteVectorSource(event.path);
      return;
    }
    const embeddings = await this.options.embeddingService.embedBatch(
      textChunks.map((chunk) => chunk.content),
      credential,
      this.defaultModel,
    );
    if (embeddings.length !== textChunks.length) {
      throw new Error(`Embedding count mismatch for ${event.path}`);
    }
    await this.options.rdfEngine.indexVectorSource(source, textChunks.map((chunk, index) => ({
      chunkKey: chunk.chunkKey,
      ordinal: chunk.ordinal,
      level: 0,
      embedding: embeddings[index]!,
      provider: credential.provider,
      model: this.defaultModel,
      inputKind: 'resource',
      content: chunk.content,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      ...(chunk.heading ? { heading: chunk.heading } : {}),
      ...(chunk.path ? { path: chunk.path } : {}),
    })));
  }

  private async readAuthority(path: string): Promise<{ text: string; contentType?: string }> {
    const preferences: RepresentationPreferences = {
      type: { 'text/plain': 1, 'text/markdown': 0.9, 'text/turtle': 0.8, '*/*': 0.1 },
    };
    const representation = await this.options.resourceStore.getRepresentation({ path }, preferences);
    const chunks: Buffer[] = [];
    for await (const chunk of representation.data) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const contentType = representation.metadata.contentType;
    return { text: Buffer.concat(chunks).toString('utf8'), ...(contentType ? { contentType } : {}) };
  }

  private async resolveCredential(workspace: string): Promise<AiCredential | null> {
    if (this.options.resolveCredential) {
      return this.options.resolveCredential(workspace);
    }
    const bindings = await this.options.sparqlEngine!.queryBindings(`
      PREFIX cred: <${UDFS.NAMESPACE}>
      PREFIX ai: <${UDFS.NAMESPACE}>
      SELECT ?apiKey ?baseUrl ?provider ?proxyUrl WHERE {
        ?credential a cred:Credential ;
          cred:service "ai" ;
          cred:status "active" ;
          cred:apiKey ?apiKey .
        OPTIONAL { ?credential cred:provider ?provider }
        OPTIONAL { ?credential cred:provider ?provider . ?provider ai:baseUrl ?baseUrl }
        OPTIONAL { ?credential cred:provider ?provider . ?provider ai:proxyUrl ?proxyUrl }
      } LIMIT 1
    `, workspace);
    for await (const binding of bindings) {
      const apiKey = binding.get('apiKey');
      if (!apiKey) continue;
      const provider = binding.get('provider');
      const baseUrl = binding.get('baseUrl');
      const proxyUrl = binding.get('proxyUrl');
      return {
        apiKey: apiKey.value,
        provider: normalizeAIConfigProviderId(provider?.value ?? 'google') || 'google',
        ...(baseUrl ? { baseUrl: baseUrl.value } : {}),
        ...(proxyUrl ? { proxyUrl: proxyUrl.value } : {}),
      };
    }
    return null;
  }
}

function extension(path: string): string {
  const pathname = safeUrl(path)?.pathname ?? path;
  const dot = pathname.lastIndexOf('.');
  return dot < 0 ? '' : pathname.slice(dot).toLowerCase();
}

function podScope(path: string): string {
  const url = safeUrl(path);
  if (url) {
    const segment = url.pathname.split('/').filter(Boolean)[0];
    return segment ? `${url.origin}/${segment}/` : `${url.origin}/`;
  }
  const segment = path.split('/').filter(Boolean)[0];
  return segment ? `/${segment}/` : '/';
}

function localPath(path: string, workspace: string): string | undefined {
  return path.startsWith(workspace) ? path.slice(workspace.length) : undefined;
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
