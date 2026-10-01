/**
 * PodHttpLowerFileSystem - dependency-free model of the operations an AgentFS
 * Pod lower filesystem must perform over the existing authenticated Pod HTTP
 * surface.
 *
 * It is deliberately transport-level (not a simulated mount): a native helper
 * would call the same HTTP operations. Key contracts:
 * - Directory enumeration is metadata only and never fetches file bodies.
 * - Reads use HTTP Range and only transfer the requested slice when the server
 *   supports it; a 200 response is sliced but reported as `rangeIgnored`.
 * - Writes are conditional: create uses `If-None-Match: *`, overwrite/delete use
 *   `If-Match: <version>`; 412 becomes a conflict, never an unconditional write.
 * - No persistent body cache: only version tokens are memoized, and they can be
 *   invalidated on external change. Dirty/pending local operations are kept
 *   until they are explicitly committed or discarded.
 * - The Pod remains the content authority; SQLite delta (here: pending ops) is
 *   only client-side state waiting to be written back.
 */

import type { AgentDirectoryClient } from '../../agent-directory/client/AgentDirectoryClient';
import type { AgentDirectoryEntry } from '../../agent-directory/protocol';
import type { AgentDirectoryRequest } from '../../agent-directory/client/AgentDirectoryClient';

export class PodLowerHttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PodLowerHttpError';
  }
}

export class PodLowerConflictError extends PodLowerHttpError {
  public constructor(message = 'Pod resource version conflict') {
    super(412, message);
    this.name = 'PodLowerConflictError';
  }
}

export class PodLowerNotFoundError extends PodLowerHttpError {
  public constructor(message = 'Pod resource not found') {
    super(404, message);
    this.name = 'PodLowerNotFoundError';
  }
}

export interface PodLowerStat {
  path: string;
  type: 'file' | 'container';
  size?: number;
  contentType?: string;
  /** Native version token (ETag), when the server exposes one. */
  version?: string;
  lastModified?: string;
}

export interface PodLowerReadResult {
  data: Buffer;
  /** True when the server ignored Range and returned the whole body. */
  rangeIgnored: boolean;
}

export interface PodLowerTransferStats {
  requestCount: number;
  readRequests: number;
  bodiesReadBytes: number;
  writeRequests: number;
  bytesWritten: number;
}

export type PendingOperation =
  | { id: string; op: 'write'; path: string; contentType?: string; dataBase64: string; baseVersion?: string; create: boolean }
  | { id: string; op: 'delete'; path: string; baseVersion?: string };

export interface PodLowerOptions {
  /** Pod container URL (must end with '/'). */
  baseUrl: string;
  /** Authenticated request function (CLI authFetch or equivalent). */
  request: AgentDirectoryRequest;
  /** Directory/search client used for metadata-only enumeration. */
  client: AgentDirectoryClient;
}

function normalizeRelativePath(input: string): string {
  const trimmed = input.replace(/^\/+/, '');
  if (trimmed.length === 0) {
    return '';
  }
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`Invalid Pod relative path: ${input}`);
  }
  return segments.join('/');
}

function encodeRelativePath(relative: string): string {
  if (relative.length === 0) {
    return '';
  }
  return relative.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function inferContentType(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'text/plain';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.ttl')) return 'text/turtle';
  if (lower.endsWith('.jsonld')) return 'application/ld+json';
  return 'application/octet-stream';
}

export class PodHttpLowerFileSystem {
  private readonly baseUrl: string;
  private readonly request: AgentDirectoryRequest;
  private readonly client: AgentDirectoryClient;
  private readonly versionCache = new Map<string, string | undefined>();
  private readonly pending = new Map<string, PendingOperation>();
  private stats: PodLowerTransferStats = {
    requestCount: 0,
    readRequests: 0,
    bodiesReadBytes: 0,
    writeRequests: 0,
    bytesWritten: 0,
  };

  public constructor(options: PodLowerOptions) {
    this.baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
    this.request = options.request;
    this.client = options.client;
  }

  public resourceUrl(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    return new URL(encodeRelativePath(normalized), this.baseUrl).href;
  }

  /** Metadata-only listing. Never fetches file bodies. */
  public async readdir(relativePath: string): Promise<PodLowerStat[]> {
    const normalized = normalizeRelativePath(relativePath);
    const prefix = normalized.length === 0 ? '' : `${normalized}/`;
    const listing = await this.client.listAll({ root: this.baseUrl, ...(prefix ? { pathPrefix: prefix } : {}) });

    const children = new Map<string, AgentDirectoryEntry>();
    for (const entry of listing.entries) {
      const remainder = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path;
      const segments = remainder.split('/').filter((segment) => segment.length > 0);
      if (segments.length !== 1) {
        continue;
      }
      const name = entry.type === 'container' ? `${segments[0]}/` : segments[0];
      children.set(name, entry);
    }

    // Merge the client-side delta into the view. The Pod stays authoritative:
    // this only changes what the workspace view reports, not the server.
    for (const operation of this.pending.values()) {
      const remainder = operation.path.startsWith(prefix) ? operation.path.slice(prefix.length) : operation.path;
      const segments = remainder.split('/').filter((segment) => segment.length > 0);
      if (segments.length !== 1) {
        continue;
      }
      if (operation.op === 'delete') {
        children.delete(operation.path);
      } else if (operation.op === 'write' && operation.create) {
        children.set(operation.path, {
          path: operation.path,
          url: this.resourceUrl(operation.path),
          type: 'file',
          size: Buffer.from(operation.dataBase64, 'base64').length,
          ...(operation.contentType ? { contentType: operation.contentType } : {}),
        });
      }
    }

    return [ ...children.values() ].map((entry) => this.toStat(entry)).sort((left, right) =>
      (left.path < right.path ? -1 : 1));
  }

  /**
   * Overlay view of the directory that includes the client-side delta. This is
   * deliberately separate from `readdir`: `readdir` is the transport view of
   * the Pod, while callers that render the working workspace use the overlay.
   */
  public async overlayReaddir(relativePath: string): Promise<PodLowerStat[]> {
    const normalized = normalizeRelativePath(relativePath);
    const prefix = normalized.length === 0 ? '' : `${normalized}/`;
    const entries = new Map((await this.readdir(relativePath)).map((entry) => [ entry.path, entry ]));
    for (const operation of this.pending.values()) {
      const remainder = operation.path.startsWith(prefix) ? operation.path.slice(prefix.length) : operation.path;
      const segments = remainder.split('/').filter((segment) => segment.length > 0);
      if (segments.length !== 1) {
        continue;
      }
      if (operation.op === 'delete') {
        entries.delete(operation.path);
      } else if (operation.op === 'write' && operation.create) {
        entries.set(operation.path, {
          path: operation.path,
          type: 'file',
          size: Buffer.from(operation.dataBase64, 'base64').length,
          ...(operation.contentType ? { contentType: operation.contentType } : {}),
          ...(operation.baseVersion ? { version: operation.baseVersion } : {}),
        });
      }
    }
    return [ ...entries.values() ].sort((left, right) => (left.path < right.path ? -1 : 1));
  }

  /** HEAD-style metadata lookup. Does not read the body. */
  public async stat(relativePath: string): Promise<PodLowerStat | undefined> {
    const normalized = normalizeRelativePath(relativePath);
    const url = this.resourceUrl(normalized);
    const response = await this.send(url, { method: 'HEAD' });
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new PodLowerHttpError(response.status, `HEAD ${url} failed: ${response.status}`);
    }
    const stats: PodLowerStat = {
      path: normalized,
      type: 'file',
      ...(response.headers.get('content-length') ? { size: Number(response.headers.get('content-length')) } : {}),
      ...(response.headers.get('content-type') ? { contentType: response.headers.get('content-type') as string } : {}),
      ...(response.headers.get('etag') ? { version: response.headers.get('etag') as string } : {}),
      ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified') as string } : {}),
    };
    this.versionCache.set(normalized, stats.version);
    return stats;
  }

  /** Reads only the requested byte slice, using HTTP Range. */
  public async read(relativePath: string, offset = 0, length?: number): Promise<PodLowerReadResult> {
    const normalized = normalizeRelativePath(relativePath);
    const url = this.resourceUrl(normalized);
    const headers: Record<string, string> = {};
    if (offset > 0 || length !== undefined) {
      const end = length === undefined ? '' : offset + length - 1;
      headers.Range = `bytes=${offset}-${end}`;
    }
    const response = await this.send(url, { method: 'GET', headers }, true);
    if (response.status === 404) {
      throw new PodLowerNotFoundError(`GET ${url} not found`);
    }
    if (response.status === 416) {
      // Only a read at/after the resource total is a normal EOF; a 416 that
      // claims the requested offset is inside the resource is a real error.
      const total = /bytes\s+\*\/(\d+)/.exec(response.headers.get('content-range') ?? '');
      const totalSize = total ? Number(total[1]) : undefined;
      if (totalSize !== undefined && offset >= totalSize) {
        return { data: Buffer.alloc(0), rangeIgnored: false };
      }
      throw new PodLowerHttpError(416, `range not satisfiable for ${normalized} at offset ${offset}`);
    }
    if (!response.ok) {
      throw new PodLowerHttpError(response.status, `GET ${url} failed: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (response.status === 206) {
      const contentRange = response.headers.get('content-range') ?? '';
      const match = /^bytes\s+(\d+)-/.exec(contentRange);
      if (!match || Number(match[1]) !== offset) {
        throw new PodLowerHttpError(
          502,
          `Range response for ${normalized} did not start at the requested offset (${offset}): ${contentRange}`,
        );
      }
    }
    const rangeIgnored = response.status === 200 && Object.keys(headers).length > 0;
    const slice = rangeIgnored ? buffer.subarray(offset, length === undefined ? undefined : offset + length) : buffer;
    return { data: Buffer.from(slice), rangeIgnored };
  }

  /** Conditional create: fails with a conflict when the target already exists. */
  public async create(relativePath: string, data: Buffer, contentType?: string): Promise<PodLowerStat> {
    const normalized = normalizeRelativePath(relativePath);
    const url = this.resourceUrl(normalized);
    const response = await this.send(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType ?? inferContentType(normalized),
        'If-None-Match': '*',
      },
      body: data,
    }, true, data.length);
    if (response.status === 412 || response.status === 409) {
      throw new PodLowerConflictError(`Create conflict for ${normalized}`);
    }
    if (!response.ok) {
      throw new PodLowerHttpError(response.status, `PUT ${url} failed: ${response.status}`);
    }
    this.invalidate(normalized);
    const version = response.headers.get('etag') ?? undefined;
    this.versionCache.set(normalized, version);
    return { path: normalized, type: 'file', size: data.length, ...(contentType ? { contentType } : {}), ...(version ? { version } : {}) };
  }

  /** Conditional overwrite: requires the caller's version baseline. */
  public async write(relativePath: string, data: Buffer, baseVersion: string, contentType?: string): Promise<PodLowerStat> {
    const normalized = normalizeRelativePath(relativePath);
    const url = this.resourceUrl(normalized);
    const response = await this.send(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType ?? inferContentType(normalized),
        'If-Match': baseVersion,
      },
      body: data,
    }, true, data.length);
    if (response.status === 412) {
      throw new PodLowerConflictError(`Stale version for ${normalized}`);
    }
    if (!response.ok) {
      throw new PodLowerHttpError(response.status, `PUT ${url} failed: ${response.status}`);
    }
    this.invalidate(normalized);
    const version = response.headers.get('etag') ?? undefined;
    this.versionCache.set(normalized, version);
    return { path: normalized, type: 'file', size: data.length, ...(contentType ? { contentType } : {}), ...(version ? { version } : {}) };
  }

  /**
   * Conditional delete. A delete without a version baseline would be an
   * unconditional write, so it is refused instead of sent.
   */
  public async remove(relativePath: string, baseVersion?: string): Promise<void> {
    const normalized = normalizeRelativePath(relativePath);
    if (!baseVersion) {
      throw new PodLowerConflictError(`refusing unconditional delete of ${normalized}: no version baseline`);
    }
    const url = this.resourceUrl(normalized);
    const headers: Record<string, string> = { 'If-Match': baseVersion };
    const response = await this.send(url, { method: 'DELETE', headers }, true);
    if (response.status === 412) {
      throw new PodLowerConflictError(`Stale version for ${normalized}`);
    }
    if (response.status === 404) {
      throw new PodLowerNotFoundError(`DELETE ${url} not found`);
    }
    if (!response.ok) {
      throw new PodLowerHttpError(response.status, `DELETE ${url} failed: ${response.status}`);
    }
    this.invalidate(normalized);
  }

  /**
   * Pod HTTP has no atomic rename. The prototype performs a conditional
   * create-then-conditional-delete and explicitly documents the non-atomic
   * window; it never falls back to an unconditional overwrite.
   */
  public async rename(from: string, to: string, baseVersion?: string): Promise<void> {
    const source = normalizeRelativePath(from);
    const target = normalizeRelativePath(to);
    const sourceStat = await this.stat(source);
    if (!sourceStat) {
      throw new PodLowerNotFoundError(`rename source ${source} not found`);
    }
    const content = await this.read(source);
    // Editor atomic-save replaces an existing target: overwrite it conditionally
    // when it exists, otherwise create it. Never an unconditional overwrite.
    const targetStat = await this.stat(target);
    if (targetStat) {
      if (!targetStat.version) {
        throw new PodLowerConflictError(`refusing unconditional overwrite of ${target}: no ETag`);
      }
      await this.write(target, content.data, targetStat.version, sourceStat.contentType);
    } else {
      await this.create(target, content.data, sourceStat.contentType);
    }
    await this.remove(source, baseVersion ?? sourceStat.version);
    this.invalidate(target);
  }

  /** Pending (dirty) operations are not evicted by cache management. */
  public enqueue(operation: PendingOperation): void {
    this.pending.set(operation.id, operation);
  }

  public listPending(): PendingOperation[] {
    return [ ...this.pending.values() ];
  }

  /** Applies pending operations to the Pod; failures keep the op for retry. */
  public async commit(): Promise<{ applied: number; conflicts: string[] }> {
    let applied = 0;
    const conflicts: string[] = [];
    for (const operation of [ ...this.pending.values() ]) {
      try {
        if (operation.op === 'write') {
          const data = Buffer.from(operation.dataBase64, 'base64');
          if (operation.create || operation.baseVersion === undefined) {
            await this.create(operation.path, data, operation.contentType);
          } else {
            await this.write(operation.path, data, operation.baseVersion, operation.contentType);
          }
        } else {
          await this.remove(operation.path, operation.baseVersion);
        }
        this.pending.delete(operation.id);
        applied += 1;
      } catch (error) {
        if (error instanceof PodLowerConflictError) {
          conflicts.push(operation.path);
          continue;
        }
        throw error;
      }
    }
    return { applied, conflicts };
  }

  /**
   * Drops a cached version token so the next access revalidates against the
   * Pod. No body is cached, so an external modification can never be served
   * from a stale local body copy.
   */
  public invalidate(relativePath: string): void {
    this.versionCache.delete(relativePath);
  }

  public getTransferStats(): PodLowerTransferStats {
    return { ...this.stats };
  }

  private toStat(entry: AgentDirectoryEntry): PodLowerStat {
    return {
      path: entry.path,
      type: entry.type,
      ...(entry.size !== undefined ? { size: entry.size } : {}),
      ...(entry.contentType ? { contentType: entry.contentType } : {}),
      ...(entry.version ? { version: entry.version } : {}),
    };
  }

  private async send(
    url: string,
    init: RequestInit & { headers?: Record<string, string> },
    bodyRead = false,
    bodyLength = 0,
  ): Promise<Response> {
    this.stats.requestCount += 1;
    if (init.method === 'GET') {
      this.stats.readRequests += 1;
    }
    if (init.method === 'PUT' || init.method === 'DELETE') {
      this.stats.writeRequests += 1;
    }
    if (bodyRead) {
      this.stats.bodiesReadBytes += bodyLength;
    }
    const response = await this.request(url, init);
    if (bodyRead && init.method === 'GET') {
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      this.stats.bodiesReadBytes += Number.isFinite(contentLength) ? contentLength : 0;
    }
    if (bodyRead && (init.method === 'PUT' || init.method === 'DELETE')) {
      this.stats.bytesWritten += bodyLength;
    }
    return response;
  }
}
