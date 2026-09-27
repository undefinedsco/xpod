import { PodMatrixStore } from '../../src/api/matrix/PodMatrixStore';
import { matrixSigningIdentityRegistry } from '../../src/api/matrix/identityRegistry';
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
  const context: any = { webId: 'https://alice.example/profile/card#me', podUrl: 'https://pod.example/alice/',
    auth: {type:'solid', webId:'https://alice.example/profile/card#me', clientId:'device-a'}, _matrixDb: db };
  const store = new PodMatrixStore({
    serverName: 'example.test',
    ...(options?.participantIdentity ? { participantIdentity: options.participantIdentity } : {}),
    ...(options?.outbound ? { outbound: options.outbound } : {}),
    ...(options?.roomChanges ? { roomChanges: options.roomChanges } : {}),
    ...(options?.roomChangeFullPassMs === undefined ? {} : { roomChangeFullPassMs: options.roomChangeFullPassMs }),
    ...(options?.remoteJoin ? { remoteJoin: options.remoteJoin } : {}),
    ...(options?.identities
      ? { identities: options.identities }
      : options?.serviceIdentity
        ? { identities: matrixSigningIdentityRegistry({ identity: options.serviceIdentity }) }
        : {}),
  });
  return {store,context,db,rows};
}
