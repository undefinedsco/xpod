import { describe, expect, it, vi } from 'vitest';
import { MatrixError } from '../../../src/api/matrix/MatrixError';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';

const type = 'co.undefineds.membership.authority';
const binding = { purpose: 'membership', credentialRef: 'root-pointer', version: 1, issuer: 'https://issuer.example/' };

describe('root publication persisted winner before side effects', () => {
  it('rejects a same-id different-time winner before journal reference or outbound queue', async() => {
    const { store, context, db } = matrixHarness();
    const room = await store.createRoom({}, context);
    const eventId = '$root-winner-time';
    const timestamp = 1790985600000;
    const expected = { event_id: eventId, room_id: room.roomId, sender: context.webId, type,
      state_key: '', content: binding, origin_server_ts: timestamp, prev_events: [], auth_events: [],
      depth: 1, hashes: { sha256: 'root-fixed' }, signatures: {} };
    const winner = { eventId, roomId: room.roomId, sender: context.webId, type, stateKey: '',
      content: binding, originServerTs: timestamp + 1, role: 'system',
      event: { ...expected, origin_server_ts: timestamp + 1 } };
    const internal = store as unknown as {
      writeMessageRow: (...args: unknown[]) => Promise<boolean>;
      awaitCommittedWinner: (...args: unknown[]) => Promise<typeof winner>;
      queueFederationDelivery: (...args: unknown[]) => Promise<void>;
      journal: { registerReference: (...args: unknown[]) => Promise<unknown> };
      appendEvent: (database: unknown, input: unknown, caller: unknown, timeline: unknown[]) => Promise<unknown>;
    };
    vi.spyOn(internal, 'writeMessageRow').mockResolvedValue(true);
    vi.spyOn(internal, 'awaitCommittedWinner').mockResolvedValue(winner);
    const register = vi.spyOn(internal.journal, 'registerReference');
    const queue = vi.spyOn(internal, 'queueFederationDelivery').mockResolvedValue(undefined);
    const validateCommitted = async(record: typeof winner): Promise<void> => {
      if (record.originServerTs !== timestamp || record.event.origin_server_ts !== timestamp)
        throw new MatrixError(409, 'M_CONFLICT', 'Publication time changed');
    };
    // Isolate the production setState/project callback: the publisher port supplies its strict
    // validator, and append must run it before reference/queue effects rather than after returning.
    const publisher = { publish: async(_room: string, _value: unknown, caller: unknown, project: (input: unknown) => Promise<typeof winner>) => {
      const record = await project({ roomId: room.roomId, binding, context: caller,
        publication: { eventId, createdAt: timestamp, state: 'pending' },
        write: { db, fetch: async() => { throw new Error('Isolated decision fixture'); } },
        existingOnly: false, validateCommitted });
      await validateCommitted(record);
      return record;
    } };
    (store as unknown as { membershipAuthorityPublisher: typeof publisher }).membershipAuthorityPublisher = publisher;
    const promise = store.setState(room.roomId, type, '', binding, context);
    await expect(promise).rejects.toMatchObject({ status: 409 });
    expect(register).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });
});
