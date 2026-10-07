import { PodMatrixStore } from '../../src/api/matrix/PodMatrixStore';
import { CanonicalRoomSource } from '../../src/api/matrix/canonicalRoomSource';
import { matrixSigningIdentityRegistry } from '../../src/api/matrix/identityRegistry';
/**
 * The server name the harness deployment signs as.
 *
 * The participant's WebID host, which is what a deployment signs as: each deployment serves its own
 * participant, so the identity a room and an event are addressed by is the host of that WebID.
 * Exported so tests do not spell it out — one line moves every test that follows it.
 */
export const MATRIX_TEST_SERVER_NAME = 'alice.example';

/**
 * An explicit in-memory canonical source registration for creation/ownership units: the given WebID
 * owns the given Pod roots. Production resolves this through `PodLookupRepository`; a unit that needs
 * a mismatch supplies different roots/WebIDs. It makes no network request — creation never reads the
 * new (nonexistent) document.
 */
export function canonicalSourceFor(webId: string, ownedRoots: readonly string[]): CanonicalRoomSource {
  return canonicalSourceForOwners(new Map([ [ webId, [ ...ownedRoots ] ] ]));
}

/**
 * A multi-owner registry for creation units that exercise more than one participant (each owning
 * their own Pod). Still an explicit fixture, never a production ownership derivation.
 */
export function canonicalSourceForOwners(owners: ReadonlyMap<string, readonly string[]>): CanonicalRoomSource {
  const pod = (ownerWebId: string, root: string): Record<string, unknown> => ({
    podId: 'pod-harness', accountId: 'alice', baseUrl: root, webId: ownerWebId, webIds: [ ownerWebId ],
  });
  return new CanonicalRoomSource({
    pods: {
      findByResourceIdentifier: async () => {
        const first = [ ...owners.entries() ][0];
        return first ? pod(first[0], first[1][0] ?? '') : undefined;
      },
      findAllByWebId: async (candidate: string) => (owners.get(candidate) ?? []).map(root => pod(candidate, root)),
    } as never,
    callerFetchFor: async () => { throw new Error('Creation must not fetch the source'); },
  });
}

export function matrixHarness(
  options?: {
    serviceIdentity?: import('../../src/api/matrix/protocol/serviceIdentity').MatrixServiceIdentity;
    /** A full identity source, for tests that run more than one server identity. */
    identities?: import('../../src/api/matrix/identityRegistry').MatrixSigningIdentitySource;
    /** Supplies a participant's own signing identity as they enter a room. */
    participantIdentity?: import('../../src/api/matrix/PodMatrixStore').MatrixParticipantIdentityProvider;
    /** Queues written events for other servers in the room. */
    outbound?: import('../../src/api/matrix/PodMatrixStore').MatrixFederationOutbox;
    /** Tells `sync` which rooms changed, standing in for a notification subscription. */
    roomChanges?: import('../../src/api/matrix/PodMatrixStore').MatrixRoomChangeSource;
    /** How often every room is read anyway, so a missed change is still picked up. */
    roomChangeFullPassMs?: number;
    /** How a room another deployment hosts is joined, when a test provides the handshake. */
    remoteJoin?: import('../../src/api/matrix/PodMatrixStore').PodMatrixStoreOptions['remoteJoin'];
    /** How an alias this deployment does not hold is resolved, when a test provides the query. */
    directoryQuery?: import('../../src/api/matrix/PodMatrixStore').PodMatrixStoreOptions['directoryQuery'];
    /** Queue outbound batches under the participant's authority (O1); off keeps the signed path. */
    deliverAsActor?: boolean;
    /**
     * Explicit registered source Pod roots owned by the harness caller WebID, for creation/ownership
     * units. Absent means the harness registers the caller's own `podUrl` as owned (the common unit
     * case); a test that needs a mismatch supplies its own keys/values. Production never derives
     * ownership this way — this is a fixture, not a fallback.
     */
    registeredOwnedRoots?: string[];
    /** The caller WebID the harness context and registry use. Defaults to the shared alice WebID. */
    webId?: string;
    /** The caller Pod URL the harness context uses. Defaults to the shared alice Pod. */
    podUrl?: string;
    /** A prebuilt canonical source for multi-owner creation units; overrides the default registry. */
    canonicalSource?: CanonicalRoomSource;
  },
) {
  const rows = new Map<any, any[]>();
  const subjectOf = (table: any, row: any): string => {
    if (typeof row['@id'] === 'string') return row['@id'];
    const storedTable = rows.has(table) ? table : [...rows.keys()]
      .find(candidate => candidate.getType() === table.getType()) ?? table;
    return storedTable.buildIri(context.podUrl, { id: row.id });
  };
  const db: any = {
    init: async () => undefined,
    findById: async (table: any, id: string) => (rows.get(table) ?? []).find((r: any) => r.id === id),
    findByIri: async (table: any, iri: string) => (rows.get(table) ?? [])
      .find((row: any) => subjectOf(table, row) === iri),
    insert: (table: any) => ({ values: async (row: any) => {
      const list = rows.get(table) ?? [];
      if (!list.some((r: any) => r.id === row.id)) list.push(structuredClone(row));
      rows.set(table, list);
    } }),
    updateById: async (table: any, id: string, value: any) => Object.assign((rows.get(table) ?? []).find((r: any) => r.id === id), value),
    select: () => {
      let table: any;
      const conditions: any[] = [];
      const orderColumns: any[] = [];
      let limitCount: number | undefined;
      const columnName = (column: any): string => typeof column === 'string'
        ? column : column?.name ?? column?.column?.name ?? column?.column ?? '';
      const normalise = (name: string, value: any): any => table.getColumn(name)?.dataType === 'datetime'
        ? new Date(value).getTime() : value;
      const valueOf = (row: any, name: string): any => name === 'id'
        ? subjectOf(table, row) : normalise(name, row[name]);
      const match = (row: any, condition: any): boolean => {
        if (!condition) return true;
        if (condition.expressions) {
          const expressions = condition.expressions.filter(Boolean);
          if (condition.operator === 'AND') return expressions.every((child: any) => match(row, child));
          if (condition.operator === 'OR') return expressions.some((child: any) => match(row, child));
          throw new Error(`Unsupported fixture logical operator: ${condition.operator}`);
        }
        const name = columnName(condition.left);
        const right = normalise(name, condition.right);
        const left = name === 'id' && typeof right === 'string' && !/^https?:\/\//u.test(right)
          ? row.id : valueOf(row, name);
        switch (condition.operator) {
          case '=': return left === right;
          case '>': return left > right;
          case '<': return left < right;
          case '>=': return left >= right;
          case '<=': return left <= right;
          default: throw new Error(`Unsupported fixture comparison: ${condition.operator}`);
        }
      };
      const resolve = (): any[] => {
        const storedTable = rows.has(table) ? table : [...rows.keys()]
          .find(candidate => candidate.getType() === table.getType());
        const resourcePath = table.getResourcePath();
        const scoped = storedTable !== table && /^https?:\/\//u.test(resourcePath);
        let out = (rows.get(storedTable) ?? []).filter((row: any) =>
          (!scoped || subjectOf(storedTable, row).startsWith(resourcePath.endsWith('/')
            ? resourcePath : `${resourcePath}#`)) && conditions.every(condition => match(row, condition)));
        if (orderColumns.length > 0) {
          out = [...out].sort((left: any, right: any) => {
            for (const column of orderColumns) {
              const name = columnName(column);
              const direction = column.direction === 'desc' ? -1 : 1;
              const a = valueOf(left, name);
              const b = valueOf(right, name);
              if (a < b) return -direction;
              if (a > b) return direction;
            }
            return 0;
          });
        }
        if (limitCount !== undefined) out = out.slice(0, limitCount);
        // Source identity belongs to the hydrated result, not the mutable stored exemplar.
        return out.map((row: any) => ({ ...row, '@id': subjectOf(storedTable, row) }));
      };
      const q: any = {
        from: (t: any) => { table = t; return q; },
        where: (c: any) => { conditions.push(c); return q; },
        whereCursor: (condition: any) => { conditions.push(condition); return q; },
        orderBy: (...columns: any[]) => { orderColumns.push(...columns); return q; },
        limit: (count: number) => { limitCount = count; return q; },
        then: (ok: any, fail: any) => Promise.resolve(resolve()).then(ok, fail),
      };
      return q;
    },
  };
  // The database is injected, so the fetch it stands for has to be injected with it: a Matrix Pod
  // handle is a database *and* the fetch underneath it, because a control-record reservation is a
  // conditional HTTP write. This harness has no Pod behind it, so a test that reaches for one is
  // told rather than handed a silent no-op.
  const podFetch = async(): Promise<Response> => {
    throw new Error('The Matrix test harness has no Pod fetch; use a real Pod for Pod-backed stores');
  };
  const contextWebId = options?.webId ?? 'https://alice.example/profile/card#me';
  const contextPodUrl = options?.podUrl ?? 'https://pod.example/alice/';
  const context: any = { webId: contextWebId, podUrl: contextPodUrl,
    auth: {type:'solid', webId: contextWebId, clientId:'device-a'}, _matrixDb: db,
    _matrixPodFetch: podFetch };
  // A fixture registry: the caller owns the roots it was given, or its own podUrl by default. It is
  // an explicit in-memory registration, not a production ownership derivation.
  const ownedRoots = options?.registeredOwnedRoots ?? [ context.podUrl ];
  const canonicalSource = options?.canonicalSource ?? canonicalSourceFor(context.webId, ownedRoots);
  const store = new PodMatrixStore({
    serverName: MATRIX_TEST_SERVER_NAME,
    canonicalSource,
    ...(options?.participantIdentity ? { participantIdentity: options.participantIdentity } : {}),
    ...(options?.outbound ? { outbound: options.outbound } : {}),
    ...(options?.roomChanges ? { roomChanges: options.roomChanges } : {}),
    ...(options?.roomChangeFullPassMs === undefined ? {} : { roomChangeFullPassMs: options.roomChangeFullPassMs }),
    ...(options?.remoteJoin ? { remoteJoin: options.remoteJoin } : {}),
    ...(options?.directoryQuery ? { directoryQuery: options.directoryQuery } : {}),
    ...(options?.deliverAsActor ? { deliverAsActor: true } : {}),
    ...(options?.identities
      ? { identities: options.identities }
      : options?.serviceIdentity
        ? { identities: matrixSigningIdentityRegistry({ identity: options.serviceIdentity }) }
        : {}),
  });
  return {store,context,db,rows};
}
