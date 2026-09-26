import { describe, expect, it } from 'vitest';
import {
  assertBinding,
  bindMatrixIdentity,
  bindingAllowsWrites,
  confirmMatrixIdentityBinding,
  createMatrixIdentityBinding,
  decodeMatrixIdentityBinding,
  encodeMatrixIdentityBinding,
  freshestMatrixIdentityBinding,
  isStaleBinding,
} from '../../../src/api/matrix/identityBinding';

const WEBID = 'https://alice.example/profile/card#me';
const MXID = '@u_abc:alice.example';
const POD_A = 'https://pod-a.example/alice';
const POD_B = 'https://pod-b.example/alice';

function bound(podUrl = POD_A, now = 1_000) {
  return createMatrixIdentityBinding({ webId: WEBID, matrixUserId: MXID, serverName: 'alice.example', podUrl, now: () => now });
}

describe('Matrix identity binding', () => {
  it('starts active at version 1 and normalizes the Pod URL', () => {
    const binding = bound();
    expect(binding).toMatchObject({ version: 1, status: 'active', podUrl: `${POD_A}/` });
    expect(binding.webId).toBe(WEBID);
  });

  it('binds idempotently: the same Pod and server do not churn versions', () => {
    const first = bound();
    const again = bindMatrixIdentity(first, {
      webId: WEBID, matrixUserId: MXID, serverName: 'alice.example', podUrl: `${POD_A}/`, now: () => 9_000,
    });
    expect(again).toBe(first);
  });

  it('marks a Pod move pending, then active once the new Pod confirms', () => {
    const first = bound();
    const moved = bindMatrixIdentity(first, {
      webId: WEBID, matrixUserId: MXID, serverName: 'alice.example', podUrl: POD_B, now: () => 2_000,
    });
    expect(moved).toMatchObject({ version: 2, status: 'pending', podUrl: `${POD_B}/` });
    expect(moved.updatedAt).toBe(new Date(2_000).toISOString());

    // A confirmation that names another Pod would confirm a move nobody started.
    expect(() => confirmMatrixIdentityBinding(moved, { podUrl: POD_A })).toThrow(/points at/u);
    const confirmed = confirmMatrixIdentityBinding(moved, { podUrl: POD_B, now: () => 3_000 });
    expect(confirmed).toMatchObject({ version: 2, status: 'active' });
    // Confirming an active binding is a no-op.
    expect(confirmMatrixIdentityBinding(confirmed, { podUrl: POD_B })).toBe(confirmed);
  });

  it('refuses to bind one identity onto another record', () => {
    const first = bound();
    expect(() => bindMatrixIdentity(first, {
      webId: 'https://bob.example/profile/card#me', matrixUserId: MXID, serverName: 'alice.example', podUrl: POD_B,
    })).toThrow(/is for/u);
    expect(() => bindMatrixIdentity(first, {
      webId: WEBID, matrixUserId: '@u_other:bob.example', serverName: 'alice.example', podUrl: POD_B,
    })).toThrow(/does not match/u);
  });

  it('treats a writer that remembers an older version or Pod as stale', () => {
    const first = bound();
    const moved = bindMatrixIdentity(first, {
      webId: WEBID, matrixUserId: MXID, serverName: 'alice.example', podUrl: POD_B,
    });
    expect(isStaleBinding(first, first)).toBe(false);
    expect(bindingAllowsWrites(first, first)).toBe(true);
    // Once the switch is recorded, the writer holding version 1 must refresh.
    expect(isStaleBinding(first, moved)).toBe(true);
    expect(bindingAllowsWrites(first, moved)).toBe(false);
    expect(bindingAllowsWrites(moved, moved)).toBe(true);
    // A same-version record naming another Pod is stale too: the Pod is half the fact.
    expect(isStaleBinding(first, { ...first, podUrl: `${POD_B}/` })).toBe(true);
  });

  it('picks the higher version when two Pods hold different records', () => {
    const first = bound();
    const moved = bindMatrixIdentity(first, {
      webId: WEBID, matrixUserId: MXID, serverName: 'alice.example', podUrl: POD_B,
    });
    expect(freshestMatrixIdentityBinding(first, moved)).toBe(moved);
    expect(freshestMatrixIdentityBinding(moved, first)).toBe(moved);
    expect(freshestMatrixIdentityBinding(undefined, first)).toBe(first);
    expect(freshestMatrixIdentityBinding(first, undefined)).toBe(first);
  });

  it('round-trips and rejects a record that could not be trusted', () => {
    const binding = bound();
    expect(decodeMatrixIdentityBinding(encodeMatrixIdentityBinding(binding))).toEqual(binding);
    expect(() => decodeMatrixIdentityBinding('not json')).toThrow(/not valid JSON/u);
    expect(() => assertBinding({ ...binding, version: 0 })).toThrow(/positive integer version/u);
    expect(() => assertBinding({ ...binding, status: 'migrating' })).toThrow(/unknown status/u);
    expect(() => assertBinding({ ...binding, podUrl: '' })).toThrow(/non-empty podUrl/u);
    expect(() => assertBinding({ ...binding, serviceAuthorization: 7 })).toThrow(/serviceAuthorization/u);
    expect(() => createMatrixIdentityBinding({ webId: ' ', matrixUserId: MXID, serverName: 'alice.example', podUrl: POD_A }))
      .toThrow(/WebID/u);
  });
});
