/**
 * Who a Matrix write is done as, in one place.
 *
 * Two things in this subsystem write to a Pod: the store, through drizzle-solid, and the
 * control-record carrier, which needs the *same* authority plus the fetch underneath it — a
 * reservation is a conditional HTTP write, and no ORM call expresses "create only if absent"
 * (see `controlRecords.ts` for what was measured). Resolving the authority twice would mean two
 * token exchanges and, worse, two places that decide whether a deployment may write at all.
 *
 * So the decision lives here: a caller's session, or the deployment acting on its own behalf with
 * the participant's task-layer grant. Never both, never a fallback from one to the other — "who is
 * writing" has to have exactly one answer, or a grant check becomes indistinguishable from a
 * borrowed session. A context that carries neither is refused rather than written with something
 * ambient.
 *
 * The handle is memoised on the context, because a context is one request's worth of work and
 * everything that request touches must go through one Pod identity.
 */
import { drizzle } from '@undefineds.co/drizzle-solid';
import type { PodTable, SolidDatabase } from '@undefineds.co/drizzle-solid';
import { MatrixError } from './MatrixError';
import { isSolidAuth, type AuthContext } from '../auth/AuthContext';
import type { PodAccessFetchProvider } from '../ai-gateway/pod/OwnerPodAccess';
import type { MatrixStoreContext } from './types';

/** The authorized Pod a Matrix write goes to: the database, and the fetch it was built over. */
export interface MatrixPodWrite {
  /** drizzle-solid over the authorized Pod fetch. */
  db: SolidDatabase;
  /**
   * The same authorized fetch. Exposed because some writes are conditions rather than documents:
   * `If-None-Match: *` is what makes a reservation a compare-and-swap, and it is an HTTP request.
   */
  fetch: typeof fetch;
}

export interface MatrixPodWriteOptions {
  /**
   * Relational-query schema map. Only the store has one; a caller that resolves the context first
   * fixes it for the rest of the request, which is harmless because nothing in this path uses
   * `db.query` — the tables are passed to `db.insert`/`db.select` directly.
   */
  schema?: Record<string, unknown>;
  /**
   * Tables to register with the database. Registration is local, idempotent bookkeeping, so it
   * runs on every call: a caller that forgot its own table would otherwise only find out when a
   * query silently misses.
   */
  tables?: readonly PodTable<any>[];
}

/** Where the resolved handle is kept on the context, so one request resolves it once. */
const MEMO = Symbol.for('xpod.matrix.podWrite');
/** A database a test injects; the store has always honoured this and still does. */
const INJECTED_DB = '_matrixDb';
/** The fetch an injected database stands for. */
const INJECTED_FETCH = '_matrixPodFetch';

/** The Pod handle for this context, resolved once and registered for the caller's tables. */
export async function matrixPodWriteFor(
  context: MatrixStoreContext,
  podAccess: PodAccessFetchProvider | undefined,
  options: MatrixPodWriteOptions = {},
): Promise<MatrixPodWrite> {
  const write = await resolvePodWrite(context, podAccess, options.schema);
  if (options.tables && options.tables.length > 0) await write.db.init(...options.tables);
  return write;
}

async function resolvePodWrite(
  context: MatrixStoreContext,
  podAccess: PodAccessFetchProvider | undefined,
  schema: Record<string, unknown> | undefined,
): Promise<MatrixPodWrite> {
  const memo = (context as unknown as Record<symbol, MatrixPodWrite | undefined>)[MEMO];
  if (memo) return memo;

  const injected = (context as unknown as Record<string, SolidDatabase | undefined>)[INJECTED_DB];
  if (injected) {
    const fetch: typeof globalThis.fetch | undefined =
      (context as unknown as Record<string, typeof globalThis.fetch | undefined>)[INJECTED_FETCH];
    if (!fetch) {
      // A database without its fetch is half an authority: reads would work and conditional writes
      // would have nothing to go through. Say so instead of writing with something else.
      throw new MatrixError(500, 'M_UNKNOWN', 'An injected Matrix database carries no Pod fetch');
    }
    return memoise(context, { db: injected, fetch });

  }

  const auth = context.auth as AuthContext | undefined;
  const service = context.service;
  if (service && auth) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'A Matrix context cannot be both a caller session and deployment work');
  }
  if (!service && (!auth || !isSolidAuth(auth) || !auth.webId)) {
    throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'Solid authentication is required');
  }

  const podFetch: typeof globalThis.fetch | undefined = podAccess
    ? await podAccess.getPodFetch(context.webId, {
        ...(auth ? { auth } : {}),
        // Work without a caller carries the participant's task-layer grant, and nothing else: an
        // unusable grant fails here rather than reaching for a deployment-held key.
        ...(service ? { taskCredential: service.taskCredential ?? {} } : {}),
        podBaseUrl: context.podUrl,
      })
    : undefined;
  if (!podFetch) {
    throw new MatrixError(403, 'M_FORBIDDEN', service
      ? `This deployment holds no grant for ${context.webId}'s Pod`
      : 'Grant Pod interface access before using Matrix');
  }

  const db: SolidDatabase = drizzle(
    {
      fetch: podFetch,
      info: {
        webId: auth && isSolidAuth(auth) ? auth.webId : context.webId,
        isLoggedIn: true,
        podUrl: context.podUrl,
      },
    } as never,
    { ...(schema ? { schema } : {}), podUrl: context.podUrl } as never,
  );
  return memoise(context, { db, fetch: podFetch });
}

function memoise(context: MatrixStoreContext, write: MatrixPodWrite): MatrixPodWrite {
  (context as unknown as Record<symbol, MatrixPodWrite>)[MEMO] = write;
  return write;
}
