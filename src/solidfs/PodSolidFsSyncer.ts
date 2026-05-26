import { createReadStream } from 'node:fs';

import type { SolidFsChange, SolidFsManifest, SolidFsSyncer } from './types';
import { isRdfDocument } from '../storage/rdf/RdfContentTypes';
import { PodSolidFsHttpClient, resolvePodWorkspaceResourceUrl } from './PodSolidFsHttpClient';

export interface PodSolidFsSyncerOptions {
  fetch?: typeof fetch;
  tokenEndpoint?: string;
}

/**
 * Writes SolidFS RDF file changes back through the Pod HTTP surface.
 *
 * The CSS/MixDataAccessor path remains responsible for parsing RDF documents
 * into the structured RDF index. This adapter only bridges runtime workspace
 * edits back to the Pod resource URL with the caller's stored auth context.
 */
export class PodSolidFsSyncer implements SolidFsSyncer {
  private readonly http: PodSolidFsHttpClient;

  public constructor(options: PodSolidFsSyncerOptions = {}) {
    this.http = new PodSolidFsHttpClient(options);
  }

  public shouldTrack(input: { workspace: string }): boolean {
    try {
      const url = new URL(input.workspace);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  public async sync(change: SolidFsChange, workspace: SolidFsManifest, context?: unknown): Promise<void> {
    if (!isRdfChange(change)) {
      return;
    }

    const resourceUrl = resolvePodResourceUrl(change, workspace);
    if (!resourceUrl) {
      return;
    }

    const headers = await this.http.createAuthHeaders(context, `sync SolidFS RDF change: ${resourceUrl}`);
    if (change.type === 'deleted') {
      const response = await this.http.request(resourceUrl, {
        method: 'DELETE',
        headers,
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`SolidFS RDF delete sync failed for ${resourceUrl}: ${response.status} ${await response.text().catch(() => '')}`);
      }
      return;
    }

    headers.set('Content-Type', change.contentType ?? 'text/turtle');
    const response = await this.http.request(resourceUrl, {
      method: 'PUT',
      headers,
      body: createReadStream(change.sourcePath) as any,
      duplex: 'half' as any,
    } as RequestInit);
    if (!response.ok) {
      throw new Error(`SolidFS RDF write sync failed for ${resourceUrl}: ${response.status} ${await response.text().catch(() => '')}`);
    }
  }
}

export function resolvePodResourceUrl(change: SolidFsChange, workspace: SolidFsManifest): string | undefined {
  if (change.resource) {
    try {
      const url = new URL(change.resource);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.href;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
  return resolvePodWorkspaceResourceUrl(change.path, workspace);
}

function isRdfChange(change: SolidFsChange): boolean {
  return isRdfDocument(change.contentType, change.path);
}
