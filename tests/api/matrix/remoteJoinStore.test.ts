import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import { matrixSigningIdentityRegistry } from '../../../src/api/matrix/identityRegistry';
import { MatrixServiceIdentity } from '../../../src/api/matrix/protocol/serviceIdentity';
import { computeEventId, signEvent } from '../../../src/api/matrix/protocol/eventIntegrity';
import { getProtocolMetadata } from '../../../src/api/protocol-metadata';
import type { RemoteJoinOutcome } from '../../../src/api/matrix/federation/remoteJoin';

const WEB_ID = 'https://alice.example/profile/card#me';
const REMOTE_ROOM = '!r:peer.example';
const NOW = 1_700_000_000_000;

function identity(serverName: string) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return new MatrixServiceIdentity({ serverName, activeKey: { keyId: 'ed25519:1', privateKeyPem }, now: () => NOW });
}

/** What a resident server answers a join with: the room's state, and the event as it accepted it. */
function residentAnswer(userId: string): {
  create: Record<string, unknown>;
  rules: Record<string, unknown>;
  join: Record<string, unknown>;
} {
  // Really signed by the resident, so the events the store keeps are the ones a peer would send.
  const { privateKey } = generateKeyPairSync('ed25519');
  const key = {
    keyId: 'ed25519:1',
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
  const stored = (event: Record<string, unknown>) => ({ ...event, event_id: computeEventId(event) });
  const create = stored(signEvent({
    type: 'm.room.create', room_id: REMOTE_ROOM, sender: '@u_peer:peer.example', state_key: '',
    origin_server_ts: NOW - 1_000, content: { room_version: '11' }, prev_events: [], auth_events: [],
  }, key, 'peer.example'));
  // A resident sends the room's join rules with the state a join is authorised against: without
  // them the room defaults to invite-only, and a join nobody invited would be refused by the very
  // rules the receiving side applies.
  const rules = stored(signEvent({
    type: 'm.room.join_rules', room_id: REMOTE_ROOM, sender: '@u_peer:peer.example', state_key: '',
    origin_server_ts: NOW - 900, content: { join_rule: 'public' },
    prev_events: [ create.event_id ], auth_events: [ create.event_id ],
  }, key, 'peer.example'));
  const join = stored(signEvent({
    type: 'm.room.member', room_id: REMOTE_ROOM, sender: userId, state_key: userId,
    origin_server_ts: NOW, content: { membership: 'join' },
    prev_events: [ rules.event_id ], auth_events: [ create.event_id, rules.event_id ],
  }, key, 'peer.example'));
  return { create, rules, join };
}

function pdus(rows: Map<unknown, any[]>): any[] {
  return (rows.get(messageResource as never) ?? [])
    .map((row: any) => getProtocolMetadata(row.metadata, 'matrix'))
    .filter(Boolean);
}

describe('joining a room another deployment hosts', () => {
  it('asks the resident, keeps the state it sends back, and writes our own join as ours', async () => {
    const ours = identity('alice.example');
    const registry = matrixSigningIdentityRegistry({ providers: [
      { serverName: 'alice.example', provider: { identity: async () => ours } as never },
    ] });
    // The resident answers about the user it was asked about, which is the MXID this deployment
    // derived — not one the test gets to choose.
    const answers: { create: Record<string, unknown>; join: Record<string, unknown> }[] = [];
    const remoteJoin = vi.fn(async (request: { userId: string }): Promise<RemoteJoinOutcome> => {
      const answer = residentAnswer(request.userId);
      answers.push(answer);
      return {
        status: 'joined',
        event: { ...answer.join, signatures: { 'peer.example': { 'ed25519:1': 'theirs' } } },
        eventId: String(answer.join.event_id),
        state: [ answer.create, answer.rules ],
        authChain: [ answer.create, answer.rules ],
      };
    });
    const harness = matrixHarness({ identities: registry, remoteJoin });
    const context = { ...harness.context, webId: WEB_ID };

    await expect(harness.store.joinRoom(REMOTE_ROOM, context)).resolves.toEqual({ roomId: REMOTE_ROOM });

    // The resident was asked for this room, as this user, and only once.
    expect(remoteJoin).toHaveBeenCalledTimes(1);
    const asked = remoteJoin.mock.calls[0][0] as unknown as { roomId: string; userId: string; destination: string };
    expect(asked).toMatchObject({ roomId: REMOTE_ROOM, destination: 'peer.example' });
    expect(asked.userId).toMatch(/^@u_[0-9a-f]{64}:alice\.example$/u);

    // The room's state is stored the way a received event is: verbatim, marked as somebody else's.
    const stored = pdus(harness.rows);
    const create = stored.find((entry: any) => entry.event?.type === 'm.room.create');
    expect(create?.event?.event_id).toBe(answers[0].create.event_id);
    expect(create?.received).toBe(true);

    // Our own join is ours: the event we submitted (with the resident's signature), not a copy.
    const join = stored.find((entry: any) => entry.event?.type === 'm.room.member');
    expect(join?.event?.event_id).toBe(answers[0].join.event_id);
    expect(join?.received).toBeUndefined();
    expect(join?.senderWebId).toBe(WEB_ID);

    // And joining again asks nobody: the membership is already there.
    await expect(harness.store.joinRoom(REMOTE_ROOM, context)).resolves.toEqual({ roomId: REMOTE_ROOM });
    expect(remoteJoin).toHaveBeenCalledTimes(1);
  });

  it('answers a refusal as forbidden and a retryable answer as unavailable', async () => {
    const ours = identity('alice.example');
    const registry = matrixSigningIdentityRegistry({ providers: [
      { serverName: 'alice.example', provider: { identity: async () => ours } as never },
    ] });
    const context = { ...matrixHarness({ identities: registry }).context, webId: WEB_ID };

    const refused = matrixHarness({ identities: registry, remoteJoin: async () => ({ status: 'rejected', reason: 'invite required' }) });
    await expect(refused.store.joinRoom(REMOTE_ROOM, { ...context }))
      .rejects.toThrow(/invite required/u);

    const unavailable = matrixHarness({ identities: registry, remoteJoin: async () => ({ status: 'retry', reason: 'cannot resolve peer.example' }) });
    await expect(unavailable.store.joinRoom(REMOTE_ROOM, { ...context }))
      .rejects.toThrow(/cannot resolve peer\.example/u);
  });
});

describe('joining by an alias another deployment holds', () => {
  it('asks the server the alias names for the room, then joins that room', async () => {
    const ours = identity('alice.example');
    const registry = matrixSigningIdentityRegistry({ providers: [
      { serverName: 'alice.example', provider: { identity: async () => ours } as never },
    ] });
    const alias = '#lobby:peer.example';
    const directoryQuery = vi.fn(async (_request: { roomAlias: string; destination: string }) => REMOTE_ROOM);
    const answers: { create: Record<string, unknown>; join: Record<string, unknown> }[] = [];
    const remoteJoin = vi.fn(async (request: { userId: string }): Promise<RemoteJoinOutcome> => {
      const answer = residentAnswer(request.userId);
      answers.push(answer);
      return {
        status: 'joined',
        event: answer.join,
        eventId: String(answer.join.event_id),
        state: [ answer.create, answer.rules ],
        authChain: [ answer.create, answer.rules ],
      };
    });
    const harness = matrixHarness({ identities: registry, directoryQuery, remoteJoin });
    const context = { ...harness.context, webId: WEB_ID };

    await expect(harness.store.joinRoom(alias, context)).resolves.toEqual({ roomId: REMOTE_ROOM });

    // The alias names the server that can answer it, and only that server was asked.
    expect(directoryQuery).toHaveBeenCalledTimes(1);
    expect(directoryQuery.mock.calls[0][0]).toMatchObject({ roomAlias: alias, destination: 'peer.example' });
    // Then the room it named is joined the way any remote room is.
    expect(remoteJoin).toHaveBeenCalledTimes(1);
    expect(pdus(harness.rows).some((entry: any) => entry.event?.event_id === answers[0].join.event_id)).toBe(true);
  });

  it('answers not found when neither this deployment nor the alias\'s server knows it', async () => {
    const ours = identity('alice.example');
    const registry = matrixSigningIdentityRegistry({ providers: [
      { serverName: 'alice.example', provider: { identity: async () => ours } as never },
    ] });
    const harness = matrixHarness({ identities: registry, directoryQuery: async () => undefined });
    await expect(harness.store.joinRoom('#nowhere:peer.example', { ...harness.context, webId: WEB_ID }))
      .rejects.toThrow(/alias not found/u);
  });
});
