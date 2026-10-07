import { chatResource, messageResource, threadResource } from '@undefineds.co/models';
import { describe, expect, it } from 'vitest';
import { decodeSourceBoundRoomId, encodeSourceBoundRoomId } from '../../../src/api/matrix/canonicalRoomIdentity';
import { roomChatIri, roomMessagesDocumentIri, roomSurfaceId, roomThreadIri } from '../../../src/api/matrix/roomResources';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';

// Product layout regression only. The memory store is not an authorization or real-Pod proof.
describe('canonical room creation and public model layout', () => {
  it('names a new room by its actual source when Pod and participant hosts differ', async() => {
    const { store, context, rows } = matrixHarness({
      webId: 'https://alice.example/profile/card#me', podUrl: 'https://pod.example/alice/',
    });
    expect(new URL(context.webId).host).not.toBe(new URL(context.podUrl).host);
    const room = await store.createRoom({}, context);
    const chat = rows.get(chatResource)![0];
    const source = chatResource.buildIri(context.podUrl, { id: chat.id });
    expect(decodeSourceBoundRoomId(room.roomId)).toMatchObject({
      status: 'source-bound', canonicalChatIri: source,
    });
    expect(roomChatIri(context.podUrl, room.roomId)).toBe(source);
  });

  it('creates the author as a canonical owner without a parallel protocol member roster', async() => {
    const { store, context, rows } = matrixHarness();
    await store.createRoom({}, context);
    const chat = rows.get(chatResource)![0];
    expect(chat.author).toBe(context.webId);
    expect(chat.participants).toEqual([context.webId]);
    expect(chat.metadata.memberRoles).toEqual({ [context.webId]: 'owner' });
    expect(chat.metadata.protocols.matrix).not.toHaveProperty('members');
  });

  it('refuses a missing original Chat even when a hashed copy claims the same room', async() => {
    const { store, context, rows } = matrixHarness();
    const room = await store.createRoom({}, context);
    const original = rows.get(chatResource)![0];
    rows.set(chatResource, [{ ...structuredClone(original),
      id: chatResource.buildId({ id: roomSurfaceId(room.roomId) }),
    }]);
    await expect(store.getMembers(room.roomId, { ...context })).rejects.toMatchObject({ status: 404 });
  });

  it.each(['source-layout', 'a%2Fb'])('uses the exact encoded %s source for a local Chat and its thread', key => {
    const scope = 'https://pod.example/nested/alice/';
    const source = chatResource.buildIri(scope, { id: key });
    const roomId = encodeSourceBoundRoomId(source);
    expect(roomChatIri(scope, roomId)).toBe(source);
    expect(roomThreadIri(scope, roomId)).toBe(threadResource.buildIri(scope, { id: 'thread', parent: source }));
  });

  it.each(['source-layout', 'a%2Fb'])('derives the %s daily messages document from the actual local Chat parent', key => {
    const scope = 'https://pod.example/nested/alice/';
    const source = chatResource.buildIri(scope, { id: key });
    const roomId = encodeSourceBoundRoomId(source);
    const at = new Date('2026-10-03T00:00:00.000Z');
    const expected = messageResource.buildIri(scope, {
      id: 'message', parent: source, createdAt: at.toISOString(),
    }).split('#')[0];
    expect(roomMessagesDocumentIri(scope, roomId, at)).toBe(expected);
  });

  it('keeps a foreign source in a separate local display copy', () => {
    const sourceScope = 'https://pod.example/alice/';
    const localScope = 'https://pod.example/bob/';
    const source = chatResource.buildIri(sourceScope, { id: 'source-layout' });
    const roomId = encodeSourceBoundRoomId(source);
    const expected = chatResource.buildIri(localScope, { id: roomSurfaceId(roomId) });
    expect(roomChatIri(localScope, roomId)).toBe(expected);
    expect(roomChatIri(localScope, roomId)).not.toBe(source);
  });

  it('refuses malformed source-bound identity rather than assigning a display mirror layout', () => {
    expect(() => roomChatIri('https://pod.example/alice/', '!c1_not-base64url:pod.example')).toThrow();
  });
});
