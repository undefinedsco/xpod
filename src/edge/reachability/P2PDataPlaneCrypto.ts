import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for the raw TCP data plane (audit N03).
 *
 * The data plane used to be plaintext JSON over a hole-punched TCP socket: anyone who could
 * reach the port could read, forge or replay Pod traffic, and the node could not tell which
 * session a connection belonged to. Both sides now share a per-session secret that travels
 * only over the authenticated signaling API, derive direction-separated keys from it, and seal
 * every frame with AES-256-GCM — so a peer without the secret cannot produce a frame the other
 * side accepts, and a frame cannot be replayed into a different session or direction.
 */

export const P2P_DATA_PLANE_KEY_BYTES = 32;
export const P2P_DATA_PLANE_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const HKDF_SALT = 'xpod-p2p-data-plane/v1';

/** Distinct from protocol errors so callers can close the connection instead of retrying. */
export class P2PDataPlaneSecurityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'P2PDataPlaneSecurityError';
  }
}

export type P2PDataPlaneDirection = 'client-to-server' | 'server-to-client';

export interface P2PDataPlaneKeys {
  clientToServer: Buffer;
  serverToClient: Buffer;
}

/** A fresh per-session secret, base64 so it can travel inside the session record. */
export function createDataPlaneSecret(): string {
  return randomBytes(P2P_DATA_PLANE_KEY_BYTES).toString('base64');
}

/** Decode a session secret, rejecting anything that is not exactly one key long. */
export function decodeDataPlaneSecret(value: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new P2PDataPlaneSecurityError('Data plane secret is missing');
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    throw new P2PDataPlaneSecurityError('Data plane secret is not valid base64');
  }
  if (decoded.byteLength !== P2P_DATA_PLANE_KEY_BYTES) {
    throw new P2PDataPlaneSecurityError(
      `Data plane secret must be ${P2P_DATA_PLANE_KEY_BYTES} bytes, got ${decoded.byteLength}`,
    );
  }
  return decoded;
}

export function createDataPlaneNonce(): Buffer {
  return randomBytes(P2P_DATA_PLANE_NONCE_BYTES);
}

/**
 * Direction-separated keys.
 *
 * Both nonces and the session id go into the derivation, so a frame sealed for one session (or
 * for one direction inside it) cannot be replayed into another.
 */
export function deriveDataPlaneKeys(
  secret: Buffer,
  sessionId: string,
  clientNonce: Buffer,
  serverNonce: Buffer,
): P2PDataPlaneKeys {
  const derive = (direction: P2PDataPlaneDirection): Buffer => Buffer.from(hkdfSync(
    'sha256',
    secret,
    Buffer.concat([ Buffer.from(HKDF_SALT), clientNonce, serverNonce ]),
    Buffer.from(`${sessionId}|${direction}`),
    P2P_DATA_PLANE_KEY_BYTES,
  ));
  return {
    clientToServer: derive('client-to-server'),
    serverToClient: derive('server-to-client'),
  };
}

export function keyForDirection(keys: P2PDataPlaneKeys, direction: P2PDataPlaneDirection): Buffer {
  return direction === 'client-to-server' ? keys.clientToServer : keys.serverToClient;
}

function additionalData(sessionId: string, direction: P2PDataPlaneDirection, sequence: number): Buffer {
  return Buffer.from(`${sessionId}|${direction}|${sequence}`);
}

export interface SealedDataPlaneFrame {
  /** Monotonic per direction: the receiver refuses anything but the next value, so replays fail. */
  sequence: number;
  nonce: string;
  ciphertext: string;
}

export function sealDataPlaneFrame(
  key: Buffer,
  sessionId: string,
  direction: P2PDataPlaneDirection,
  sequence: number,
  plaintext: Buffer,
): SealedDataPlaneFrame {
  const nonce = createDataPlaneNonce();
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(additionalData(sessionId, direction, sequence));
  const ciphertext = Buffer.concat([ cipher.update(plaintext), cipher.final(), cipher.getAuthTag() ]);
  return {
    sequence,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function openDataPlaneFrame(
  key: Buffer,
  sessionId: string,
  direction: P2PDataPlaneDirection,
  sealed: SealedDataPlaneFrame,
  expectedSequence: number,
): Buffer {
  if (sealed.sequence !== expectedSequence) {
    throw new P2PDataPlaneSecurityError(
      `Data plane frame out of order: expected ${expectedSequence}, got ${String(sealed.sequence)}`,
    );
  }
  const nonce = Buffer.from(sealed.nonce, 'base64');
  if (nonce.byteLength !== P2P_DATA_PLANE_NONCE_BYTES) {
    throw new P2PDataPlaneSecurityError('Data plane frame nonce has the wrong length');
  }
  const payload = Buffer.from(sealed.ciphertext, 'base64');
  if (payload.byteLength < GCM_TAG_BYTES) {
    throw new P2PDataPlaneSecurityError('Data plane frame is too short to be authentic');
  }
  const ciphertext = payload.subarray(0, payload.byteLength - GCM_TAG_BYTES);
  const tag = payload.subarray(payload.byteLength - GCM_TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(additionalData(sessionId, direction, sealed.sequence));
    decipher.setAuthTag(tag);
    return Buffer.concat([ decipher.update(ciphertext), decipher.final() ]);
  } catch {
    // Authentication failed: wrong key, tampered frame, or a frame from another session.
    throw new P2PDataPlaneSecurityError('Data plane frame failed authentication');
  }
}
