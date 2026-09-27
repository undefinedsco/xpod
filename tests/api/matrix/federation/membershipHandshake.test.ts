import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildMembershipTemplate,
  checkMembershipTemplate,
  handleMembershipSubmission,
} from '../../../../src/api/matrix/federation/membershipHandshake';
import { computeEventId, signEvent } from '../../../../src/api/matrix/protocol/eventIntegrity';
import { MatrixServiceIdentity } from '../../../../src/api/matrix/protocol/serviceIdentity';
import { parseServerKeyResponse, type MatrixServerKeySource } from '../../../../src/api/matrix/federation/serverKeys';
import type { AuthEvent } from '../../../../src/api/matrix/protocol/authRules';
import type { MatrixEventRecord } from '../../../../src/api/matrix/types';

const ALICE_SERVER = 'alice.example';
const REMOTE = 'remote.example';
const ROOM = `!r:${ALICE_SERVER}`;
const ALICE = `@u_alice:${ALICE_SERVER}`;
const BOB = `@u_bob:${REMOTE}`;
const NOW = 1_700_000_000_000;

/** A deployment: the identity it signs with, and the key source a peer verifies against. */
function deployment(serverName: string) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const identity = new MatrixServiceIdentity({ serverName, activeKey: { keyId: 'ed25519:1', privateKeyPem }, now: () => NOW });
  const keys = parseServerKeyResponse(identity.serverKeyResponse(), { expectedServerName: serverName, now: NOW });
  const source: MatrixServerKeySource = { keysFor: async name => (name === serverName ? keys : undefined) };
  return {
    identity,
    source,
    sign(event: Record<string, unknown>) { return signEvent(event, { keyId: 'ed25519:1', privateKeyPem }, serverName); },
  };
}

/**
 * The row a resident server would have stored for an event. The stored event carries its derived
 * id, as `buildPersistedEvent` does: everything that answers with PDUs hands them on by id.
 */
function row(event: Record<string, unknown>): MatrixEventRecord {
  const eventId = computeEventId(event);
  return {
    eventId,
    roomId: String(event.room_id),
    type: String(event.type),
    sender: String(event.sender),
    originServerTs: Number(event.origin_server_ts),
    depth: Number(event.depth),
    content: event.content as Record<string, unknown>,
    ...(event.state_key === undefined ? {} : { stateKey: String(event.state_key) }),
    event: { ...event, event_id: eventId },
  };
}

const auth = (events: readonly MatrixEventRecord[]): AuthEvent[] => events.map(record => record.event as AuthEvent);

/**
 * A room on Alice's deployment, as rows: the create event, Alice's join, power levels and the join
 * rules, then optionally Bob's invite or ban. Every event names its parents and its auth events the
 * way `roomGraphPosition` selects them, so it is a room the auth rules actually accept.
 */
function residentRoom(options: { joinRule?: 'public' | 'invite'; bob?: 'invite' | 'ban' } = {}) {
  const alice = deployment(ALICE_SERVER);
  const joinRule = options.joinRule ?? 'public';
  const create = row(alice.sign({
    type: 'm.room.create', room_id: ROOM, sender: ALICE, state_key: '', origin_server_ts: NOW - 10_000,
    content: { room_version: '11' }, depth: 1, prev_events: [], auth_events: [],
  }));
  const aliceJoin = row(alice.sign({
    type: 'm.room.member', room_id: ROOM, sender: ALICE, state_key: ALICE, origin_server_ts: NOW - 9_000,
    content: { membership: 'join' }, depth: 2, prev_events: [ create.eventId ], auth_events: [ create.eventId ],
  }));
  const power = row(alice.sign({
    type: 'm.room.power_levels', room_id: ROOM, sender: ALICE, state_key: '', origin_server_ts: NOW - 8_000,
    content: { users: { [ALICE]: 100 } }, depth: 3,
    prev_events: [ aliceJoin.eventId ], auth_events: [ create.eventId, aliceJoin.eventId ],
  }));
  const rules = row(alice.sign({
    type: 'm.room.join_rules', room_id: ROOM, sender: ALICE, state_key: '', origin_server_ts: NOW - 7_000,
    content: { join_rule: joinRule }, depth: 4,
    prev_events: [ power.eventId ], auth_events: [ create.eventId, aliceJoin.eventId, power.eventId ],
  }));
  const events = [ create, aliceJoin, power, rules ];
  if (options.bob !== undefined) {
    events.push(row(alice.sign({
      type: 'm.room.member', room_id: ROOM, sender: ALICE, state_key: BOB, origin_server_ts: NOW - 6_000,
      content: { membership: options.bob }, depth: 5,
      prev_events: [ rules.eventId ], auth_events: [ create.eventId, aliceJoin.eventId, power.eventId, rules.eventId ],
    })));
  }
  return { alice, events };
}

/** The join event a joining server builds from the template it was given, signed with its own key. */
function signedJoin(
  template: Record<string, unknown>,
  remote: ReturnType<typeof deployment>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const { room_id, type, sender, state_key, content, depth, prev_events, auth_events } = template;
  return remote.sign({
    room_id, type, sender, state_key, content, depth, prev_events, auth_events,
    origin: REMOTE, origin_server_ts: NOW - 1_000,
    ...overrides,
  });
}

describe('answering make_join and make_leave', () => {
  it('answers a public room with a template that carries the graph position', () => {
    const { alice, events } = residentRoom({ joinRule: 'public' });
    const answer = buildMembershipTemplate({
      roomId: ROOM, userId: BOB, membership: 'join', serverName: ALICE_SERVER, records: events, versions: [ '11' ], now: () => NOW,
    });

    expect(answer.status).toBe(200);
    expect(answer.body.room_version).toBe('11');
    expect(answer.body.event).toMatchObject({
      room_id: ROOM, type: 'm.room.member', sender: BOB, state_key: BOB, origin: ALICE_SERVER,
      origin_server_ts: NOW, content: { membership: 'join' }, depth: 5,
    });
    // The parents are the events nothing else references yet, and the auth events are the ones the
    // auth rules will check the finished event against: the join rules matter for a join.
    expect(answer.body.event).toMatchObject({ prev_events: [ events[3].eventId ] });
    expect((answer.body.event as any).auth_events).toEqual([
      events[0].eventId, events[2].eventId, events[3].eventId,
    ]);
    expect(alice).toBeDefined();
  });

  it('refuses a room version the asking server did not offer, naming the version', () => {
    const { events } = residentRoom();
    const answer = buildMembershipTemplate({
      roomId: ROOM, userId: BOB, membership: 'join', serverName: ALICE_SERVER, records: events, versions: [ '10' ],
    });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ errcode: 'M_INCOMPATIBLE_ROOM_VERSION', room_version: '11' });
  });

  it('treats an absent version list as version 1, the specification\'s default', () => {
    const { events } = residentRoom();
    const answer = buildMembershipTemplate({ roomId: ROOM, userId: BOB, membership: 'join', serverName: ALICE_SERVER, records: events });
    expect(answer.status).toBe(400);
    expect(answer.body.errcode).toBe('M_INCOMPATIBLE_ROOM_VERSION');
  });

  it('reports an unknown room as not found rather than as a refusal', () => {
    const answer = buildMembershipTemplate({
      roomId: '!other:someone.example', userId: BOB, membership: 'join', serverName: ALICE_SERVER, records: [],
    });
    expect(answer.status).toBe(404);
    expect(answer.body.errcode).toBe('M_NOT_FOUND');
  });

  it('refuses a user the room does not admit, with the rule that decided it', () => {
    const { events } = residentRoom({ joinRule: 'invite' });
    const refused = buildMembershipTemplate({
      roomId: ROOM, userId: BOB, membership: 'join', serverName: ALICE_SERVER, records: events, versions: [ '11' ],
    });
    expect(refused.status).toBe(403);
    expect(String(refused.body.error)).toMatch(/v11-4\.3\.4/u);

    // The same room admits an invited user, and a banned one is refused before the join rules.
    const invited = residentRoom({ joinRule: 'invite', bob: 'invite' });
    const allowed = buildMembershipTemplate({
      roomId: ROOM, userId: BOB, membership: 'join', serverName: ALICE_SERVER, records: invited.events, versions: [ '11' ],
    });
    expect(allowed.status).toBe(200);

    const banned = residentRoom({ joinRule: 'public', bob: 'ban' });
    const denied = buildMembershipTemplate({
      roomId: ROOM, userId: BOB, membership: 'join', serverName: ALICE_SERVER, records: banned.events, versions: [ '11' ],
    });
    expect(denied.status).toBe(403);
    expect(String(denied.body.error)).toMatch(/v11-4\.3\.3/u);
  });

  it('answers a member who wants to leave, and refuses one who was never in the room', () => {
    const { events } = residentRoom();
    const leaving = buildMembershipTemplate({
      roomId: ROOM, userId: ALICE, membership: 'leave', serverName: ALICE_SERVER, records: events, versions: [ '11' ],
    });
    expect(leaving.status).toBe(200);
    expect(leaving.body.event).toMatchObject({ type: 'm.room.member', sender: ALICE, state_key: ALICE, content: { membership: 'leave' } });

    const stranger = buildMembershipTemplate({
      roomId: ROOM, userId: BOB, membership: 'leave', serverName: ALICE_SERVER, records: events, versions: [ '11' ],
    });
    expect(stranger.status).toBe(403);
    expect(String(stranger.body.error)).toMatch(/v11-4\.5\.1/u);
  });
});

describe('checking a template before signing it', () => {
  const template = {
    room_version: '11',
    event: {
      room_id: ROOM, type: 'm.room.member', sender: BOB, state_key: BOB, content: { membership: 'join' },
      depth: 5, prev_events: [], auth_events: [],
    },
  };
  const expected = { roomId: ROOM, userId: BOB, membership: 'join' as const, versions: [ '11' ] };

  it('accepts a template for the request that was made', () => {
    expect(checkMembershipTemplate(template, expected)).toEqual({ ok: true, reason: expect.stringContaining('matches') });
  });

  it('discards a template for another room, user, type or membership', () => {
    const forRoom = { ...template, event: { ...template.event, room_id: '!other:x.example' } };
    expect(checkMembershipTemplate(forRoom, expected).ok).toBe(false);
    const forUser = { ...template, event: { ...template.event, state_key: ALICE } };
    expect(checkMembershipTemplate(forUser, expected).reason).toMatch(/membership of/u);
    const forType = { ...template, event: { ...template.event, type: 'm.room.name' } };
    expect(checkMembershipTemplate(forType, expected).reason).toMatch(/m\.room\.name/u);
    const forMembership = { ...template, event: { ...template.event, content: { membership: 'leave' } } };
    expect(checkMembershipTemplate(forMembership, expected).reason).toMatch(/membership is leave/u);
  });

  it('discards a template for a room version this server did not offer', () => {
    const other = { ...template, room_version: '10' };
    expect(checkMembershipTemplate(other, expected).reason).toMatch(/room version 10/u);
    expect(checkMembershipTemplate({ event: template.event }, expected).reason).toMatch(/no room version/u);
    expect(checkMembershipTemplate({ room_version: '11' }, expected).reason).toMatch(/no event template/u);
  });
});

describe('accepting a submitted join or leave', () => {
  async function submit(options: {
    membership?: 'join' | 'leave';
    room?: ReturnType<typeof residentRoom>;
    /** Change the signed event the joining server derived from its template. */
    fromTemplate?: (event: Record<string, unknown>) => Record<string, unknown>;
    /** Submit an event built here instead of deriving one from a template. */
    buildEvent?: (submitter: ReturnType<typeof deployment>) => Record<string, unknown>;
    authEvents?: AuthEvent[];
    eventId?: string;
  } = {}) {
    const room = options.room ?? residentRoom();
    const remote = deployment(REMOTE);
    const membership = options.membership ?? 'join';
    let event = options.buildEvent?.(remote);
    if (!event) {
      const template = buildMembershipTemplate({
        roomId: ROOM, userId: BOB, membership, serverName: ALICE_SERVER,
        records: room.events, versions: [ '11' ], now: () => NOW,
      });
      expect(template.status).toBe(200);
      event = signedJoin(template.body.event as Record<string, unknown>, remote);
      if (options.fromTemplate) event = options.fromTemplate(event);
    }
    const eventId = options.eventId ?? computeEventId(event);
    const answer = await handleMembershipSubmission({
      membership, roomId: ROOM, eventId, event, origin: REMOTE,
      keys: remote.source,
      authEvents: options.authEvents ?? auth(room.events),
      records: room.events,
      counterSign: room.alice.identity,
      now: () => NOW,
    });
    return { answer, event, eventId, room, remote };
  }

  it('accepts a signed join and answers with the state before it and the accepted event', async () => {
    const { answer, event, eventId, room } = await submit();
    expect(answer.status).toBe(200);

    const ids = (answer.body.state as Record<string, unknown>[]).map(entry => entry.event_id).sort();
    expect(ids).toEqual([ room.events[0].eventId, room.events[1].eventId, room.events[2].eventId, room.events[3].eventId ].sort());
    // The join is not part of the state it is joining, and the auth chain carries the same events.
    expect(ids).not.toContain(eventId);
    expect((answer.body.auth_chain as Record<string, unknown>[]).map(entry => entry.event_id)).toContain(room.events[0].eventId);

    // The resident's own signature is on the event it hands back, and the sender's is untouched.
    const accepted = answer.body.event as Record<string, unknown>;
    expect(computeEventId(accepted)).toBe(eventId);
    expect(Object.keys(accepted.signatures as Record<string, unknown>).sort()).toEqual([ ALICE_SERVER, REMOTE ]);
    expect(accepted.signatures).toMatchObject({ [REMOTE]: event.signatures && (event.signatures as any)[REMOTE] });
  });

  it('refuses an event whose derived id is not the id in the request path', async () => {
    const { answer } = await submit({ eventId: '$somebody-elses-id' });
    expect(answer.status).toBe(400);
    expect(answer.body.errcode).toBe('M_INVALID_PARAM');
    expect(String(answer.body.error)).toMatch(/request path/u);
  });

  it('refuses a body that is not the membership event the endpoint is for', async () => {
    const wrongType = await submit({ fromTemplate: event => ({ ...event, type: 'm.room.message' }) });
    expect(wrongType.answer.status).toBe(400);
    expect(wrongType.answer.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });

    const wrongMembership = await submit({ fromTemplate: event => ({ ...event, content: { membership: 'leave' } }) });
    expect(String(wrongMembership.answer.body.error)).toMatch(/membership is leave/u);

    const otherUser = await submit({ fromTemplate: event => ({ ...event, state_key: ALICE }) });
    expect(String(otherUser.answer.body.error)).toMatch(/somebody else/u);

    // A user of another server: `origin` is the server that signed the request.
    const elsewhere = await submit({
      fromTemplate: event => ({ ...event, sender: `@u_eve:${ALICE_SERVER}`, state_key: `@u_eve:${ALICE_SERVER}` }),
    });
    expect(String(elsewhere.answer.body.error)).toMatch(/not a user of remote\.example/u);
  });

  it('refuses an event this server cannot verify', async () => {
    const attacker = deployment('attacker.example');
    const { room } = await submit();
    const template = buildMembershipTemplate({
      roomId: ROOM, userId: BOB, membership: 'join', serverName: ALICE_SERVER, records: room.events, versions: [ '11' ], now: () => NOW,
    });
    // Signed by somebody else while claiming to come from the remote server.
    const forged = attacker.sign({ ...(template.body.event as Record<string, unknown>), origin: REMOTE, origin_server_ts: NOW - 1_000 });
    const answer = await handleMembershipSubmission({
      membership: 'join', roomId: ROOM, eventId: computeEventId(forged), event: forged, origin: REMOTE,
      keys: deployment(REMOTE).source, authEvents: auth(room.events), records: room.events, now: () => NOW,
    });
    expect(answer.status).toBe(400);
    expect(answer.body.errcode).toBe('M_INVALID_PARAM');
    expect(String(answer.body.error)).toMatch(/v11-2/u);
  });

  it('refuses a join the room does not permit, as forbidden rather than malformed', async () => {
    // An invite-only room the user was never invited to: the joining server cannot get a template
    // for it (`make_join` refuses first), so it has to have invented this event's auth events.
    const room = residentRoom({ joinRule: 'invite' });
    const [ create, aliceJoin, power, rules ] = room.events;
    const { answer } = await submit({
      room,
      buildEvent: submitter => submitter.sign({
        room_id: ROOM, type: 'm.room.member', sender: BOB, state_key: BOB, origin_server_ts: NOW - 1_000,
        content: { membership: 'join' }, origin: REMOTE, depth: 5,
        prev_events: [ rules.eventId ],
        auth_events: [ create.eventId, power.eventId, rules.eventId ],
      }),
    });
    expect(answer.status).toBe(403);
    expect(answer.body.errcode).toBe('M_FORBIDDEN');
    expect(String(answer.body.error)).toMatch(/v11-4\.3\.4/u);
    expect(aliceJoin).toBeDefined();
  });

  it('tells the joining server to ask another resident when the auth events are not here', async () => {
    const { answer } = await submit({ authEvents: [] });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ errcode: 'M_UNABLE_TO_GRANT_JOIN' });
    expect(String(answer.body.error)).toMatch(/auth event/u);
  });

  it('accepts a leave with an empty answer, as v2 defines it', async () => {
    const { answer, eventId, room } = await submit({ membership: 'leave', room: residentRoom({ bob: 'invite' }) });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({});
    expect(eventId).toBeTruthy();
    expect(room.events.length).toBe(5);
  });
});

describe('accepting a submitted invite', () => {
  const INVITED = `@u_carol:${REMOTE}`;
  const INVITER = `@u_alice:${ALICE_SERVER}`;

  /** The invite the inviting server built: a membership event for a user of ours. */
  const inviteFor = (alice: ReturnType<typeof deployment>) => alice.sign({
    room_id: ROOM, type: 'm.room.member', sender: INVITER, state_key: INVITED, origin: ALICE_SERVER,
    origin_server_ts: NOW - 1_000, content: { membership: 'invite' }, depth: 6,
    prev_events: [ '$prev' ], auth_events: [ '$create', '$alice' ],
  });

  async function submitInvite(options: {
    /** Build the invite with the inviting server's identity; the default is a valid one. */
    build?: (alice: ReturnType<typeof deployment>) => Record<string, unknown>;
    eventId?: string;
    roomVersion?: string;
    inviteRoomState?: unknown;
    counterSign?: boolean;
    /** Whose keys the invited server holds: the real sender's, or its own (a forged sender). */
    signature?: 'sender' | 'ours';
  } = {}) {
    const alice = deployment(ALICE_SERVER);
    const event = options.build ? options.build(alice) : inviteFor(alice);
    // Our deployment adds the second signature; the first is verified against whoever signed it.
    const ours = deployment(REMOTE);
    const keysFor = options.signature === 'ours' ? ours : alice;
    return await handleMembershipSubmission({
      membership: 'invite',
      roomId: ROOM,
      eventId: options.eventId ?? computeEventId(event),
      event,
      origin: ALICE_SERVER,
      serverName: REMOTE,
      roomVersion: options.roomVersion ?? '11',
      keys: keysFor.source,
      ...(options.inviteRoomState === undefined ? {} : { inviteRoomState: options.inviteRoomState }),
      ...(options.counterSign === false ? {} : { counterSign: ours.identity }),
      now: () => NOW,
    });
  }

  it('adds this server\'s signature and answers with the event alone', async () => {
    let invited: Record<string, unknown> = {};
    const answer = await submitInvite({ build: alice => (invited = inviteFor(alice)) });

    expect(answer.status).toBe(200);
    const accepted = answer.body.event as Record<string, unknown>;
    expect(computeEventId(accepted)).toBe(computeEventId(invited));
    expect(Object.keys(accepted.signatures as Record<string, unknown>).sort()).toEqual([ ALICE_SERVER, REMOTE ]);
    // Nothing to show state for: the invited server does not know the room.
    expect('state' in answer.body).toBe(false);
    expect('auth_chain' in answer.body).toBe(false);
    expect(answer.warnings).toBeUndefined();
  });

  it('refuses an invite for somebody who is not one of its users', async () => {
    const answer = await submitInvite({ build: alice => ({ ...inviteFor(alice), state_key: `@u_dave:${ALICE_SERVER}` }) });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
    expect(String(answer.body.error)).toMatch(/not a user of remote\.example/u);
  });

  it('refuses an invite that is not a signed invite for a user of the sender', async () => {
    const wrongType = await submitInvite({ build: alice => ({ ...inviteFor(alice), type: 'm.room.name' }) });
    expect(String(wrongType.body.error)).toMatch(/m\.room\.member/u);

    const wrongMembership = await submitInvite({ build: alice => ({ ...inviteFor(alice), content: { membership: 'join' } }) });
    expect(String(wrongMembership.body.error)).toMatch(/membership is join/u);

    const forged = await submitInvite({ signature: 'ours' });
    expect(forged.status).toBe(400);
    expect(String(forged.body.error)).toMatch(/v11-2/u);

    const wrongId = await submitInvite({ eventId: '$not-this-event' });
    expect(String(wrongId.body.error)).toMatch(/request path/u);
  });

  it('cannot verify an event for a room version it does not implement', async () => {
    const answer = await submitInvite({ roomVersion: '10' });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ errcode: 'M_INCOMPATIBLE_ROOM_VERSION', room_version: '10' });
  });

  it('will not answer an invite it cannot sign', async () => {
    const answer = await submitInvite({ counterSign: false });
    expect(answer.status).toBe(500);
    expect(String(answer.body.error)).toMatch(/no signing identity/u);
  });

  it('reports invite_room_state problems instead of refusing the invite', async () => {
    const create = { type: 'm.room.create', state_key: '', sender: INVITER, content: { room_version: '11' } };
    const complete = await submitInvite({ inviteRoomState: [ create, { type: 'm.room.name', state_key: '', sender: INVITER, content: { name: 'Room' } } ] });
    expect(complete.status).toBe(200);
    expect(complete.warnings).toBeUndefined();

    // Matrix 1.16 requires the create event; for room version 11 the specification says to warn.
    const noCreate = await submitInvite({ inviteRoomState: [ { type: 'm.room.name', state_key: '', sender: INVITER, content: { name: 'Room' } } ] });
    expect(noCreate.status).toBe(200);
    expect(noCreate.warnings).toEqual([ expect.stringMatching(/create event/u) ]);

    const malformed = await submitInvite({ inviteRoomState: [ create, { type: 'm.room.name' }, 'nonsense' ] });
    expect(malformed.status).toBe(200);
    expect(malformed.warnings).toHaveLength(2);

    const notAList = await submitInvite({ inviteRoomState: { type: 'm.room.create' } });
    expect(notAList.status).toBe(200);
    expect(notAList.warnings).toEqual([ expect.stringMatching(/not an array/u) ]);
  });
});
