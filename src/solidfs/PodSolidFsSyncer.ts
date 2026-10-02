import { readFile } from 'node:fs/promises';

import type { SolidFsChange, SolidFsManifest, SolidFsSyncer } from './types';
import { isRdfDocument } from '../storage/rdf/RdfContentTypes';
import { PodSolidFsHttpClient, resolvePodWorkspaceResourceUrl } from './PodSolidFsHttpClient';

export interface PodSolidFsSyncerOptions {
  fetch?: typeof fetch;
  tokenEndpoint?: string;
}

/**
 * Writes SolidFS file changes back through the Pod HTTP surface.
 *
 * RDF documents still flow through the CSS/MixDataAccessor path, which parses
 * them into the structured RDF index. Non-RDF (text/binary) workspace edits are
 * sent as byte-buffered payloads to the same Pod resource URL with the caller's
 * stored auth context; otherwise the journal would mark an upload done while the
 * Pod never received the bytes and the resource stayed missing. (A Node
 * ReadStream body is rejected with an empty HTTP 400 at this boundary, so the
 * file bytes are buffered before the PUT.)
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
    const resourceUrl = resolvePodResourceUrl(change, workspace);
    if (!resourceUrl) {
      return;
    }

    const headers = await this.http.createAuthHeaders(context, `sync SolidFS change: ${resourceUrl}`);
    if (change.type === 'deleted') {
      const response = await this.http.request(resourceUrl, {
        method: 'DELETE',
        headers,
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`SolidFS delete sync failed for ${resourceUrl}: ${response.status} ${await response.text().catch(() => '')}`);
      }
      return;
    }

    const isRdf = isRdfChange(change);
    headers.set('Content-Type', change.contentType ?? (isRdf ? 'text/turtle' : 'application/octet-stream'));
    // The Pod HTTP boundary rejects a Node ReadStream body with an empty 400, which the
    // journal then records as failed and the resource never lands. Send the file bytes.
    const body = await readFile(change.sourcePath);
    const response = await this.http.request(resourceUrl, {
      method: 'PUT',
      headers,
      body,
    } as RequestInit);
    if (!response.ok) {
      throw new Error(`SolidFS write sync failed for ${resourceUrl}: ${response.status} ${await response.text().catch(() => '')}`);
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
