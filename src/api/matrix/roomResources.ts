/**
 * Where a room's documents live in a Pod.
 *
 * The layout is models': a room is a directory (`…/.data/chat/<surface>/`) holding its chat
 * document (`index.ttl`, with `#this` and `#thread`) and one messages document per day
 * (`YYYY/MM/DD/messages.ttl`) whose rows are the events. Xpod only writes values into that
 * layout, so these builders are the single place that knows it — the store, the change
 * watcher and any peer-facing signal all derive the same IRIs from here.
 *
 * A source-bound room id (`!c1_…`, see `canonicalRoomIdentity`) names the **exact** canonical Chat
 * the room is bound to. When that source belongs to the scope we are addressing, the local
 * documents must be that very source (so reads/updates address the original), not a hashed copy.
 * A foreign source (the room lives in somebody else's Pod) is kept as a local hashed **display
 * copy**. A malformed `!c1_` id throws: it never silently becomes a different room.
 *
 * The surface id is still used for legacy/hashed layout names, derived from the room id (never the
 * other way round): it is a layout name, and two deployments that derive it differently would still
 * agree on `room_id`, which is what the protocol carries.
 */
import { createHash } from 'node:crypto';
import { chatResource, messageResource, threadResource } from '@undefineds.co/models';
import {
  decodeSourceBoundRoomId,
  validateCanonicalChatIri,
} from './canonicalRoomIdentity';

/** The directory name a legacy/hashed room's documents live under. */
export function roomSurfaceId(roomId: string): string {
  return `matrix-${createHash('sha256').update(roomId).digest('hex').slice(0, 16)}`;
}

/**
 * The exact canonical source IRI a source-bound room id names, validated against `scope`. Returns
 * `undefined` for a foreign source (a different registered root) and `null` for a malformed `!c1_`
 * id, so callers can distinguish "display copy" from "refuse".
 */
function ownSourceForScope(scope: string, roomId: string): string | undefined | null {
  let decoded;
  try {
    decoded = decodeSourceBoundRoomId(roomId);
  } catch {
    // A malformed `!c1_` id must never fall back to a hashed display layout.
    return null;
  }
  if (decoded.status !== 'source-bound') {
    return undefined;
  }
  const source = decoded.canonicalChatIri;
  try {
    return validateCanonicalChatIri(source, scope) ? source : undefined;
  } catch {
    return undefined;
  }
}

/** The room's chat document, including the `#this` fragment. */
export function roomChatIri(scope: string, roomId: string): string {
  const own = ownSourceForScope(scope, roomId);
  if (own === null) {
    throw new Error('A malformed source-bound room id cannot be laid out');
  }
  if (own !== undefined) {
    return own;
  }
  return chatResource.buildIri(scope, { id: roomSurfaceId(roomId) });
}

/** The room's thread, a fragment of the chat document, built from the actual local Chat parent. */
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
 * appended, and therefore the topic to watch for that room. The parent is the **actual local Chat
 * IRI** — the original source for an own room, the hashed display copy for a foreign one — never a
 * synthetic `layout.invalid` placeholder.
 */
export function roomMessagesDocumentIri(scope: string, roomId: string, at: Date | number): string {
  const createdAt = typeof at === 'number' ? new Date(at) : at;
  const iri = messageResource.buildIri(scope, {
    // The row id is a fragment; the document is the same for every event of that day.
    id: 'document',
    parent: roomChatIri(scope, roomId),
    createdAt: createdAt.toISOString(),
  });
  const hash = iri.indexOf('#');
  return hash < 0 ? iri : iri.slice(0, hash);
}
