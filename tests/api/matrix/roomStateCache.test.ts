import { describe, expect, it } from 'vitest';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';

describe('resolved state memoization', () => {
  it('answers repeat reads from memory while the room is unchanged', async () => {
    const { store, context } = matrixHarness();
    const room = await store.createRoom({}, context);
    const first = await store.currentState(room.roomId, context);
    const second = await store.currentState(room.roomId, context);
    // Same events, so the same resolved state object: the replay happened once.
    expect(second).toBe(first);
  });

  it('never serves a state that predates a write', async () => {
    const { store, context } = matrixHarness();
    const room = await store.createRoom({ name: 'Before' }, context);
    const before = await store.currentState(room.roomId, context);

    await store.setState(room.roomId, 'm.room.name', '', { name: 'After' }, context);
    const afterState = await store.currentState(room.roomId, context);
    expect(afterState).not.toBe(before);
    expect(afterState.get('m.room.name')?.content.name).toBe('After');

    // A timeline event changes the room too, so the memo must not survive it.
    const afterStateAgain = await store.currentState(room.roomId, context);
    expect(afterStateAgain).toBe(afterState);
    await store.sendEvent(room.roomId, 'm.room.message', 'after-name', { body: 'hi' }, context);
    const afterMessage = await store.currentState(room.roomId, context);
    expect(afterMessage).not.toBe(afterState);
    expect(afterMessage.get('m.room.name')?.content.name).toBe('After');
  });

  it('keeps rooms apart', async () => {
    const { store, context } = matrixHarness();
    const first = await store.createRoom({ name: 'One' }, context);
    const second = await store.createRoom({ name: 'Two' }, context);
    await store.setState(first.roomId, 'm.room.topic', '', { topic: 'first room' }, context);

    expect((await store.currentState(first.roomId, context)).get('m.room.topic')?.content.topic).toBe('first room');
    expect((await store.currentState(second.roomId, context)).get('m.room.topic')).toBeUndefined();
    // Re-reading the first room still answers correctly after the second was resolved.
    expect((await store.currentState(first.roomId, context)).get('m.room.name')?.content.name).toBe('One');
  });

  it('stays correct after many rooms have been resolved', async () => {
    const { store, context } = matrixHarness();
    const rooms = [];
    for (let index = 0; index < 70; index += 1) {
      rooms.push(await store.createRoom({ name: `Room ${index}` }, context));
    }
    // The cache is bounded, so early rooms have been evicted by now; they must still
    // resolve correctly rather than returning a neighbour's state.
    const first = await store.currentState(rooms[0].roomId, context);
    expect(first.get('m.room.name')?.content.name).toBe('Room 0');
    const last = await store.currentState(rooms[69].roomId, context);
    expect(last.get('m.room.name')?.content.name).toBe('Room 69');
    expect(first).not.toBe(last);
  });

  it('can be switched off or bounded, and stays correct either way', async () => {
    // Every store reads the Pod through the same context, so they share one room store.
    const { context } = matrixHarness();
    const uncached = new PodMatrixStore({ serverName: 'example.test', stateCacheLimit: 0 });
    const uncachedRoom = await uncached.createRoom({ name: 'Uncached' }, context);
    const firstRead = await uncached.currentState(uncachedRoom.roomId, context);
    const secondRead = await uncached.currentState(uncachedRoom.roomId, context);
    // No memo, so a fresh object each time — with the same contents.
    expect(secondRead).not.toBe(firstRead);
    expect(secondRead.get('m.room.name')?.content.name).toBe('Uncached');

    // A bound of one evicts the previous room rather than growing without limit.
    const bounded = new PodMatrixStore({ serverName: 'example.test', stateCacheLimit: 1 });
    const roomA = await bounded.createRoom({ name: 'A' }, context);
    const roomB = await bounded.createRoom({ name: 'B' }, context);
    const aFirst = await bounded.currentState(roomA.roomId, context);
    await bounded.currentState(roomB.roomId, context);
    const aSecond = await bounded.currentState(roomA.roomId, context);
    expect(aSecond).not.toBe(aFirst);
    expect(aSecond.get('m.room.name')?.content.name).toBe('A');

    expect(() => new PodMatrixStore({ serverName: 'example.test', stateCacheLimit: -1 })).toThrow(/stateCacheLimit/u);
  });

  it('lets membership checks and the member list share one answer', async () => {
    const { store, context } = matrixHarness();
    const room = await store.createRoom({}, context);
    const bobContext = { ...context, webId: 'https://bob.example/profile/card#me' };
    const bob = (await store.getAccount(bobContext)).userId;
    await store.inviteUser(room.roomId, bob, context);
    await store.joinRoom(room.roomId, bobContext);

    const members = await store.getMembers(room.roomId, context);
    expect(members.filter(event => event.content.membership === 'join')).toHaveLength(2);
    // A write from a joined member still passes the gate after the reads above.
    const sent = await store.sendEvent(room.roomId, 'm.room.message', 'after-reads', { body: 'ok' }, bobContext);
    expect(sent.sender).toBe(bob);
  });
});
