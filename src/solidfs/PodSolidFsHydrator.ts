import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { SolidFsConflictError, SolidFsNotFoundError, type SolidFsCommitHydratedInput, type SolidFsHydrateInput, type SolidFsHydrator } from './types';
import { PodSolidFsHttpClient, resolvePodWorkspaceResourceUrl } from './PodSolidFsHttpClient';

export interface PodSolidFsHydratorOptions {
  fetch?: typeof fetch;
  tokenEndpoint?: string;
}

/**
 * Hydrates object-backed Pod resources through the normal Pod HTTP boundary.
 *
 * The API runtime should not reach into CSS' storage container. GET/PUT/DELETE
 * through CSS keeps authorization, object backends, and MixData/RDF indexing in
 * one protocol path.
 */
export class PodSolidFsHydrator implements SolidFsHydrator {
  private readonly http: PodSolidFsHttpClient;

  public constructor(options: PodSolidFsHydratorOptions = {}) {
    this.http = new PodSolidFsHttpClient(options);
  }

  public async hydrate(input: SolidFsHydrateInput): Promise<{ contentType?: string; sourceVersion?: string }> {
    const resourceUrl = this.resolveResourceUrl(input.path, input.workspace);
    const headers = await this.http.createAuthHeaders(input.context, `hydrate SolidFS object: ${resourceUrl}`);
    const response = await this.http.request(resourceUrl, {
      method: 'GET',
      headers,
    });

    if (response.status === 404) {
      throw new SolidFsNotFoundError(`SolidFS object not found: ${resourceUrl}`);
    }
    if (!response.ok) {
      throw new Error(`SolidFS object hydrate failed for ${resourceUrl}: ${response.status} ${await response.text().catch(() => '')}`);
    }
    if (!response.body) {
      throw new Error(`SolidFS object hydrate failed for ${resourceUrl}: empty response body`);
    }

    await mkdir(path.dirname(input.targetPath), { recursive: true });
    await pipeline(response.body as any, createWriteStream(input.targetPath));

    return {
      contentType: response.headers.get('content-type') ?? undefined,
      sourceVersion: this.responseVersion(response),
    };
  }

  public async commit(input: SolidFsCommitHydratedInput): Promise<{ sourceVersion?: string }> {
    const resourceUrl = this.resolveChangeResourceUrl(input);
    const headers = await this.http.createAuthHeaders(input.context, `commit SolidFS object: ${resourceUrl}`);
    if (input.change.contentType) {
      headers.set('Content-Type', input.change.contentType);
    }
    if (input.change.sourceVersion) {
      headers.set('If-Match', input.change.sourceVersion);
    }

    const response = await this.http.request(resourceUrl, {
      method: 'PUT',
      headers,
      body: createReadStream(input.change.sourcePath) as any,
      duplex: 'half' as any,
    } as RequestInit);

    if (response.status === 409 || response.status === 412) {
      throw new SolidFsConflictError([{
        path: input.change.path,
        sourcePath: input.change.sourcePath,
        expectedVersion: input.change.sourceVersion,
        actualVersion: this.responseVersion(response),
        message: `Object authority changed before SolidFS commit: ${resourceUrl}`,
      }]);
    }
    if (!response.ok) {
      throw new Error(`SolidFS object commit failed for ${resourceUrl}: ${response.status} ${await response.text().catch(() => '')}`);
    }

    return {
      sourceVersion: this.responseVersion(response),
    };
  }

  public async delete(input: SolidFsCommitHydratedInput): Promise<void> {
    const resourceUrl = this.resolveChangeResourceUrl(input);
    const headers = await this.http.createAuthHeaders(input.context, `delete SolidFS object: ${resourceUrl}`);
    if (input.change.sourceVersion) {
      headers.set('If-Match', input.change.sourceVersion);
    }

    const response = await this.http.request(resourceUrl, {
      method: 'DELETE',
      headers,
    });

    if (response.status === 409 || response.status === 412) {
      throw new SolidFsConflictError([{
        path: input.change.path,
        sourcePath: input.change.sourcePath,
        expectedVersion: input.change.sourceVersion,
        actualVersion: this.responseVersion(response),
        message: `Object authority changed before SolidFS delete: ${resourceUrl}`,
      }]);
    }
    if (!response.ok && response.status !== 404) {
      throw new Error(`SolidFS object delete failed for ${resourceUrl}: ${response.status} ${await response.text().catch(() => '')}`);
    }
  }

  private resolveResourceUrl(relativePath: string, workspace: SolidFsHydrateInput['workspace']): string {
    const resourceUrl = resolvePodWorkspaceResourceUrl(relativePath, workspace);
    if (!resourceUrl) {
      throw new Error(`Cannot resolve SolidFS Pod resource URL for ${relativePath} in ${workspace.workspace}`);
    }
    return resourceUrl;
  }

  private resolveChangeResourceUrl(input: SolidFsCommitHydratedInput): string {
    if (input.change.resource) {
      try {
        const url = new URL(input.change.resource);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          return url.href;
        }
      } catch {
        // Fall through to workspace-relative resolution.
      }
    }
    return this.resolveResourceUrl(input.change.path, input.workspace);
  }

  private responseVersion(response: Response): string | undefined {
    return response.headers.get('etag') ?? response.headers.get('last-modified') ?? undefined;
  }
}
