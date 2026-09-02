import { Parser } from 'n3';
import type { RdfTextSourceInput } from '../../storage/rdf/types';

const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';

type Owner = { webId: string; podUrl: string };

export interface PodSearchIndexRebuildResult {
  scanned: number;
  indexed: number;
  skipped: number;
  failed: number;
}

export interface PodSearchIndexRebuilderOptions {
  trustedFetch: typeof fetch;
  indexTextSource?: (source: RdfTextSourceInput, text: string) => Promise<void>;
  indexVectorSource?: (source: RdfTextSourceInput, text: string) => Promise<void>;
  maxResources?: number;
  maxResourceBytes?: number;
}

export class PodSearchIndexRebuilder {
  private readonly maxResources: number;
  private readonly maxResourceBytes: number;

  public constructor(private readonly options: PodSearchIndexRebuilderOptions) {
    this.maxResources = options.maxResources ?? 10_000;
    this.maxResourceBytes = options.maxResourceBytes ?? 16 * 1024 * 1024;
  }

  public async rebuildText(owner: Owner): Promise<PodSearchIndexRebuildResult> {
    if (!this.options.indexTextSource) throw new Error('text_rebuild_unavailable');
    return this.rebuild(owner, this.options.indexTextSource);
  }

  public async rebuildVector(owner: Owner): Promise<PodSearchIndexRebuildResult> {
    if (!this.options.indexVectorSource) throw new Error('vector_rebuild_unavailable');
    return this.rebuild(owner, this.options.indexVectorSource);
  }

  private async rebuild(
    owner: Owner,
    indexSource: (source: RdfTextSourceInput, text: string) => Promise<void>,
  ): Promise<PodSearchIndexRebuildResult> {
    const root = normalizePodUrl(owner.podUrl);
    const queue = [root];
    const visited = new Set<string>();
    const result: PodSearchIndexRebuildResult = { scanned: 0, indexed: 0, skipped: 0, failed: 0 };

    while (queue.length > 0 && visited.size < this.maxResources) {
      const resource = queue.shift()!;
      if (visited.has(resource) || !resource.startsWith(root)) continue;
      visited.add(resource);
      result.scanned += 1;
      try {
        const response = await this.options.trustedFetch(resource, {
          headers: { accept: resource.endsWith('/') ? 'text/turtle' : 'text/plain, text/markdown, text/turtle, application/ld+json;q=0.8' },
        });
        if (!response.ok) {
          result.failed += 1;
          continue;
        }
        const contentLength = Number(response.headers.get('content-length') ?? 0);
        if (contentLength > this.maxResourceBytes) {
          result.skipped += 1;
          continue;
        }
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > this.maxResourceBytes) {
          result.skipped += 1;
          continue;
        }
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
        if (resource.endsWith('/')) {
          for (const child of containedResources(text, resource)) {
            if (child.startsWith(root) && !visited.has(child)) queue.push(child);
          }
          result.skipped += 1;
          continue;
        }
        if (!isTextualContentType(contentType)) {
          result.skipped += 1;
          continue;
        }
        await indexSource({
          source: resource,
          workspace: root,
          contentType,
          sourceVersion: response.headers.get('etag') ?? undefined,
        }, text);
        result.indexed += 1;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }
}

function containedResources(turtle: string, baseIRI: string): string[] {
  try {
    return new Parser({ baseIRI }).parse(turtle)
      .filter((quad) => quad.predicate.value === LDP_CONTAINS && quad.object.termType === 'NamedNode')
      .map((quad) => quad.object.value);
  } catch {
    return [];
  }
}

function normalizePodUrl(value: string): string {
  const url = new URL(value);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.hash = '';
  url.search = '';
  return url.toString();
}

function isTextualContentType(value: string): boolean {
  return value.startsWith('text/') || value === 'application/ld+json' || value === 'application/json';
}
