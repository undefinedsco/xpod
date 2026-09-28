import { PodMatrixStore } from '../../src/api/matrix/PodMatrixStore';
import { matrixSigningIdentityRegistry } from '../../src/api/matrix/identityRegistry';
/**
 * The server name the harness deployment signs as.
 *
 * The participant's WebID host, which is what a deployment signs as: each deployment serves its own
 * participant, so the identity a room and an event are addressed by is the host of that WebID.
 * Exported so tests do not spell it out — one line moves every test that follows it.
 */
export const MATRIX_TEST_SERVER_NAME = 'alice.example';

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
  },
) {
  const rows = new Map<any, any[]>();
  const db: any = {
    init: async () => undefined,
    findById: async (table: any, id: string) => (rows.get(table) ?? []).find((r: any) => r.id === id),
    insert: (table: any) => ({ values: async (row: any) => {
      const list = rows.get(table) ?? [];
      if (!list.some((r: any) => r.id === row.id)) list.push(structuredClone(row));
      rows.set(table, list);
    } }),
    updateById: async (table: any, id: string, value: any) => Object.assign((rows.get(table) ?? []).find((r: any) => r.id === id), value),
    select: () => {
      let table: any; let condition: any;
      const match = (r: any, c: any): boolean => !c || (c.expressions
        ? c.expressions.filter(Boolean).every((x: any) => match(r, x))
        : c.operator === '=' ? r[c.left.name] === c.right : true);
      const q: any = { from: (t: any) => { table = t; return q; },
        where: (c: any) => { condition = c; return q; }, orderBy: () => q, limit: () => q,
        then: (ok: any, fail: any) => Promise.resolve((rows.get(table) ?? []).filter((r: any) => match(r, condition))).then(ok, fail),
      }; return q;
    },
  };
  // The database is injected, so the fetch it stands for has to be injected with it: a Matrix Pod
  // handle is a database *and* the fetch underneath it, because a control-record reservation is a
  // conditional HTTP write. This harness has no Pod behind it, so a test that reaches for one is
  // told rather than handed a silent no-op.
  const podFetch = async(): Promise<Response> => {
    throw new Error('The Matrix test harness has no Pod fetch; use a real Pod for Pod-backed stores');
  };
  const context: any = { webId: 'https://alice.example/profile/card#me', podUrl: 'https://pod.example/alice/',
    auth: {type:'solid', webId:'https://alice.example/profile/card#me', clientId:'device-a'}, _matrixDb: db,
    _matrixPodFetch: podFetch };
  const store = new PodMatrixStore({
    serverName: MATRIX_TEST_SERVER_NAME,
    ...(options?.participantIdentity ? { participantIdentity: options.participantIdentity } : {}),
    ...(options?.outbound ? { outbound: options.outbound } : {}),
    ...(options?.roomChanges ? { roomChanges: options.roomChanges } : {}),
    ...(options?.roomChangeFullPassMs === undefined ? {} : { roomChangeFullPassMs: options.roomChangeFullPassMs }),
    ...(options?.remoteJoin ? { remoteJoin: options.remoteJoin } : {}),
    ...(options?.directoryQuery ? { directoryQuery: options.directoryQuery } : {}),
    ...(options?.identities
      ? { identities: options.identities }
      : options?.serviceIdentity
        ? { identities: matrixSigningIdentityRegistry({ identity: options.serviceIdentity }) }
        : {}),
  });
  return {store,context,db,rows};
}
