import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { joinRoomOverFederation } from '../../../../src/api/matrix/federation/remoteJoin';
import { computeEventId, decodeVerifyKey, redactEvent, verifyJson } from '../../../../src/api/matrix/protocol/eventIntegrity';
import { MatrixServiceIdentity } from '../../../../src/api/matrix/protocol/serviceIdentity';
import type { MembershipTemplateOutcome, SendJoinOutcome } from '../../../../src/api/matrix/federation/outboundTransaction';

const ROOM = '!r:alice.example';
const ALICE_SERVER = 'alice.example';
const US = 'bob.example';
const BOB = `@u_bob:${US}`;
const NOW = 1_700_000_000_000;

/** The joining deployment: a real identity, because signing is part of what is under test. */
function identity() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return new MatrixServiceIdentity({ serverName: US, activeKey: { keyId: 'ed25519:1', privateKeyPem }, now: () => NOW });
}

/** The template a resident server hands out: the room's graph position, filled in by us. */
function template(overrides: Record<string, unknown> = {}) {
  return {
    room_id: ROOM, type: 'm.room.member', sender: BOB, state_key: BOB,
    content: { membership: 'join' }, depth: 4, prev_events: [ '$prev' ], auth_events: [ '$create', '$rules' ],
    ...overrides,
  };
}

function client(options: {
  makeJoin?: MembershipTemplateOutcome;
  sendJoin?: SendJoinOutcome;
} = {}) {
  const makeJoin = vi.fn(async (): Promise<MembershipTemplateOutcome> => options.makeJoin
    ?? { status: 'ok', roomVersion: '11', event: template(), reason: 'ok' });
  const sendJoin = vi.fn(async (input: { eventId: string; event: Record<string, unknown> }): Promise<SendJoinOutcome> =>
    options.sendJoin ?? {
      status: 'ok',
      state: [ { event_id: '$create' }, { event_id: '$rules' } ],
      authChain: [ { event_id: '$create' } ],
      // The resident adds its signature to ours; it does not replace it.
      event: {
        ...input.event,
        signatures: {
          ...(input.event.signatures as Record<string, unknown>),
          [ALICE_SERVER]: { 'ed25519:1': 'theirs' },
        },
      },
      reason: 'ok',
    });
  return { makeJoin, sendJoin };
}

describe('joining a room another deployment hosts', () => {
  it('asks for a template, fills in only the sender\'s own facts, signs it and submits it', async () => {
    const ours = identity();
    const handshake = client();
    const outcome = await joinRoomOverFederation({
      client: handshake, roomId: ROOM, userId: BOB, destination: ALICE_SERVER, serverName: US,
      sign: event => ours.signEvent(event), now: () => NOW,
    });

    expect(outcome.status).toBe('joined');
    // The version this deployment implements is what it offers to support.
    expect(handshake.makeJoin).toHaveBeenCalledWith({
      destination: ALICE_SERVER, roomId: ROOM, userId: BOB, versions: [ '11' ],
    });

    const submitted = handshake.sendJoin.mock.calls[0][0];
    // What we added: our name and our clock. What we kept: the resident's graph position.
    expect(submitted.event).toMatchObject({
      origin: US,
      origin_server_ts: NOW,
      depth: 4,
      prev_events: [ '$prev' ],
      auth_events: [ '$create', '$rules' ],
      room_id: ROOM,
      sender: BOB,
      state_key: BOB,
      content: { membership: 'join' },
    });
    // The event id is derived from the signed event, not taken from anywhere, and the submission
    // names the same id.
    expect(submitted.eventId).toBe(computeEventId(submitted.event));
    expect(computeEventId(submitted.event)).toBe(computeEventId({ ...template(), origin: US, origin_server_ts: NOW,
      hashes: submitted.event.hashes, signatures: submitted.event.signatures }));
    expect(Object.keys(submitted.event.signatures as Record<string, unknown>)).toEqual([ US ]);

    if (outcome.status !== 'joined') throw new Error(outcome.reason);
    // The answer is what a caller stores in the joining participant's Pod.
    expect(outcome.state.map(event => String(event.event_id))).toEqual([ '$create', '$rules' ]);
    expect(outcome.authChain.map(event => String(event.event_id))).toEqual([ '$create' ]);
    // And the event it hands on carries the resident's signature too.
    expect(Object.keys(outcome.event.signatures as Record<string, unknown>).sort()).toEqual([ ALICE_SERVER, US ].sort());
  });

  it('submits nothing when the template is not for the request that was made', async () => {
    const ours = identity();
    // The client discards a template for another room, user, membership or version before returning
    // it, and there is nothing to sign — asking another resident may still work.
    const handshake = client({ makeJoin: { status: 'rejected', reason: 'the template is for room !other:x.example' } });
    const outcome = await joinRoomOverFederation({
      client: handshake, roomId: ROOM, userId: BOB, destination: ALICE_SERVER, serverName: US,
      sign: event => ours.signEvent(event),
    });

    expect(outcome).toEqual({ status: 'rejected', reason: 'the template is for room !other:x.example' });
    expect(handshake.sendJoin).not.toHaveBeenCalled();
  });

  it('keeps a retryable answer retryable, and a refusal final', async () => {
    const ours = identity();
    const retry = client({ makeJoin: { status: 'retry', reason: 'cannot resolve alice.example' } });
    await expect(joinRoomOverFederation({
      client: retry, roomId: ROOM, userId: BOB, destination: ALICE_SERVER, serverName: US,
      sign: event => ours.signEvent(event),
    })).resolves.toMatchObject({ status: 'retry' });

    const refused = client({ sendJoin: { status: 'rejected', reason: 'the room does not permit joining' } });
    await expect(joinRoomOverFederation({
      client: refused, roomId: ROOM, userId: BOB, destination: ALICE_SERVER, serverName: US,
      sign: event => ours.signEvent(event),
    })).resolves.toEqual({ status: 'rejected', reason: 'the room does not permit joining' });
  });

  it('signs the event as the identity it was given', async () => {
    const ours = identity();
    const handshake = client();
    await joinRoomOverFederation({
      client: handshake, roomId: ROOM, userId: BOB, destination: ALICE_SERVER, serverName: US,
      sign: event => ours.signEvent(event), now: () => NOW,
    });

    // The signature is the caller's, over the redacted event, and it verifies with the key that
    // identity publishes — which is what a resident server will check when it receives the join.
    const submitted = handshake.sendJoin.mock.calls[0][0];
    const published = ours.serverKeyResponse().verify_keys as Record<string, { key: string }>;
    expect(verifyJson(redactEvent(submitted.event), US, 'ed25519:1', decodeVerifyKey(published['ed25519:1'].key))).toBe(true);
    // And not with somebody else's key.
    const other = identity();
    const theirs = other.serverKeyResponse().verify_keys as Record<string, { key: string }>;
    expect(verifyJson(redactEvent(submitted.event), US, 'ed25519:1', decodeVerifyKey(theirs['ed25519:1'].key))).toBe(false);
  });
});
