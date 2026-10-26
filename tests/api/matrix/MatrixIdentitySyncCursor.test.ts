import { describe, expect, it } from 'vitest';
import {
  isMatrixUserId,
  isMatrixUserIdForWebId,
  matrixUserIdForWebId,
} from '../../../src/api/matrix/MatrixIdentity';
import { encodeSyncCursor, parseSyncCursor } from '../../../src/api/matrix/MatrixSyncCursor';

const webId = 'https://id.example/people/bob#me';
const other = 'https://id.example/people/bob#other';

describe('Matrix identity mapping', () => {
  it('maps the full WebID to a one-way MXID on the canonical server name', () => {
    const userId = matrixUserIdForWebId(webId, 'example.test');
    expect(userId).toMatch(/^@u_[0-9a-f]{64}:example\.test$/u);
    expect(userId).not.toContain('bob');
    expect(isMatrixUserIdForWebId(userId, webId, 'example.test')).toBe(true);
  });

  it('distinguishes fragments on the same document and other server names', () => {
    const userId = matrixUserIdForWebId(webId, 'example.test');
    expect(isMatrixUserIdForWebId(userId, other, 'example.test')).toBe(false);
    expect(isMatrixUserIdForWebId(userId, webId, 'other.test')).toBe(false);
    expect(matrixUserIdForWebId(other, 'example.test')).not.toBe(userId);
  });

  it('never treats a raw WebID or malformed MXID as an encoded identity', () => {
    expect(isMatrixUserId(webId)).toBe(false);
    expect(isMatrixUserId('@u_alice:example.test')).toBe(true);
    expect(isMatrixUserId(' @u_alice:example.test')).toBe(false);
    expect(isMatrixUserIdForWebId('@u_alice:example.test', webId, 'example.test')).toBe(false);
    expect(() => matrixUserIdForWebId('not a web id', 'example.test')).toThrow();
    expect(() => matrixUserIdForWebId(webId, 'bad/name')).toThrow();
  });
});

describe('Matrix sync cursors', () => {
  it('keeps per-storage journal sequences separate and order-independent', () => {
    const token = encodeSyncCursor({
      version: 3,
      local: 5,
      invites: 2,
      rooms: { 'https://b.pod.example/': 9, 'https://a.pod.example/': 120 },
    });
    expect(parseSyncCursor(token)).toEqual({
      version: 3,
      local: 5,
      invites: 2,
      rooms: { 'https://a.pod.example/': 120, 'https://b.pod.example/': 9 },
      roomSequences: {},
      bindings: {},
    });
    // A huge remote sequence never inflates the local Pod cursor.
    expect(parseSyncCursor(token).local).toBe(5);
  });

  it('reads legacy v2 cursors as the same Pod journal position', () => {
    expect(parseSyncCursor('v2_42')).toEqual({ version: 3, local: 42, invites: 0, rooms: {}, roomSequences: {}, bindings: {} });
  });

  it.each(['v1_1', 'v3.', 'v3.bm90LWpzb24', 'v3.' + Buffer.from(JSON.stringify({ local: -1, invites: 0, rooms: {} })).toString('base64url')])(
    'rejects an unsupported or malformed cursor %s',
    token => {
      expect(() => parseSyncCursor(token)).toThrowError(/Cursor version changed/u);
    },
  );

  it('rejects a cursor with a non-canonical storage key', () => {
    const token = `v3.${Buffer.from(JSON.stringify({
      local: 0, invites: 0, rooms: { 'not-a-url': 3 },
    })).toString('base64url')}`;
    expect(() => parseSyncCursor(token)).toThrowError(/Cursor version changed/u);
  });
});
