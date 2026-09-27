/**
 * Where a room's documents live in a Pod.
 *
 * The layout is models': a room is a directory (`…/.data/chat/<surface>/`) holding its chat
 * document (`index.ttl`, with `#this` and `#thread`) and one messages document per day
 * (`YYYY/MM/DD/messages.ttl`) whose rows are the events. Xpod only writes values into that
 * layout, so these builders are the single place that knows it — the store, the change
 * watcher and any peer-facing signal all derive the same IRIs from here.
 *
 * The surface id is derived from the room id (never the other way round): it is a layout
 * name, and two deployments that derive it differently would still agree on `room_id`, which
 * is what the protocol carries.
 */
import { createHash } from 'node:crypto';
import { chatResource, messageResource, threadResource } from '@undefineds.co/models';

/** The directory name a room's documents live under. */
export function roomSurfaceId(roomId: string): string {
  return `matrix-${createHash('sha256').update(roomId).digest('hex').slice(0, 16)}`;
}

/** The room's chat document, including the `#this` fragment. */
export function roomChatIri(scope: string, roomId: string): string {
  return chatResource.buildIri(scope, { id: roomSurfaceId(roomId) });
}

/** The room's thread, a fragment of the chat document. */
export function roomThreadIri(scope: string, roomId: string): string {
  return threadResource.buildIri(scope, { id: 'thread', parent: roomChatIri(scope, roomId) });
}

/** The directory that holds a room's documents: the chat document's container. */
export function roomDirectoryIri(scope: string, roomId: string): string {
  const document = roomChatIri(scope, roomId).split('#')[0];
  // `…/chat/<surface>/index.ttl` -> `…/chat/<surface>/`
  const lastSlash = document.lastIndexOf('/');
  return lastSlash < 0 ? document : document.slice(0, lastSlash + 1);
}

/**
 * The messages document for one day of one room: the resource that changes when an event is
 * appended, and therefore the topic to watch for that room.
 */
export function roomMessagesDocumentIri(scope: string, roomId: string, at: Date | number): string {
  const createdAt = typeof at === 'number' ? new Date(at) : at;
  const iri = messageResource.buildIri(scope, {
    // The row id is a fragment; the document is the same for every event of that day.
    id: 'document',
    parent: chatResource.buildIri('https://layout.invalid/', { id: roomSurfaceId(roomId) }),
    createdAt: createdAt.toISOString(),
  });
  const hash = iri.indexOf('#');
  return hash < 0 ? iri : iri.slice(0, hash);
}
