/**
 * AgentDirectoryHttpHandler - authenticated directory enumeration and exact
 * content query for agent shell adapters (rg/grep wrappers).
 *
 * Endpoints (sidecar path, default `/-/agent-directory`):
 * - GET  `.../list?root=<containerUrl>[&pathPrefix=][&limit=][&cursor=]`
 * - GET  `.../search?root=<containerUrl>&q=<literal>[&pathPrefix=][&limit=][&cursor=][&maxFileBytes=]`
 * - GET  `.../read?url=<resourceUrl>`
 *
 * Design notes:
 * - The `root` URI is only a scope selector. Every container and every result
 *   is authorized individually through the CSS credentials/permission/authorizer
 *   chain, so a readable root never implies readable descendants.
 * - Child URIs returned by the accessor are validated (same origin, canonical
 *   root scope, no query/hash/userinfo, direct child) before use.
 * - Search is a server-side exact literal scan of authorized content. Only
 *   matches/metadata cross the wire; the full directory body is never returned
 *   to the client for it to grep. Regex/ignore-case/unknown modes are rejected
 *   so the caller falls back to the native binary instead of changing semantics.
 * - Denied resources are silently excluded. Their count is never reported, so
 *   the response cannot leak the existence of inaccessible resources.
 */

import { getLoggerFor } from 'global-logger-factory';
import type { Readable } from 'node:stream';
import { HttpHandler } from '@solid/community-server';
import type {
  Authorizer,
  AuxiliaryStrategy,
  Credentials,
  CredentialsExtractor,
  HttpHandlerInput,
  HttpRequest,
  HttpResponse,
  IdentifierStrategy,
  PermissionReader,
  RepresentationMetadata,
  ResourceIdentifier,
} from '@solid/community-server';
import {
  BadRequestHttpError,
  ForbiddenHttpError,
  HttpError,
  IdentifierSetMultiMap,
  MethodNotAllowedHttpError,
  NotFoundHttpError,
  NotImplementedHttpError,
} from '@solid/community-server';
import { PERMISSIONS } from '@solidlab/policy-engine';
import { MixDataAccessor } from '../../storage/accessors/MixDataAccessor';
import { withDirectDataRead } from '../../storage/ResourceReadContext';
import {
  AGENT_DIRECTORY_SIDECAR,
  type AgentDirectoryEntry,
  type AgentDirectoryListResponse,
  type AgentDirectorySearchMatch,
  type AgentDirectorySearchResponse,
} from '../../agent-directory/protocol';

const ALLOWED_METHODS = [ 'GET', 'OPTIONS' ];
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 50_000;

const INTERNAL_QUADS = 'internal/quads';
const TEXTUAL_CONTENT_TYPES = [
  'text/',
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/x-ndjson',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/javascript',
  'application/x-sh',
  'application/sql',
  'application/sparql-query',
  'application/sparql-update',
];

export interface AgentDirectoryHttpHandlerOptions {
  /** Sidecar path segment, default `/-/agent-directory`. */
  sidecarPath?: string;
  /** Default page size for list/search. */
  defaultLimit?: number;
  /** Hard cap for a single resource read during search. */
  maxFileBytes?: number;
}

interface ListCursor {
  offset: number;
}

interface SearchCursor {
  file: number;
  line: number;
}

interface ReadableText {
  text: string;
}

interface CollectedEntries {
  entries: AgentDirectoryEntry[];
  /**
   * Coverage complete: no authorized resource was left unexamined due to a
   * validation/read failure. Normal pagination does NOT make this false.
   */
  complete: boolean;
  /** The collection cap was hit; more entries exist beyond this page. */
  limitReached: boolean;
  /** Authorized, visible entries counted while building this page. */
  scanned: number;
  /** Diagnostics only; never serialized in a response. */
  denied: number;
  /** Diagnostics only; never serialized in a response. */
  failed: number;
}

export class AgentDirectoryHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);

  private readonly accessor: MixDataAccessor;
  private readonly credentialsExtractor: CredentialsExtractor;
  private readonly permissionReader: PermissionReader;
  private readonly authorizer: Authorizer;
  private readonly auxiliaryStrategy: AuxiliaryStrategy;
  private readonly identifierStrategy: IdentifierStrategy;
  private readonly sidecarPath: string;
  private readonly defaultLimit: number;
  private readonly maxFileBytes: number;

  public constructor(
    accessor: MixDataAccessor,
    credentialsExtractor: CredentialsExtractor,
    permissionReader: PermissionReader,
    authorizer: Authorizer,
    auxiliaryStrategy: AuxiliaryStrategy,
    identifierStrategy: IdentifierStrategy,
    options: AgentDirectoryHttpHandlerOptions = {},
  ) {
    super();
    this.accessor = accessor;
    this.credentialsExtractor = credentialsExtractor;
    this.permissionReader = permissionReader;
    this.authorizer = authorizer;
    this.auxiliaryStrategy = auxiliaryStrategy;
    this.identifierStrategy = identifierStrategy;
    this.sidecarPath = options.sidecarPath ?? AGENT_DIRECTORY_SIDECAR;
    this.defaultLimit = this.normalizeLimit(options.defaultLimit, DEFAULT_LIMIT);
    this.maxFileBytes = this.normalizeLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const path = this.parseUrl(request).pathname;
    if (!path.includes(this.sidecarPath)) {
      throw new NotImplementedHttpError('Request is not targeting the agent directory endpoint.');
    }
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      this.writeOptions(response);
      return;
    }
    if (!ALLOWED_METHODS.includes(method)) {
      throw new MethodNotAllowedHttpError(ALLOWED_METHODS);
    }

    try {
      const url = this.parseUrl(request);
      const operation = this.parseOperation(url.pathname);
      const credentials = await this.credentialsExtractor.handleSafe(request);

      switch (operation) {
        case 'list':
          await this.handleList(url, credentials, response);
          break;
        case 'search':
          await this.handleSearch(url, credentials, response);
          break;
        case 'read':
          await this.handleRead(url, credentials, response);
          break;
        default:
          throw new BadRequestHttpError(`Unsupported agent directory operation: ${operation}`);
      }
    } catch (error: unknown) {
      this.handleError(response, error);
    }
  }

  // ============================================
  // list
  // ============================================

  private async handleList(url: URL, credentials: Credentials, response: HttpResponse): Promise<void> {
    const root = await this.resolveRoot(url, credentials);
    const pathPrefix = this.parsePathPrefix(url.searchParams.get('pathPrefix'));
    const limit = this.clampLimit(url.searchParams.get('limit'));
    const cursor = this.decodeListCursor(url.searchParams.get('cursor'));

    // Collect one extra entry so truncation is detectable without an extra scan.
    const collected = await this.collectEntries(root, credentials, pathPrefix, cursor.offset + limit + 1);
    const page = collected.entries.slice(cursor.offset, cursor.offset + limit);
    const truncated = collected.limitReached || collected.entries.length > cursor.offset + limit;

    const payload: AgentDirectoryListResponse = {
      root,
      entries: page,
      truncated,
      // `complete` is about coverage, not about whether this page is the last one.
      complete: collected.complete,
      scanned: collected.scanned,
      ...(truncated ? { nextCursor: this.encodeCursor({ offset: cursor.offset + page.length }) } : {}),
    };
    this.sendJsonResponse(response, payload);
  }

  // ============================================
  // search
  // ============================================

  private async handleSearch(url: URL, credentials: Credentials, response: HttpResponse): Promise<void> {
    const root = await this.resolveRoot(url, credentials);
    const query = url.searchParams.get('q');
    if (!query) {
      throw new BadRequestHttpError('Missing query parameter "q".');
    }
    const mode = url.searchParams.get('mode') ?? 'literal';
    if (mode !== 'literal') {
      throw new NotImplementedHttpError(
        `Agent directory search mode "${mode}" is not supported; use the native search binary instead.`,
      );
    }
    if (this.parseBoolean(url.searchParams.get('ignoreCase'))) {
      // JavaScript case folding is not equivalent to ripgrep's Unicode simple
      // folding and can shift byte/column offsets; refuse rather than mislead.
      throw new NotImplementedHttpError(
        'Case-insensitive search is not supported; use the native search binary instead.',
      );
    }

    const pathPrefix = this.parsePathPrefix(url.searchParams.get('pathPrefix'));
    const limit = this.clampLimit(url.searchParams.get('limit'));
    const cursor = this.decodeSearchCursor(url.searchParams.get('cursor'));
    const maxFileBytes = this.clampLimit(url.searchParams.get('maxFileBytes'), this.maxFileBytes);

    const collected = await this.collectEntries(root, credentials, pathPrefix, MAX_SCAN_ENTRIES);
    const files = collected.entries.filter((entry) => entry.type === 'file');

    const matches: AgentDirectorySearchMatch[] = [];
    let scannedFiles = 0;
    let skippedUnsupported = 0;
    let truncated = false;
    let nextCursor: SearchCursor | undefined;
    let hasUnscannedScope = !collected.complete || collected.failed > 0 || collected.limitReached;

    for (let fileIndex = cursor.file; fileIndex < files.length; fileIndex += 1) {
      if (matches.length >= limit) {
        truncated = true;
        nextCursor = { file: fileIndex, line: 0 };
        break;
      }
      const file = files[fileIndex];
      scannedFiles += 1;
      const content = await this.readSearchableText(file.url, maxFileBytes);
      if (!content) {
        skippedUnsupported += 1;
        hasUnscannedScope = true;
        continue;
      }
      const fromLine = fileIndex === cursor.file ? cursor.line : 0;
      for (const match of this.findLiteralMatches(content.text, query, file, fromLine)) {
        matches.push(match);
        if (matches.length >= limit) {
          // Resume inside this same file so no later match is dropped.
          truncated = true;
          nextCursor = { file: fileIndex, line: match.line };
          break;
        }
      }
      if (truncated) {
        break;
      }
    }

    // Coverage only: pagination (`truncated`/`nextCursor`) is not an omission.
    const complete = collected.complete && collected.failed === 0 && !collected.limitReached && skippedUnsupported === 0;

    const payload: AgentDirectorySearchResponse = {
      root,
      query,
      mode: 'literal',
      ignoreCase: false,
      matches,
      truncated,
      complete,
      scannedFiles,
      skippedUnsupported,
      hasUnscannedScope,
      ...(nextCursor ? { nextCursor: this.encodeCursor(nextCursor) } : {}),
    };
    this.sendJsonResponse(response, payload);
  }

  // ============================================
  // read
  // ============================================

  private async handleRead(url: URL, credentials: Credentials, response: HttpResponse): Promise<void> {
    const rawUrl = url.searchParams.get('url');
    if (!rawUrl) {
      throw new BadRequestHttpError('Missing query parameter "url".');
    }
    const resourceUrl = this.validateSameOriginUrl(rawUrl, `${url.protocol}//${url.host}`);
    const identifier: ResourceIdentifier = { path: resourceUrl };

    if (this.auxiliaryStrategy.isAuxiliaryIdentifier(identifier)) {
      throw new ForbiddenHttpError('Auxiliary resources are not exposed through the agent directory endpoint.');
    }
    if (!this.identifierStrategy.supportsIdentifier(identifier)) {
      throw new ForbiddenHttpError('Resource is outside the server identifier scope.');
    }

    await this.authorizeIdentifier(resourceUrl, credentials, [ PERMISSIONS.Read ]);

    const content = await this.readSearchableText(resourceUrl, this.maxFileBytes);
    if (!content) {
      throw new BadRequestHttpError('Resource is not a supported text resource.');
    }
    const metadata = await this.accessor.getMetadata(identifier);
    this.sendJsonResponse(response, {
      url: resourceUrl,
      contentType: metadata.contentType,
      size: Buffer.byteLength(content.text, 'utf8'),
      bodyBase64: Buffer.from(content.text, 'utf8').toString('base64'),
    });
  }

  // ============================================
  // enumeration + authorization
  // ============================================

  private async collectEntries(
    root: string,
    credentials: Credentials,
    pathPrefix: string | undefined,
    maxEntries: number,
  ): Promise<CollectedEntries> {
    const entries: AgentDirectoryEntry[] = [];
    let denied = 0;
    let failed = 0;
    let complete = true;
    let limitReached = false;
    let aborted = false;

    // Iterative DFS with deterministic sibling ordering so cursors are stable.
    const stack: string[] = [ root ];
    const visited = new Set<string>();

    while (stack.length > 0 && !aborted) {
      const container = stack.pop() as string;
      if (visited.has(container)) {
        continue;
      }
      visited.add(container);

      let children: string[];
      try {
        children = await this.listAuthorizedChildren(container, credentials);
      } catch (error) {
        // Read/enumeration failure must make the result explicitly incomplete,
        // never silently "complete".
        failed += 1;
        complete = false;
        if (error instanceof HttpError) {
          continue;
        }
        throw error;
      }

      children.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      const childContainers: string[] = [];

      for (const childUrl of children) {
        if (entries.length >= maxEntries) {
          limitReached = true;
          aborted = true;
          break;
        }
        if (!this.isValidChild(container, childUrl, root)) {
          failed += 1;
          complete = false;
          continue;
        }

        const relativePath = this.decodeRelativePath(childUrl.slice(root.length));
        if (relativePath === undefined) {
          failed += 1;
          complete = false;
          continue;
        }
        if (pathPrefix && !relativePath.startsWith(pathPrefix)) {
          continue;
        }

        const identifier: ResourceIdentifier = { path: childUrl };
        if (this.auxiliaryStrategy.isAuxiliaryIdentifier(identifier)) {
          continue;
        }

        let metadata: RepresentationMetadata;
        try {
          metadata = await this.accessor.getMetadata(identifier);
        } catch (error) {
          if (NotFoundHttpError.isInstance(error)) {
            failed += 1;
            complete = false;
            continue;
          }
          throw error;
        }

        const isContainer = childUrl.endsWith('/');
        const authorized = await this.canAuthorizeIdentifier(childUrl, credentials, [ PERMISSIONS.Read ]);
        if (!authorized) {
          denied += 1;
          continue;
        }

        if (isContainer) {
          childContainers.push(childUrl);
        }

        entries.push({
          path: relativePath,
          url: childUrl,
          type: isContainer ? 'container' : 'file',
          ...(metadata.contentType && metadata.contentType !== INTERNAL_QUADS
            ? { contentType: metadata.contentType }
            : {}),
          ...(metadata.contentLength !== undefined ? { size: metadata.contentLength } : {}),
        });
      }

      // Only recurse into containers that were validated and authorized.
      for (let index = childContainers.length - 1; index >= 0; index -= 1) {
        stack.push(childContainers[index]);
      }
    }

    return { entries, complete, limitReached, scanned: entries.length, denied, failed };
  }

  private async listAuthorizedChildren(containerUrl: string, credentials: Credentials): Promise<string[]> {
    await this.authorizeIdentifier(containerUrl, credentials, [ PERMISSIONS.Read ]);
    const children: string[] = [];
    for await (const child of this.accessor.getChildren({ path: containerUrl })) {
      const value = child.identifier?.value;
      if (value) {
        children.push(value);
      }
    }
    return children;
  }

  private isValidChild(containerUrl: string, childUrl: string, root: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(childUrl);
    } catch {
      return false;
    }
    const container = new URL(containerUrl);
    if (parsed.origin !== container.origin || parsed.origin !== new URL(root).origin) {
      return false;
    }
    if (parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') {
      return false;
    }
    if (!childUrl.startsWith(root) || childUrl === root) {
      return false;
    }
    if (!childUrl.startsWith(containerUrl)) {
      return false;
    }
    const segment = childUrl.slice(containerUrl.length);
    if (segment.length === 0) {
      return false;
    }
    const bare = segment.endsWith('/') ? segment.slice(0, -1) : segment;
    return bare.length > 0 && !bare.includes('/');
  }

  private decodeRelativePath(raw: string): string | undefined {
    const segments = raw.split('/').filter((segment) => segment.length > 0);
    const decoded: string[] = [];
    for (const segment of segments) {
      let value: string;
      try {
        value = decodeURIComponent(segment);
      } catch {
        return undefined;
      }
      if (value.length === 0 || value === '.' || value === '..' || value.includes('/')) {
        return undefined;
      }
      decoded.push(value);
    }
    const joined = decoded.join('/');
    return raw.endsWith('/') && joined.length > 0 ? `${joined}/` : joined;
  }

  // ============================================
  // content reading
  // ============================================

  private async readSearchableText(resourceUrl: string, maxFileBytes: number): Promise<ReadableText | undefined> {
    const identifier: ResourceIdentifier = { path: resourceUrl };
    let metadata: RepresentationMetadata;
    try {
      metadata = await this.accessor.getMetadata(identifier);
    } catch (error) {
      if (NotFoundHttpError.isInstance(error)) {
        return undefined;
      }
      throw error;
    }

    let stream: Readable;
    if (metadata.contentType === INTERNAL_QUADS) {
      const localRdf = await this.tryReadLocalRdfDocument(identifier);
      if (!localRdf) {
        return undefined;
      }
      stream = localRdf;
    } else {
      if (!this.isTextualContentType(metadata.contentType)) {
        return undefined;
      }
      stream = await withDirectDataRead(async () => this.accessor.getData(identifier)) as unknown as Readable;
    }

    const bounded = await this.readStreamLimited(stream, maxFileBytes);
    if (bounded.truncated || bounded.buffer.includes(0)) {
      return undefined;
    }
    const text = bounded.buffer.toString('utf8');
    if (text.includes('\uFFFD')) {
      return undefined;
    }
    return { text };
  }

  private async tryReadLocalRdfDocument(identifier: ResourceIdentifier): Promise<Readable | undefined> {
    const accessor = this.accessor as MixDataAccessor & {
      getLocalRdfDocument?: (id: ResourceIdentifier) => Promise<{ data: Readable }>;
    };
    if (typeof accessor.getLocalRdfDocument !== 'function') {
      return undefined;
    }
    try {
      const document = await accessor.getLocalRdfDocument(identifier);
      return document.data as unknown as Readable;
    } catch {
      return undefined;
    }
  }

  private isTextualContentType(contentType: string | undefined): boolean {
    if (!contentType) {
      return true;
    }
    const normalized = contentType.toLowerCase();
    return TEXTUAL_CONTENT_TYPES.some((prefix) => normalized.startsWith(prefix));
  }

  private async readStreamLimited(
    stream: Readable,
    maxFileBytes: number,
  ): Promise<{ buffer: Buffer; truncated: boolean }> {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxFileBytes) {
          truncated = true;
          break;
        }
        chunks.push(buffer);
      }
    } finally {
      const destroyable = stream as Readable & { destroy?: () => void };
      if (typeof destroyable.destroy === 'function') {
        destroyable.destroy();
      }
    }
    return { buffer: Buffer.concat(chunks), truncated };
  }

  /**
   * Line-oriented literal matching.
   *
   * ripgrep's default output prints a matching line once, even when the pattern
   * occurs multiple times on that line, and `-c` counts matching lines rather
   * than occurrences. `fromLineExclusive` lets an in-file cursor resume without
   * dropping later matches. Case-insensitive matching is deliberately absent:
   * the server rejects it before reaching this method.
   */
  private findLiteralMatches(
    text: string,
    query: string,
    file: AgentDirectoryEntry,
    fromLineExclusive: number,
  ): AgentDirectorySearchMatch[] {
    const matches: AgentDirectorySearchMatch[] = [];
    if (query.length === 0) {
      return matches;
    }

    let lineStart = 0;
    let lineNumber = 1;
    while (lineStart <= text.length) {
      const newlineIndex = text.indexOf('\n', lineStart);
      const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
      if (lineNumber > fromLineExclusive) {
        const line = text.slice(lineStart, lineEnd);
        const found = line.indexOf(query);
        if (found !== -1) {
          matches.push({
            path: file.path,
            url: file.url,
            line: lineNumber,
            column: found + 1,
            text: line,
            matched: line.slice(found, found + query.length),
            ...(file.version ? { version: file.version } : {}),
          });
        }
      }
      if (newlineIndex === -1) {
        break;
      }
      lineStart = newlineIndex + 1;
      lineNumber += 1;
    }
    return matches;
  }

  // ============================================
  // validation helpers
  // ============================================

  private async resolveRoot(url: URL, credentials: Credentials): Promise<string> {
    const rawRoot = url.searchParams.get('root');
    if (!rawRoot) {
      throw new BadRequestHttpError('Missing query parameter "root".');
    }
    const origin = `${url.protocol}//${url.host}`;
    let parsed: URL;
    try {
      parsed = new URL(rawRoot);
    } catch {
      throw new BadRequestHttpError('Parameter "root" must be an absolute URL.');
    }
    if (parsed.origin !== origin) {
      throw new ForbiddenHttpError('Parameter "root" must point at this server origin.');
    }
    if (parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') {
      throw new ForbiddenHttpError('Parameter "root" must not carry query, hash or userinfo.');
    }
    if (!parsed.pathname.endsWith('/')) {
      throw new BadRequestHttpError('Parameter "root" must be a container URL ending with "/".');
    }
    const normalized = parsed.href;
    const identifier: ResourceIdentifier = { path: normalized };
    if (!this.identifierStrategy.supportsIdentifier(identifier)) {
      throw new ForbiddenHttpError('Parameter "root" is outside the server identifier scope.');
    }
    await this.authorizeIdentifier(normalized, credentials, [ PERMISSIONS.Read ]);
    return normalized;
  }

  private parsePathPrefix(value: string | null): string | undefined {
    if (!value) {
      return undefined;
    }
    const stripped = value.replace(/^\/+/, '');
    if (stripped.length === 0) {
      return undefined;
    }
    // A trailing slash is the directory marker the caller uses; interior empty
    // segments and ".." are still rejected.
    const segments = stripped.split('/');
    if (segments[segments.length - 1] === '') {
      segments.pop();
    }
    if (segments.length === 0 || segments.some((segment) => segment === '..' || segment.length === 0)) {
      throw new BadRequestHttpError('Parameter "pathPrefix" must be a relative path without "..".');
    }
    return `${segments.join('/')}/`;
  }

  private clampLimit(value: string | null, fallback = this.defaultLimit): number {
    if (!value) {
      return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BadRequestHttpError('Limit must be a positive integer.');
    }
    return Math.min(parsed, MAX_LIMIT);
  }

  private normalizeLimit(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
      return fallback;
    }
    return Math.min(Math.trunc(value), MAX_LIMIT);
  }

  private parseBoolean(value: string | null): boolean {
    return value === '1' || value === 'true' || value === 'yes';
  }

  private decodeListCursor(value: string | null): ListCursor {
    if (!value) {
      return { offset: 0 };
    }
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ListCursor>;
      const offset = Number(decoded.offset);
      if (!Number.isFinite(offset) || offset < 0) {
        throw new Error('invalid offset');
      }
      return { offset: Math.trunc(offset) };
    } catch {
      throw new BadRequestHttpError('Invalid pagination cursor.');
    }
  }

  private decodeSearchCursor(value: string | null): SearchCursor {
    if (!value) {
      return { file: 0, line: 0 };
    }
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SearchCursor>;
      const file = Number(decoded.file);
      const line = Number(decoded.line);
      if (!Number.isFinite(file) || file < 0 || !Number.isFinite(line) || line < 0) {
        throw new Error('invalid cursor');
      }
      return { file: Math.trunc(file), line: Math.trunc(line) };
    } catch {
      throw new BadRequestHttpError('Invalid pagination cursor.');
    }
  }

  private encodeCursor(cursor: ListCursor | SearchCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private parseOperation(pathname: string): string {
    const index = pathname.indexOf(this.sidecarPath);
    if (index === -1) {
      throw new NotImplementedHttpError('Request is not targeting the agent directory endpoint.');
    }
    const suffix = pathname.slice(index + this.sidecarPath.length).replace(/^\/+/, '');
    return suffix.split('/')[0] ?? '';
  }

  private validateSameOriginUrl(value: string, origin: string): string {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new BadRequestHttpError('URL parameter must be an absolute URL.');
    }
    if (parsed.origin !== origin) {
      throw new ForbiddenHttpError('URL parameter must point at this server origin.');
    }
    if (parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') {
      throw new ForbiddenHttpError('URL parameter must not carry query, hash or userinfo.');
    }
    if (!this.identifierStrategy.supportsIdentifier({ path: parsed.href })) {
      throw new ForbiddenHttpError('URL parameter is outside the server identifier scope.');
    }
    return parsed.href;
  }

  private async authorizeIdentifier(basePath: string, credentials: Credentials, modes: string[]): Promise<void> {
    const identifier = { path: basePath } satisfies ResourceIdentifier;
    const requestedModes = new IdentifierSetMultiMap<string>();
    for (const mode of modes) {
      requestedModes.add(identifier, mode);
    }
    const availablePermissions = await this.permissionReader.handleSafe({ credentials, requestedModes });
    await this.authorizer.handleSafe({ credentials, requestedModes, availablePermissions });
  }

  private async canAuthorizeIdentifier(basePath: string, credentials: Credentials, modes: string[]): Promise<boolean> {
    try {
      await this.authorizeIdentifier(basePath, credentials, modes);
      return true;
    } catch (error) {
      this.logger.debug(
        `Agent directory denied ${basePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  // ============================================
  // HTTP helpers
  // ============================================

  private parseUrl(request: HttpRequest): URL {
    const protocol = request.headers['x-forwarded-proto'] ?? 'http';
    const host = request.headers['x-forwarded-host'] ?? request.headers.host ?? 'localhost';
    return new URL(request.url!, `${protocol}://${host}`);
  }

  private sendJsonResponse(response: HttpResponse, data: unknown, status = 200): void {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(data));
  }

  private handleError(response: HttpResponse, error: unknown): void {
    if (error instanceof HttpError) {
      this.sendError(response, error.statusCode, error.name || 'HttpError', error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Agent directory error: ${message}`);
    this.sendError(response, 500, 'INTERNAL_ERROR', message);
  }

  private sendError(response: HttpResponse, status: number, code: string, message: string): void {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify({ error: true, code, message }));
  }

  private writeOptions(response: HttpResponse): void {
    response.writeHead(204, {
      'Access-Control-Allow-Methods': ALLOWED_METHODS.join(', '),
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    response.end();
  }
}
