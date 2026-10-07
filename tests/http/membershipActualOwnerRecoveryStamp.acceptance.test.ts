// Root-owned owner recovery admission/generation foundation; actual fixture principals
// and Comunica do not prove Gateway DPoP, QLever, actor PDU or complete crash recovery.
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DataFactory } from 'n3';
import { actualMembershipAcpFixture } from '../helpers/ActualMembershipWacFixture';
import { applyMembershipReadDelta } from '../../src/api/matrix/membershipPolicyMutation';
import { expectedGroundDigest, expectedSourceDigest } from '../helpers/GuardedPolicyClosureFixture';

const operationId = '$root-owner-recovery-original-join';
const guarded = 'application/vnd.xpod.guarded-sparql-update+json';
type Fixture = Parameters<Parameters<typeof actualMembershipAcpFixture>[0]>[0];
async function pending(f: Fixture) {
  const port = await f.membership.openForJoin(f.roomId, f.actorContext);
  return await port.reserveJoin(await port.readCurrent(), { operationId, createdAt: 20 });
}
async function newBinding(f: Fixture, owner = f.owner, issuer = f.origin) {
  const grant = await f.credentials.grant({ credentialRef: `urn:root:recovery:${randomUUID()}`, ownerWebId: owner, issuer,
    clientId: 'root-recovery-named', clientSecret: 'root-recovery-fixture-secret', status: 'active' });
  return { purpose: 'membership' as const, credentialRef: grant.credentialRef, version: grant.version, issuer };
}
async function head(f: Fixture) {
  const response = await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': f.actor } });
  await response.arrayBuffer(); return response.status;
}

describe('root actual original-owner recovery stamp foundation', () => {
  it('records only the recovery stamp under a new current named lease and preserves original intent and source', async () => {
    await actualMembershipAcpFixture(async f => {
      const state = await pending(f);
      const before = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      const policy = await f.policyBody(f.podAcl);
      const binding = await newBinding(f);
      await f.credentials.revoke(f.binding.credentialRef);
      const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      expect(owner.actor).toEqual({ webId: f.owner, podUrl: f.pod });
      const expected = await owner.readCurrent();
      f.native.mockClear();
      const stamped = await owner.beginOwnerRecovery(expected, operationId, { generation: 1, binding });
      expect(f.native).toHaveBeenCalledTimes(1);
      expect(stamped.facts.membershipOperation).toEqual({ ...state.facts.membershipOperation,
        ownerRecovery: { generation: 1, binding } });
      expect(stamped.facts.participants).toEqual(state.facts.participants);
      expect(stamped.facts.memberRoles).toEqual(state.facts.memberRoles);
      expect(stamped.facts.membershipReadGrants).toEqual(state.facts.membershipReadGrants);
      const after = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      const protocols = JSON.parse(JSON.stringify(before.protocols));
      protocols.matrix.membershipOperation.ownerRecovery = { generation: 1, binding };
      expect(after.protocols).toEqual(protocols);
      expect(after.facts.membershipAuthority).toEqual(f.binding);
      expect(before.quads.filter(row => !row.equals(before.protocolsQuad))
        .every(row => after.quads.some(actual => actual.equals(row)))).toBe(true);
      expect(after.quads).toHaveLength(before.quads.length);
      expect(expectedGroundDigest(f.podAcl, await f.policyBody(f.podAcl), 'acp'))
        .toBe(expectedGroundDigest(f.podAcl, policy, 'acp'));
      expect(await head(f)).toBe(403);
    });
  });

  it('confirms the same stamp through a fresh read without effects, then increments a safe generation', async () => {
    await actualMembershipAcpFixture(async f => {
      await pending(f); const binding = await newBinding(f);
      const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      const old = await owner.readCurrent();
      await owner.beginOwnerRecovery(old, operationId, { generation: 1, binding });
      const reopened = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      const fresh = await reopened.readCurrent();
      f.native.mockClear();
      const replay = await reopened.beginOwnerRecovery(fresh, operationId, { generation: 1, binding });
      expect(replay.facts.membershipOperation?.ownerRecovery).toEqual({ generation: 1, binding });
      expect(f.native).not.toHaveBeenCalled();
      await expect(reopened.beginOwnerRecovery({ ...fresh }, operationId, { generation: 2, binding }))
        .rejects.toMatchObject({ status: 409 });
      expect(f.native).not.toHaveBeenCalled();
      const next = await reopened.beginOwnerRecovery(await reopened.readCurrent(), operationId, { generation: 2, binding });
      expect(next.facts.membershipOperation?.ownerRecovery).toEqual({ generation: 2, binding });
      expect(next.facts.membershipOperation?.phase).toBe('join-read-pending');
      expect(f.native).toHaveBeenCalledTimes(1); expect(await head(f)).toBe(403);
    });
  });

  it.each(['member', 'foreign auth', 'service context'] as const)('refuses %s with zero native writes', async kind => {
    await actualMembershipAcpFixture(async f => {
      await pending(f); f.native.mockClear();
      const context = kind === 'member' ? f.actorContext : kind === 'foreign auth'
        ? { ...f.ownerContext, auth: f.actorContext.auth }
        : { ...f.ownerContext, service: { taskCredential: { credentialRef: f.binding.credentialRef, version: 1 } } };
      await expect(f.membership.openForOwnerRecovery(f.roomId, context)).rejects.toMatchObject({ status: 403 });
      expect(f.native).not.toHaveBeenCalled();
      const actual = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(actual.facts.membershipOperation?.ownerRecovery).toBeNull();
    });
  });

  it.each(['wrong owner', 'wrong issuer', 'stale version', 'revoked'] as const)(
    'refuses a %s replacement binding before any write', async kind => {
      await actualMembershipAcpFixture(async f => {
        await pending(f);
        let binding = await newBinding(f, kind === 'wrong owner' ? f.actor : f.owner,
          kind === 'wrong issuer' ? `${f.origin}foreign/` : f.origin);
        if (kind === 'stale version') binding = { ...binding, version: 999 };
        if (kind === 'revoked') await f.credentials.revoke(binding.credentialRef);
        const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
        const before = await owner.readCurrent(); f.native.mockClear();
        await expect(owner.beginOwnerRecovery(before, operationId, { generation: 1, binding }))
          .rejects.toMatchObject({ status: 403 });
        expect(f.native).not.toHaveBeenCalled();
        expect((await owner.readCurrent()).facts.membershipOperation?.ownerRecovery).toBeNull();
      });
    });

  it('elects one exact source winner between two owner ports with different replacement bindings', async () => {
    await actualMembershipAcpFixture(async f => {
      await pending(f); const bindings = [await newBinding(f), await newBinding(f)];
      const ports = await Promise.all([f.membership.openForOwnerRecovery(f.roomId, f.ownerContext),
        f.membership.openForOwnerRecovery(f.roomId, f.ownerContext)]);
      const expected = await Promise.all(ports.map(port => port.readCurrent()));
      const results = await Promise.allSettled(ports.map((port, i) =>
        port.beginOwnerRecovery(expected[i], operationId, { generation: 1, binding: bindings[i] })));
      expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(row => row.status === 'rejected');
      expect(rejected && rejected.status === 'rejected' ? rejected.reason : undefined).toMatchObject({ status: 409 });
      const actual = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(actual.facts.membershipOperation?.ownerRecovery?.generation).toBe(1);
      expect(bindings).toContainEqual(actual.facts.membershipOperation?.ownerRecovery?.binding);
      expect(actual.facts.membershipOperation?.operationId).toBe(operationId);
      expect(actual.facts.membershipOperation?.phase).toBe('join-read-pending');
      expect(await head(f)).toBe(403);
    });
  });

  it('fences an already prepared old ACP policy write even while the original lease stays active', async () => {
    await actualMembershipAcpFixture(async f => {
      await pending(f); const binding = await newBinding(f);
      const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      const expected = await owner.readCurrent();
      let stamped = false;
      const original = f.options.podAccess.getPodFetch;
      f.options.podAccess.getPodFetch = async (webId, request) => {
        const named = await original(webId, request);
        return async (input, init) => {
          if (!stamped && String(input) === `${f.room}-/sparql` && init?.method === 'POST'
            && new Headers(init.headers).get('content-type') === guarded) {
            stamped = true;
            await owner.beginOwnerRecovery(expected, operationId, { generation: 1, binding });
          }
          return await named(input, init);
        };
      };
      f.native.mockClear();
      let failure: unknown;
      try { await applyMembershipReadDelta(f.options, f.roomId, f.actorContext, { kind: 'join', operationId }); }
      catch (error) { failure = error; }
      expect(stamped).toBe(true); expect(failure).toBeDefined();
      expect(f.native).toHaveBeenCalledTimes(2); // stamp commit + actual old native WHERE with no policy delta.
      expect(await head(f)).toBe(403);
      await expect(f.credentials.lease({ credentialRef: f.binding.credentialRef, ownerWebId: f.owner,
        version: 1, recordUsage: false })).resolves.toMatchObject({ credentialRef: f.binding.credentialRef });
      const current = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(current.facts.membershipOperation?.ownerRecovery).toEqual({ generation: 1, binding });
      expect(current.facts.membershipOperation?.phase).toBe('join-read-pending');
      expect(current.facts.membershipReadGrants?.[f.actor]?.state).toBe('reserved');
    });
  });

  it('rejects an old Read-phase receipt after the original owner installs a recovery stamp', async () => {
    await actualMembershipAcpFixture(async f => {
      const join = await f.membership.openForJoin(f.roomId, f.actorContext);
      const state = await join.reserveJoin(await join.readCurrent(), { operationId, createdAt: 20 });
      const receipt = await applyMembershipReadDelta(f.options, f.roomId, f.actorContext, { kind: 'join', operationId });
      expect(await head(f)).toBe(200);
      const binding = await newBinding(f);
      const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      await owner.beginOwnerRecovery(await owner.readCurrent(), operationId, { generation: 1, binding });
      const before = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      f.native.mockClear();
      await expect(join.markJoinReadGranted(state, operationId, receipt)).rejects.toMatchObject({ status: 409 });
      expect(f.native).not.toHaveBeenCalled(); // Existing source precheck refuses a receipt that was already stale at entry.
      const after = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(expectedSourceDigest(f.source, f.document, after.quads))
        .toBe(expectedSourceDigest(f.source, f.document, before.quads));
      expect(after.facts.membershipReadGrants?.[f.actor]?.state).toBe('reserved');
      expect(after.facts.membershipOperation?.phase).toBe('join-read-pending');
      expect(await head(f)).toBe(200); // Stamping and rejecting the old receipt do not delete the committed policy.
    });
  });

  it('has zero stamp effects when a physical source quad is added after preparation and before execution', async () => {
    let active = false; let changed = false;
    let mutate: (() => Promise<void>) | undefined;
    await actualMembershipAcpFixture(async f => {
      await pending(f); const binding = await newBinding(f);
      const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      const expected = await owner.readCurrent();
      const snapshot = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      const late = [...snapshot.quads, DataFactory.quad(DataFactory.namedNode(`${f.document}#late-source-sibling`),
        DataFactory.namedNode('urn:root:stamp-fence'), DataFactory.literal('late', 'zh'))];
      mutate = async () => { await f.indexedPut(f.document, late); };
      active = true; f.native.mockClear();
      await expect(owner.beginOwnerRecovery(expected, operationId, { generation: 1, binding }))
        .rejects.toMatchObject({ status: 409 });
      expect(changed).toBe(true);
      expect(f.native).toHaveBeenCalledTimes(1); // Actual conditional native evaluation; no matching source.
      const actual = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(expectedSourceDigest(f.source, f.document, actual.quads))
        .toBe(expectedSourceDigest(f.source, f.document, late));
      expect(actual.facts.membershipOperation?.ownerRecovery).toBeNull();
      expect(actual.facts.membershipOperation?.phase).toBe('join-read-pending');
      expect(await head(f)).toBe(403);
    }, { intercept: async (request) => {
      if (!active || request.method !== 'POST') return false;
      active = false; changed = true; await mutate!();
      return false;
    } });
  });


  it.each([0, -1, 2, Number.MAX_SAFE_INTEGER + 1])('rejects invalid or skipped generation %s without source effects', async generation => {
    await actualMembershipAcpFixture(async f => {
      await pending(f); const binding = await newBinding(f);
      const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      const expected = await owner.readCurrent();
      const before = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      f.native.mockClear();
      let failure: unknown;
      try { await owner.beginOwnerRecovery(expected, operationId, { generation, binding }); }
      catch (error) { failure = error; }
      expect(failure).toBeDefined();
      expect([400, 409]).toContain((failure as { status: number }).status);
      expect(f.native).not.toHaveBeenCalled();
      const after = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(expectedSourceDigest(f.source, f.document, after.quads))
        .toBe(expectedSourceDigest(f.source, f.document, before.quads));
    });
  });

  it('does not create a recovery slot when no original member operation is pending', async () => {
    await actualMembershipAcpFixture(async f => {
      const binding = await newBinding(f);
      const before = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      f.native.mockClear();
      await expect((async () => {
        const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
        await owner.beginOwnerRecovery(await owner.readCurrent(), operationId, { generation: 1, binding });
      })()).rejects.toMatchObject({ status: 409 });
      expect(f.native).not.toHaveBeenCalled();
      const after = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(expectedSourceDigest(f.source, f.document, after.quads))
        .toBe(expectedSourceDigest(f.source, f.document, before.quads));
    });
  });


  it.each(['before request', 'after commit'] as const)(
    'rechecks the explicit replacement lease %s and refuses a successful stamp receipt', async point => {
      await actualMembershipAcpFixture(async f => {
        await pending(f); const binding = await newBinding(f);
        let active = false; let revoked = false;
        const original = f.options.podAccess.getPodFetch;
        f.options.podAccess.getPodFetch = async (webId, request) => {
          const named = await original(webId, request);
          return async (input, init) => {
            const write = active && !revoked && ['POST', 'PATCH'].includes(init?.method ?? 'GET');
            if (write && point === 'before request') {
              revoked = true; await f.credentials.revoke(binding.credentialRef);
            }
            const response = await named(input, init);
            if (write && point === 'after commit') {
              expect(response.status).toBe(204); await response.arrayBuffer();
              revoked = true; await f.credentials.revoke(binding.credentialRef);
            }
            return response;
          };
        };
        const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
        const expected = await owner.readCurrent();
        active = true; f.native.mockClear();
        await expect(owner.beginOwnerRecovery(expected, operationId, { generation: 1, binding }))
          .rejects.toMatchObject({ status: 403 });
        expect(revoked).toBe(true);
        expect(f.native).toHaveBeenCalledTimes(point === 'before request' ? 0 : 1);
        const current = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
        expect(current.facts.membershipOperation?.ownerRecovery)
          .toEqual(point === 'before request' ? null : { generation: 1, binding });
        expect(current.facts.membershipOperation?.phase).toBe('join-read-pending');
        expect(current.facts.membershipAuthority).toEqual(f.binding);
        expect(await head(f)).toBe(403);
      });
    });


  it('reports a lost committed stamp response as unknown, then confirms it through a fresh controlled read', async () => {
    await actualMembershipAcpFixture(async f => {
      await pending(f); const binding = await newBinding(f);
      let active = false; let lost = false;
      const original = f.options.podAccess.getPodFetch;
      f.options.podAccess.getPodFetch = async (webId, request) => {
        const named = await original(webId, request);
        return async (input, init) => {
          const response = await named(input, init);
          if (active && !lost && ['POST', 'PATCH'].includes(init?.method ?? 'GET')) {
            expect(response.status).toBe(204); await response.arrayBuffer(); lost = true;
            throw new Error('Root simulates loss after the actual recovery stamp commit');
          }
          return response;
        };
      };
      const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      const expected = await owner.readCurrent(); active = true; f.native.mockClear();
      await expect(owner.beginOwnerRecovery(expected, operationId, { generation: 1, binding }))
        .rejects.toMatchObject({ status: 503 });
      expect(lost).toBe(true); expect(f.native).toHaveBeenCalledTimes(1);
      const current = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(current.facts.membershipOperation?.ownerRecovery).toEqual({ generation: 1, binding });
      expect(current.facts.membershipOperation?.phase).toBe('join-read-pending');
      const reopened = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      f.native.mockClear();
      const confirmed = await reopened.beginOwnerRecovery(await reopened.readCurrent(), operationId, { generation: 1, binding });
      expect(confirmed.facts.membershipOperation?.ownerRecovery).toEqual({ generation: 1, binding });
      expect(confirmed.facts.membershipReadGrants?.[f.actor]?.state).toBe('reserved');
      expect(confirmed.facts.membershipAuthority).toEqual(f.binding);
      expect(f.native).not.toHaveBeenCalled(); expect(await head(f)).toBe(403);
    });
  });

  it('refuses a receipt when the explicit lease is revoked after the actual final readback', async () => {
    await actualMembershipAcpFixture(async f => {
      await pending(f); const binding = await newBinding(f);
      let active = false; let revoked = false;
      const original = f.canonicalSource.readSnapshot.bind(f.canonicalSource);
      f.canonicalSource.readSnapshot = async (...args) => {
        const result = await original(...args);
        if (active && !revoked) { revoked = true; await f.credentials.revoke(binding.credentialRef); }
        return result;
      };
      const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      const expected = await owner.readCurrent(); active = true; f.native.mockClear();
      await expect(owner.beginOwnerRecovery(expected, operationId, { generation: 1, binding }))
        .rejects.toMatchObject({ status: 403 });
      expect(revoked).toBe(true); expect(f.native).toHaveBeenCalledTimes(1);
      const current = await original(f.roomId, f.ownerContext);
      expect(current.facts.membershipOperation?.ownerRecovery).toEqual({ generation: 1, binding });
      expect(current.facts.membershipOperation?.phase).toBe('join-read-pending');
      expect(await head(f)).toBe(403);
    });
  });

  it('refuses replay evidence whose complete physical source changed despite an identical recovery marker', async () => {
    await actualMembershipAcpFixture(async f => {
      await pending(f); const binding = await newBinding(f);
      const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      await owner.beginOwnerRecovery(await owner.readCurrent(), operationId, { generation: 1, binding });
      const expected = await owner.readCurrent();
      const before = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      const late = [...before.quads, DataFactory.quad(DataFactory.namedNode(`${f.document}#replay-sibling`),
        DataFactory.namedNode('urn:root:replay-fence'), DataFactory.literal('changed', 'zh'))];
      await f.indexedPut(f.document, late); f.native.mockClear();
      await expect(owner.beginOwnerRecovery(expected, operationId, { generation: 1, binding }))
        .rejects.toMatchObject({ status: 409 });
      expect(f.native).not.toHaveBeenCalled();
      const after = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(expectedSourceDigest(f.source, f.document, after.quads))
        .toBe(expectedSourceDigest(f.source, f.document, late));
    });
  });

  it('validates the original actor registered Pod without authenticating as that actor', async () => {
    await actualMembershipAcpFixture(async f => {
      await pending(f); const binding = await newBinding(f);
      const before = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      const protocols = structuredClone(before.protocols);
      const matrix = protocols.matrix as Record<string, unknown>;
      const operation = matrix.membershipOperation as Record<string, unknown>;
      (operation.actor as Record<string, unknown>).podUrl = `${f.origin}unregistered-actor/`;
      const replacement = DataFactory.quad(before.protocolsQuad.subject, before.protocolsQuad.predicate,
        DataFactory.literal(JSON.stringify(protocols), before.protocolsQuad.object.termType === 'Literal'
          ? before.protocolsQuad.object.datatype : DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON')),
        before.protocolsQuad.graph);
      const altered = before.quads.map(row => row.equals(before.protocolsQuad) ? replacement : row);
      await f.indexedPut(f.document, altered); f.native.mockClear();
      await expect((async () => {
        const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
        await owner.beginOwnerRecovery(await owner.readCurrent(), operationId, { generation: 1, binding });
      })()).rejects.toMatchObject({ status: 403 });
      expect(f.native).not.toHaveBeenCalled();
      const after = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(expectedSourceDigest(f.source, f.document, after.quads))
        .toBe(expectedSourceDigest(f.source, f.document, altered));
      expect(after.facts.membershipOperation?.ownerRecovery).toBeNull();
    });
  });


  it('natively fences a Read-phase receipt when recovery commits after its source precheck', async () => {
    let active = false; let stamped = false;
    let stamp: (() => Promise<void>) | undefined;
    await actualMembershipAcpFixture(async f => {
      const join = await f.membership.openForJoin(f.roomId, f.actorContext);
      const state = await join.reserveJoin(await join.readCurrent(), { operationId, createdAt: 20 });
      const receipt = await applyMembershipReadDelta(f.options, f.roomId, f.actorContext, { kind: 'join', operationId });
      const binding = await newBinding(f);
      const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      const expected = await owner.readCurrent();
      stamp = async () => { await owner.beginOwnerRecovery(expected, operationId, { generation: 1, binding }); };
      active = true; f.native.mockClear();
      await expect(join.markJoinReadGranted(state, operationId, receipt)).rejects.toMatchObject({ status: 409 });
      expect(stamped).toBe(true); expect(f.native).toHaveBeenCalledTimes(2);
      const after = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(after.facts.membershipOperation?.ownerRecovery).toEqual({ generation: 1, binding });
      expect(after.facts.membershipReadGrants?.[f.actor]?.state).toBe('reserved');
      expect(after.facts.membershipOperation?.phase).toBe('join-read-pending');
      expect(await head(f)).toBe(200);
    }, { intercept: async request => {
      if (!active || request.method !== 'POST'
        || request.headers['content-type'] !== guarded) return false;
      active = false; stamped = true; await stamp!();
      return false;
    } });
  });

  it.each(['unrelated raw quad', 'original operation time'] as const)(
    'refuses exact readback when %s changes after the actual stamp commit', async kind => {
      await actualMembershipAcpFixture(async f => {
        await pending(f); const binding = await newBinding(f);
        let active = false; let changed = false;
        const original = f.options.podAccess.getPodFetch;
        f.options.podAccess.getPodFetch = async (webId, request) => {
          const named = await original(webId, request);
          return async (input, init) => {
            const response = await named(input, init);
            if (active && !changed && ['POST', 'PATCH'].includes(init?.method ?? 'GET')) {
              expect(response.status).toBe(204); await response.arrayBuffer(); changed = true;
              const committed = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
              let quads = [...committed.quads];
              if (kind === 'unrelated raw quad') {
                quads.push(DataFactory.quad(DataFactory.namedNode(`${f.document}#post-stamp-sibling`),
                  DataFactory.namedNode('urn:root:post-stamp-fence'), DataFactory.literal('late', 'zh')));
              } else {
                const protocols = structuredClone(committed.protocols);
                const matrix = protocols.matrix as Record<string, unknown>;
                const operation = matrix.membershipOperation as Record<string, unknown>;
                (operation.event as Record<string, unknown>).createdAt = 21;
                const replacement = DataFactory.quad(committed.protocolsQuad.subject, committed.protocolsQuad.predicate,
                  DataFactory.literal(JSON.stringify(protocols), committed.protocolsQuad.object.termType === 'Literal'
                    ? committed.protocolsQuad.object.datatype : DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON')),
                  committed.protocolsQuad.graph);
                quads = quads.map(row => row.equals(committed.protocolsQuad) ? replacement : row);
              }
              await f.indexedPut(f.document, quads);
            }
            return response;
          };
        };
        const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
        const expected = await owner.readCurrent(); active = true; f.native.mockClear();
        await expect(owner.beginOwnerRecovery(expected, operationId, { generation: 1, binding }))
          .rejects.toMatchObject({ status: 409 });
        expect(changed).toBe(true); expect(f.native).toHaveBeenCalledTimes(1);
        const after = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
        expect(after.facts.membershipOperation?.ownerRecovery).toEqual({ generation: 1, binding });
        expect(after.facts.membershipOperation?.phase).toBe('join-read-pending');
        expect(await head(f)).toBe(403);
      });
    });

  it('does not reuse old pre-write evidence to adopt a stamp after an unknown committed response', async () => {
    await actualMembershipAcpFixture(async f => {
      await pending(f); const binding = await newBinding(f);
      let active = false; let lost = false;
      const original = f.options.podAccess.getPodFetch;
      f.options.podAccess.getPodFetch = async (webId, request) => {
        const named = await original(webId, request);
        return async (input, init) => {
          const response = await named(input, init);
          if (active && !lost && ['POST', 'PATCH'].includes(init?.method ?? 'GET')) {
            expect(response.status).toBe(204); await response.arrayBuffer(); lost = true;
            throw new Error('Root unknown response forbids reuse of pre-write source evidence');
          }
          return response;
        };
      };
      const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      const expected = await owner.readCurrent(); active = true;
      await expect(owner.beginOwnerRecovery(expected, operationId, { generation: 1, binding }))
        .rejects.toMatchObject({ status: 503 });
      expect(lost).toBe(true); f.native.mockClear();
      await expect(owner.beginOwnerRecovery(expected, operationId, { generation: 1, binding }))
        .rejects.toMatchObject({ status: 409 });
      expect(f.native).not.toHaveBeenCalled();
      const fresh = await owner.readCurrent();
      const confirmed = await owner.beginOwnerRecovery(fresh, operationId, { generation: 1, binding });
      expect(confirmed.facts.membershipOperation?.ownerRecovery).toEqual({ generation: 1, binding });
      expect(confirmed.facts.membershipOperation?.phase).toBe('join-read-pending');
      expect(f.native).not.toHaveBeenCalled(); expect(await head(f)).toBe(403);
    });
  });

  it.each(['missing original invitation', 'different original authority', 'original author leaving'] as const)(
    'refuses an invalid pending tuple: %s', async kind => {
      await actualMembershipAcpFixture(async f => {
        await pending(f); const binding = await newBinding(f);
        const before = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
        const protocols = structuredClone(before.protocols);
        const matrix = protocols.matrix as Record<string, unknown>;
        const operation = matrix.membershipOperation as Record<string, unknown>;
        const expected = operation.expected as Record<string, unknown>;
        if (kind === 'missing original invitation') expected.invitation = null;
        else if (kind === 'different original authority') operation.authority = { ...f.binding, version: 999 };
        else {
          operation.kind = 'leave'; operation.phase = 'leave-read-pending';
          operation.actor = { webId: f.owner, podUrl: f.pod }; operation.targetWebId = f.owner;
          expected.participants = [...before.facts.participants]; expected.memberRoles = { ...before.facts.memberRoles };
          expected.invitation = null;
          operation.event = { createdAt: 20, content: { membership: 'leave' } };
        }
        const replacement = DataFactory.quad(before.protocolsQuad.subject, before.protocolsQuad.predicate,
          DataFactory.literal(JSON.stringify(protocols), before.protocolsQuad.object.termType === 'Literal'
            ? before.protocolsQuad.object.datatype : DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON')),
          before.protocolsQuad.graph);
        const altered = before.quads.map(row => row.equals(before.protocolsQuad) ? replacement : row);
        await f.indexedPut(f.document, altered); f.native.mockClear();
        await expect((async () => {
          const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
          await owner.beginOwnerRecovery(await owner.readCurrent(), operationId, { generation: 1, binding });
        })()).rejects.toMatchObject({ status: 409 });
        expect(f.native).not.toHaveBeenCalled();
        const after = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
        expect(expectedSourceDigest(f.source, f.document, after.quads))
          .toBe(expectedSourceDigest(f.source, f.document, altered));
        expect(after.facts.membershipOperation?.ownerRecovery).toBeNull();
      });
    });

  it('stamps a valid original leave without removing Read or advancing its source phase', async () => {
    await actualMembershipAcpFixture(async f => {
      // Qualify source phases only here; original actor PDU completion remains a later A4 obligation.
      const join = await f.membership.openForJoin(f.roomId, f.actorContext);
      const joined = await join.reserveJoin(await join.readCurrent(), { operationId, createdAt: 20 });
      const receipt = await applyMembershipReadDelta(f.options, f.roomId, f.actorContext, { kind: 'join', operationId });
      const granted = await join.markJoinReadGranted(joined, operationId, receipt);
      await join.completeJoin(granted, operationId);
      const leaveId = '$root-owner-recovery-original-leave';
      const leave = await f.membership.openForLeave(f.roomId, f.actorContext);
      const pendingLeave = await leave.reserveLeave(await leave.readCurrent(), { operationId: leaveId, createdAt: 30 });
      const before = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      const binding = await newBinding(f);
      const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      f.native.mockClear();
      const stamped = await owner.beginOwnerRecovery(await owner.readCurrent(), leaveId, { generation: 1, binding });
      expect(f.native).toHaveBeenCalledTimes(1);
      expect(stamped.facts.membershipOperation).toEqual({ ...pendingLeave.facts.membershipOperation,
        ownerRecovery: { generation: 1, binding } });
      expect(stamped.facts.participants).toEqual(before.facts.participants);
      expect(stamped.facts.memberRoles).toEqual(before.facts.memberRoles);
      expect(stamped.facts.membershipReadGrants).toEqual(before.facts.membershipReadGrants);
      expect(stamped.facts.membershipAuthority).toEqual(f.binding);
      expect(await head(f)).toBe(200);
    });
  });

  it('stamps a valid pending invite while preserving the original inviter, target and invitation obligation', async () => {
    await actualMembershipAcpFixture(async f => {
      const target = `${f.origin}carol/profile/card#me`;
      const inviteId = '$root-owner-recovery-original-invite';
      const invite = await f.membership.open(f.roomId, f.ownerContext);
      const reserved = await invite.reserveInvite(await invite.readCurrent(),
        { operationId: inviteId, createdAt: 40, targetWebId: target });
      const before = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      const binding = await newBinding(f);
      const owner = await f.membership.openForOwnerRecovery(f.roomId, f.ownerContext);
      const expected = await owner.readCurrent(); f.native.mockClear();
      const stamped = await owner.beginOwnerRecovery(expected, inviteId, { generation: 1, binding });
      expect(f.native).toHaveBeenCalledTimes(1);
      expect(stamped.facts.membershipOperation).toEqual({ ...reserved.facts.membershipOperation,
        ownerRecovery: { generation: 1, binding } });
      expect(stamped.facts.membershipOperation?.phase).toBe('committed');
      expect(stamped.facts.membershipInvitations).toEqual(before.facts.membershipInvitations);
      expect(stamped.facts.membershipInvitations?.[target]).toEqual({ id: inviteId, inviterWebId: f.owner, createdAt: 40 });
      expect(stamped.facts.participants).toEqual(before.facts.participants);
      expect(stamped.facts.memberRoles).toEqual(before.facts.memberRoles);
      expect(stamped.facts.membershipAuthority).toEqual(f.binding);
      expect(stamped.facts.membershipAuthorityPublication).toEqual(before.facts.membershipAuthorityPublication);
      const stampedSource = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      // The original normal inviter's already-held evidence cannot complete the operation after a stamp.
      await expect(invite.completeInvite(reserved, inviteId)).rejects.toMatchObject({ status: 409 });
      const after = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(after.facts.membershipOperation?.phase).toBe('committed');
      expect(after.facts.membershipOperation?.ownerRecovery).toEqual({ generation: 1, binding });
      expect(after.facts.membershipInvitations).toEqual(before.facts.membershipInvitations);
      expect(expectedSourceDigest(f.source, f.document, after.quads))
        .toBe(expectedSourceDigest(f.source, f.document, stampedSource.quads));
      expect(await head(f)).toBe(403);
    });
  });

});
