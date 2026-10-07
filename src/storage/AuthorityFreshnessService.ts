import { createHash } from 'node:crypto';

import { HttpError } from '@solid/community-server';

import type { SolidFsSyncJournalOperation } from '../solidfs/SolidFsSyncJournal';

/**
 * Explicit retryable unavailability for a resource whose derived facts are pending against the
 * authority file. Never a false absence: a caller must not interpret this as 404.
 */
export class AuthorityPendingUnavailableError extends HttpError {
  public constructor(message: string) {
    super(503, 'AuthorityPendingUnavailableError', message, { errorCode: 'AUTHORITY_PENDING' });
  }
}

/**
 * One generic derived-index freshness contract for RDF authority.
 *
 * A pending token means the derived index (structured facts, metadata, text, native/WHERE reads) may
 * be stale relative to the authority file. Readers must consult this state before serving cached or
 * derived facts and either rebuild from the complete authority file or report explicit retryable
 * unavailability — never a false absence.
 */
export interface AuthorityPendingToken {
  id: string;
  path: string;
  resource?: string;
  sourcePath: string;
  sourceVersion?: string;
  afterHash?: string;
  createdAt: number;
}

export interface AuthorityFreshnessBackend {
  listAuthorityPending(path?: string): SolidFsSyncJournalOperation[];
  getAuthorityPending(id: string): SolidFsSyncJournalOperation | undefined;
  clearAuthorityPending(id: string): boolean;
}

export function toPendingToken(operation: SolidFsSyncJournalOperation): AuthorityPendingToken {
  return {
    id: operation.id,
    path: operation.change.path,
    resource: operation.change.resource,
    sourcePath: operation.change.sourcePath,
    sourceVersion: operation.change.sourceVersion,
    afterHash: operation.afterHash,
    createdAt: operation.createdAt,
  };
}

/**
 * SQLite-backed freshness view shared by one canonical process. Local SQLite pending cannot protect
 * separate CSS nodes sharing a PostgreSQL index; that Cloud source-ownership qualification remains a
 * separate gap.
 */
export class AuthorityFreshnessService {
  public constructor(private readonly backend: AuthorityFreshnessBackend) {}

  public pendingFor(path: string): AuthorityPendingToken[] {
    return this.backend.listAuthorityPending(path).map(toPendingToken);
  }

  public pendingByResource(resource: string): AuthorityPendingToken[] {
    return this.backend.listAuthorityPending()
      .map(toPendingToken)
      .filter((token) => token.resource === resource);
  }

  public hasPending(path: string): boolean {
    return this.backend.listAuthorityPending(path).length > 0;
  }

  public hasPendingResource(resource: string): boolean {
    return this.pendingByResource(resource).length > 0;
  }

  public hasAnyPending(): boolean {
    return this.backend.listAuthorityPending().length > 0;
  }

  /** Any pending source equal to, or nested under, the given scope (for container/range reads). */
  public pendingInScope(scope: string): AuthorityPendingToken[] {
    return this.backend.listAuthorityPending()
      .map(toPendingToken)
      .filter((token) =>
        token.resource === scope
        || token.path === scope
        || (token.resource?.startsWith(scope.endsWith('/') ? scope : `${scope}/`) ?? false),
      );
  }

  /** Clear only the exact token named, and only while it is still current. */
  public clear(tokenId: string): boolean {
    return this.backend.clearAuthorityPending(tokenId);
  }
}

export function hashAuthoritySource(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Named graph IRIs a SPARQL query can read, conservatively over-inclusive. */
export function graphUrlsMentionedInSparql(query: string): string[] {
  const urls = new Set<string>();
  for (const match of query.matchAll(/\bGRAPH\s*<([^>\s]+)>/giu)) {
    urls.add(match[1]);
  }
  return [ ...urls ];
}

/**
 * The candidate derived-index scope a native/query read depends on. A provider refuses the read
 * (retryable) when any named graph still has a pending authority token, or proves it current by
 * rebuilding from the complete authority file.
 */
export interface AuthorityFreshnessQuery {
  basePath?: string;
  graphUrls?: readonly string[];
  resourceUrls?: readonly string[];
  /**
   * The reader could not bound the query to named graphs (variable graph, unions, optional, exists,
   * minus, text/vector). A conservative refusal applies while ANY authority token is pending rather
   * than silently serving possibly-stale facts.
   */
  unbounded?: boolean;
}

export interface AuthorityFreshnessProvider {
  assertFresh(query: AuthorityFreshnessQuery): void | Promise<void>;
  /**
   * Explicit synchronous freshness proof for synchronous read paths. Its presence is the capability
   * declaration: a synchronous reader must invoke only this method and must never start `assertFresh`
   * and ignore its Promise.
   */
  assertFreshSync?(query: AuthorityFreshnessQuery): void;
}

/**
 * Generic provider over any shared freshness backend. A reader naming a graph/resource that still
 * has a pending authority token — or a source nested under the read scope — is refused with a
 * retryable 503. It never translates uncertainty into a false absence and never serves stale facts.
 * The check is synchronous (a plain SQLite journal read), so `assertFreshSync` is a real proof, not a
 * wrapped Promise.
 */
export class AuthorityPendingFreshnessProvider implements AuthorityFreshnessProvider {
  public constructor(private readonly freshness: AuthorityFreshnessService) {}

  public assertFresh(query: AuthorityFreshnessQuery): void {
    this.refuse(query);
  }

  public assertFreshSync(query: AuthorityFreshnessQuery): void {
    this.refuse(query);
  }

  private refuse(query: AuthorityFreshnessQuery): void {
    if (query.unbounded) {
      if (this.freshness.hasAnyPending()) {
        throw new AuthorityPendingUnavailableError(
          'Authority derived facts are pending for a query whose scope cannot be bounded',
        );
      }
      return;
    }
    const targets = new Set<string>([
      ...(query.graphUrls ?? []),
      ...(query.resourceUrls ?? []),
    ]);
    for (const target of targets) {
      if (this.freshness.hasPendingResource(target) || this.freshness.hasPending(target)) {
        throw new AuthorityPendingUnavailableError(
          `Derived facts for the requested scope are pending against the authority file`,
        );
      }
    }
    if (query.basePath && this.freshness.pendingInScope(query.basePath).length > 0) {
      throw new AuthorityPendingUnavailableError(
        `Derived facts for the requested scope are pending against the authority file`,
      );
    }
    // No concrete scope and not flagged unbounded: treat as unknown rather than silently current.
    if (targets.size === 0 && !query.basePath && this.freshness.hasAnyPending()) {
      throw new AuthorityPendingUnavailableError(
        'Authority derived facts are pending for a query whose scope cannot be bounded',
      );
    }
  }
}
