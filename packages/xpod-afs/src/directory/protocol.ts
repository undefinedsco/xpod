/**
 * Wire protocol shared by the server-side Agent Directory HTTP handler and the
 * client-side (CLI) rg/grep adapters.
 *
 * The directory is a derived view over Pod resources. The Pod HTTP layer stays
 * authoritative for content and per-resource authorization; this protocol only
 * describes enumeration and exact-content-query requests/responses.
 */

export const AGENT_DIRECTORY_SIDECAR = '/-/agent-directory';

export type AgentDirectoryOperation = 'list' | 'search' | 'read';

export interface AgentDirectoryListQuery {
  /** Container resource URL that scopes the enumeration. */
  root: string;
  /** Optional URL-encoded relative path prefix, e.g. `src/`. */
  pathPrefix?: string;
  /** Maximum number of entries to return. */
  limit?: number;
  /** Opaque pagination cursor returned by a previous response. */
  cursor?: string;
}

export interface AgentDirectoryEntry {
  /** Path relative to `root` (containers keep their trailing slash). */
  path: string;
  /** Absolute resource URL. */
  url: string;
  type: 'file' | 'container';
  contentType?: string;
  size?: number;
  /** Native version token (HTTP ETag-like), when the backend provides one. */
  version?: string;
  lastModified?: string;
}

export interface AgentDirectoryListResponse {
  root: string;
  entries: AgentDirectoryEntry[];
  /** More entries exist beyond the requested page (normal pagination). */
  truncated: boolean;
  /**
   * Coverage complete: no authorized resource was left unexamined due to a
   * validation/read failure. Normal pagination does NOT make this false.
   */
  complete: boolean;
  nextCursor?: string;
  /** Number of authorized, visible resources included while building this page. */
  scanned: number;
  /**
   * Deprecated and never serialized by the server. Kept optional only so older
   * test doubles still type-check; exposing how many resources were denied
   * would leak the existence of inaccessible resources.
   */
  skippedUnauthorized?: number;
}

export interface AgentDirectorySearchQuery {
  root: string;
  /** Exact literal to search for. The server never accepts a regex here. */
  query: string;
  /** `literal` only for the MVP; other modes must fall back to the native binary. */
  mode: 'literal';
  ignoreCase?: boolean;
  /** Restrict scanning to resources whose relative path starts with this prefix. */
  pathPrefix?: string;
  limit?: number;
  cursor?: string;
  /** Upper bound for a single resource read, guarding against huge objects. */
  maxFileBytes?: number;
}

export interface AgentDirectorySearchMatch {
  path: string;
  url: string;
  /** 1-based line number of the match. */
  line: number;
  /** 1-based column of the match within its line. */
  column: number;
  /** Full matched line, without the trailing newline. */
  text: string;
  /** The exact matched substring. */
  matched: string;
  version?: string;
}

export interface AgentDirectorySearchResponse {
  root: string;
  query: string;
  mode: 'literal';
  ignoreCase: boolean;
  matches: AgentDirectorySearchMatch[];
  /** More matches exist beyond the requested page (normal pagination). */
  truncated: boolean;
  /**
   * Coverage complete: no authorized resource was left unexamined (excluding
   * normal pagination) and no unsupported content was skipped.
   */
  complete: boolean;
  nextCursor?: string;
  scannedFiles: number;
  /**
   * Deprecated and never serialized by the server. Kept optional only so older
   * test doubles still type-check; exposing how many resources were denied
   * would leak the existence of inaccessible resources.
   */
  skippedUnauthorized?: number;
  /**
   * Count of authorized resources whose content could not be searched (binary
   * or unsupported RDF). This is about visible resources only, so it is safe.
   */
  skippedUnsupported: number;
  /**
   * True when at least one authorized resource was not scanned (binary,
   * unsupported RDF mirror, truncation or partial page). A zero-match response
   * with `complete: false` must not be reported as a full zero-hit result.
   */
  hasUnscannedScope: boolean;
}

export interface AgentDirectoryReadResponse {
  url: string;
  contentType?: string;
  size: number;
  version?: string;
  lastModified?: string;
  /** Base64-encoded body. Kept explicit so callers never mistake it for raw bytes. */
  bodyBase64: string;
}

export interface AgentDirectoryErrorResponse {
  error: true;
  code: string;
  message: string;
}
