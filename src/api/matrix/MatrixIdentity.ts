import { createHash } from 'node:crypto';

/**
 * Matrix-shaped stable identity for an exact Solid WebID.
 *
 * The localpart is a one-way hash of the complete WebID, so two fragments on
 * the same document stay different principals. A hash cannot be inverted:
 * callers that need the full WebID for routing must supply and verify it
 * explicitly instead of deriving it from an MXID.
 */
export function matrixUserIdForWebId(webId: string, serverName: string): string {
  if (!webId || webId !== webId.trim() || /[\s\u0000-\u001f\u007f]/u.test(webId)) {
    throw new Error('Invalid WebID for Matrix identity');
  }
  if (!isMatrixServerName(serverName)) {
    throw new Error('Invalid Matrix server name');
  }
  const localpart = `u_${createHash('sha256').update(webId).digest('hex')}`;
  return `@${localpart}:${serverName}`;
}

/**
 * Matrix server name / authority: host[:port], with an optional bracketed IPv6
 * literal. A port and IPv6 are legitimate (localhost:3000, [::1]:3000); paths,
 * userinfo, whitespace and separators that could inject MXID syntax are not.
 */
export function isMatrixServerName(value: string): boolean {
  if (!value || value !== value.trim() || /[\s@/?#\\]/u.test(value) || value.includes('://')) return false;
  if (value.startsWith('[')) {
    return /^\[[0-9a-fA-F:.]+\](?::\d{1,5})?$/u.test(value);
  }
  const match = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/u.exec(value);
  return match !== null;
}

/**
 * Whether a supplied MXID is the Matrix projection of this exact WebID on the
 * canonical server identity. This is the only accepted mapping; because the
 * localpart is a hash, matching a raw WebID string against an MXID is never
 * treated as proof.
 */
export function isMatrixUserIdForWebId(userId: string, webId: string, serverName: string): boolean {
  if (!/^@[^:]+:.+$/u.test(userId) || userId !== userId.trim()) {
    return false;
  }
  try {
    return userId === matrixUserIdForWebId(webId, serverName);
  } catch {
    return false;
  }
}

/** Structural MXID check used by the legacy invite path. */
export function isMatrixUserId(userId: unknown): userId is string {
  return typeof userId === 'string' && /^@[^:]+:.+$/u.test(userId) && userId === userId.trim();
}

/**
 * Event type carrying verified room-storage provenance in invite_state:
 * `{ storage, room_container, verified: true }`.
 *
 * `storage` is always the canonical Pod root (the value a client may send as
 * X-Xpod-Pod-Url). `room_container` is the room's canonical container IRI on
 * that Pod; clients open it to enter the shared room preview. Both come from
 * persisted models layout, never from request input.
 */
export const MATRIX_STORAGE_BINDING_EVENT_TYPE = 'co.undefineds.matrix.storage_binding';
