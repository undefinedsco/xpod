/**
 * Equal-position overrides of the installed CSS `PathBasedReader` for the bounded A1 observation.
 *
 * The SAME constructor signature `(baseUrl, paths, defaultReader)` and the SAME protected
 * `findReader`/`matchReaders` extension are kept, so the actual deployed reader-chain resource is
 * replaced, not duplicated. Outside a private observation attempt this is byte-for-byte the base
 * behavior. Inside one (the AsyncLocalStorage context the capability enters around the REAL
 * requester admission AND hypothetical target evaluation) the protected dispatch is audited: a route
 * that does not resolve to the bound `defaultReader`, or a missing route, rejects 415 BEFORE that
 * reader is called, and the path is recorded as covered. A chained/waterfall fallback that swallows
 * the rejection cannot clear the sticky marker, so the capability still fails after the full chain
 * returns. An arbitrary trusted outer reader that calls the builtin reader and rewrites results stays
 * explicitly outside this audit.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { PathBasedReader, UnsupportedMediaTypeHttpError } from '@solid/community-server';
import type { PermissionReader } from '@solid/community-server';

export interface ObservationDispatchAudit {
  /** Requester-admission paths whose dispatch actually traversed the bound default route. */
  covered: Set<string>;
  /** Hypothetical-target paths whose dispatch actually traversed the bound default route. */
  targetCovered: Set<string>;
  /** Which capability phase the current dispatch belongs to; requester or hypothetical target. */
  phase: 'requester' | 'target';
  /** Set when any requested path routed elsewhere (or nowhere); never cleared. */
  stickyFailure: boolean;
}

export const observationDispatchContext = new AsyncLocalStorage<ObservationDispatchAudit>();

export class ObservationPathBasedReader extends PathBasedReader {
  protected override findReader(path: string): PermissionReader | undefined {
    const audit = observationDispatchContext.getStore();
    const reader = super.findReader(path);
    if (!audit) {
      return reader;
    }
    if (!this.defaultReader || reader !== this.defaultReader) {
      audit.stickyFailure = true;
      throw new UnsupportedMediaTypeHttpError('Authorization observation route is not the bound default reader');
    }
    // Requester coverage can never certify a hypothetical target: each phase owns a distinct set, so a
    // target dispatch that bypasses this route (and thus records nothing) fails coverage below.
    (audit.phase === 'target' ? audit.targetCovered : audit.covered).add(path);
    return reader;
  }
}
