// Root-owned actual CSS/SQLite/vault/native-protocol counterexamples.
// These counted principals and Comunica do not prove Gateway DPoP/QLever or crash recovery.
import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { actualMembershipAcpFixture } from '../helpers/ActualMembershipWacFixture';
import { applyMembershipReadDelta } from '../../src/api/matrix/membershipPolicyMutation';
import { expectedGroundDigest } from '../helpers/GuardedPolicyClosureFixture';

const guarded = 'application/vnd.xpod.guarded-sparql-update+json';
type Fixture = Parameters<Parameters<typeof actualMembershipAcpFixture>[0]>[0];
const operationId = '$root-acp-fence-join';
async function reserve(f: Fixture) {
  const port = await f.membership.openForJoin(f.roomId, f.actorContext);
  await port.reserveJoin(await port.readCurrent(), { operationId, createdAt: 20 });
  return port;
}
async function head(f: Fixture) {
  const response = await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': f.actor } });
  await response.arrayBuffer(); return response.status;
}
function policyPost(f: Fixture, input: Parameters<typeof fetch>[0], init?: RequestInit) {
  return String(input) === `${f.room}-/sparql` && init?.method === 'POST'
    && new Headers(init.headers).get('content-type') === guarded;
}
async function attempt(f: Fixture) {
  let failure: unknown;
  try { await applyMembershipReadDelta(f.options, f.roomId, f.actorContext, { kind: 'join', operationId }); }
  catch (error) { failure = error; }
  return failure;
}

describe('root actual ACP delta source, lease and unknown-response fences', () => {
  it.each(['extra root property', 'new physical subject'] as const)(
    'has zero policy effects when %s arrives after preparation and before native evaluation', async change => {
      await actualMembershipAcpFixture(async f => {
        const port = await reserve(f);
        const initial = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
        const before = await f.policyBody(f.podAcl);
        let changed = false;
        const original = f.options.podAccess.getPodFetch;
        f.options.podAccess.getPodFetch = async (webId, request) => {
          const named = await original(webId, request);
          return async (input, init) => {
            if (!changed && policyPost(f, input, init)) {
              changed = true;
              await f.indexedPut(f.document, [...initial.quads, DataFactory.quad(
                DataFactory.namedNode(change === 'extra root property' ? f.source : `${f.document}#late-record`),
                DataFactory.namedNode('urn:root:late-source-fact'), DataFactory.literal('must fence this write'))]);
            }
            return await named(input, init);
          };
        };
        f.native.mockClear();
        const failure = await attempt(f);
        expect(changed).toBe(true);
        expect(f.native).toHaveBeenCalledTimes(1); // Actual native WHERE evaluated; condition did not match.
        expect(failure).toBeDefined();
        expect(await head(f)).toBe(403);
        const room = await fetch(f.roomAcl, { headers: { 'x-root-fixture-principal': f.owner } });
        await room.arrayBuffer(); expect(room.status).toBe(404);
        expect(expectedGroundDigest(f.podAcl, await f.policyBody(f.podAcl), 'acp'))
          .toBe(expectedGroundDigest(f.podAcl, before, 'acp'));
        expect((await port.readCurrent()).facts.membershipOperation?.phase).toBe('join-read-pending');
      });
    });

  it('does not consume a revoked named lease after preparation', async () => {
    await actualMembershipAcpFixture(async f => {
      const port = await reserve(f);
      const reservedParticipants = [...(await port.readCurrent()).facts.participants];
      let revoked = false;
      const original = f.options.podAccess.getPodFetch;
      f.options.podAccess.getPodFetch = async (webId, request) => {
        const named = await original(webId, request);
        return async (input, init) => {
          if (!revoked && policyPost(f, input, init)) {
            revoked = true; await f.credentials.revoke(f.binding.credentialRef);
          }
          return await named(input, init);
        };
      };
      f.native.mockClear();
      expect(await attempt(f)).toMatchObject({ status: 403 });
      expect(revoked).toBe(true); expect(f.native).not.toHaveBeenCalled();
      expect(await head(f)).toBe(403);
      const current = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      const matrix = JSON.parse(JSON.stringify(current.protocols)).matrix;
      expect(matrix.membershipOperation.phase).toBe('join-read-pending');
      expect(current.facts.participants).toEqual(reservedParticipants);
    });
  });

  it('keeps an actually committed grant pending when the policy response is lost', async () => {
    await actualMembershipAcpFixture(async f => {
      const port = await reserve(f);
      const reservedParticipants = [...(await port.readCurrent()).facts.participants];
      let committedResponse = false;
      const original = f.options.podAccess.getPodFetch;
      f.options.podAccess.getPodFetch = async (webId, request) => {
        const named = await original(webId, request);
        return async (input, init) => {
          const response = await named(input, init);
          if (!committedResponse && policyPost(f, input, init)) {
            expect(response.status).toBe(204); await response.arrayBuffer(); committedResponse = true;
            throw new Error('Root simulates loss after the actual policy commit');
          }
          return response;
        };
      };
      f.native.mockClear();
      expect(await attempt(f)).toMatchObject({ status: 503 });
      expect(committedResponse).toBe(true); expect(f.native).toHaveBeenCalledTimes(1);
      expect(await head(f)).toBe(200);
      const state = await port.readCurrent();
      expect(state.facts.membershipOperation?.phase).toBe('join-read-pending');
      expect(state.facts.membershipReadGrants?.[f.actor]).toMatchObject({ state: 'reserved' });
      expect(state.facts.membershipReadGrants?.[f.actor]).not.toHaveProperty('readProfile');
      expect(state.facts.participants).toEqual(reservedParticipants);
    });
  });

  it('does not turn a post-commit lease revocation into a Read receipt', async () => {
    await actualMembershipAcpFixture(async f => {
      const port = await reserve(f);
      const reservedParticipants = [...(await port.readCurrent()).facts.participants];
      let revoked = false;
      const original = f.options.podAccess.getPodFetch;
      f.options.podAccess.getPodFetch = async (webId, request) => {
        const named = await original(webId, request);
        return async (input, init) => {
          const response = await named(input, init);
          if (!revoked && policyPost(f, input, init)) {
            expect(response.status).toBe(204); await response.arrayBuffer();
            revoked = true; await f.credentials.revoke(f.binding.credentialRef);
          }
          return response;
        };
      };
      f.native.mockClear();
      expect(await attempt(f)).toMatchObject({ status: 403 });
      expect(revoked).toBe(true); expect(f.native).toHaveBeenCalledTimes(1);
      expect(await head(f)).toBe(200);
      const current = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      const matrix = JSON.parse(JSON.stringify(current.protocols)).matrix;
      expect(matrix.membershipOperation.phase).toBe('join-read-pending');
      expect(matrix.membershipReadGrants[f.actor].state).toBe('reserved');
      expect(current.facts.participants).toEqual(reservedParticipants);
    });
  });

  it.each(['initial policy', 'post-write policy'] as const)(
    'physically cancels a stalled %s body without returning a receipt', async phase => {
      let policyIri = ''; let active = false; let committed = false;
      let bodyStarted = 0; let closed = false;
      await actualMembershipAcpFixture(async f => {
        const port = await reserve(f);
        const reservedParticipants = [...(await port.readCurrent()).facts.participants];
        policyIri = f.roomAcl;
        const original = f.options.podAccess.getPodFetch;
        f.options.podAccess.getPodFetch = async (webId, request) => {
          const named = await original(webId, request);
          return async (input, init) => {
            const response = await named(input, init);
            if (policyPost(f, input, init)) { expect(response.status).toBe(204); committed = true; }
            return response;
          };
        };
        active = true; f.native.mockClear();
        let failure: unknown;
        try {
          await applyMembershipReadDelta({ ...f.options, limits: { requestTimeoutMs: 500 } },
            f.roomId, f.actorContext, { kind: 'join', operationId });
        } catch (error) { failure = error; }
        expect(bodyStarted).toBeGreaterThan(0);
        expect(performance.now() - bodyStarted).toBeLessThan(750);
        expect(closed).toBe(true);
        expect(failure).toMatchObject({ status: 503 });
        expect(f.native).toHaveBeenCalledTimes(phase === 'initial policy' ? 0 : 1);
        expect(await head(f)).toBe(phase === 'initial policy' ? 403 : 200);
        const state = await port.readCurrent();
        expect(state.facts.membershipOperation?.phase).toBe('join-read-pending');
        expect(state.facts.membershipReadGrants?.[f.actor]?.state).toBe('reserved');
        expect(state.facts.participants).toEqual(reservedParticipants);
      }, { intercept: (request, response, url) => {
        if (!active || request.method !== 'GET' || url !== policyIri
          || (phase === 'post-write policy' && !committed)) return false;
        active = false; bodyStarted = performance.now();
        response.writeHead(200, { 'Content-Type': 'text/turtle' }); response.write('# physical stalled policy body\n');
        const release = setTimeout(() => response.end(), 800);
        response.on('close', () => { closed = true; clearTimeout(release); });
        return true;
      } });
    });

  it('does not renew the original total deadline when consuming the ACP policy guard', async () => {
    await actualMembershipAcpFixture(async f => {
      const port = await reserve(f);
      let delayedSetup = false; let attempts = 0;
      const original = f.options.podAccess.getPodFetch;
      f.options.podAccess.getPodFetch = async (webId, request) => {
        const named = await original(webId, request);
        return async (input, init) => {
          if (!delayedSetup && String(input) === f.document && (init?.method ?? 'GET') === 'GET') {
            delayedSetup = true; await new Promise(resolve => setTimeout(resolve, 600));
          }
          if (policyPost(f, input, init)) {
            attempts++; await new Promise(resolve => setTimeout(resolve, 1100));
          }
          return await named(input, init);
        };
      };
      f.requests.length = 0; f.native.mockClear();
      let failure: unknown;
      try {
        await applyMembershipReadDelta({ ...f.options, limits: { totalTimeoutMs: 1500, requestTimeoutMs: 1200 } },
          f.roomId, f.actorContext, { kind: 'join', operationId });
      } catch (error) { failure = error; }
      expect(delayedSetup).toBe(true); expect(attempts).toBe(1);
      expect(failure).toBeDefined();
      expect(f.requests.filter(row => row.method === 'POST' && row.media === guarded)).toEqual([]);
      expect(f.native).not.toHaveBeenCalled();
      expect(await head(f)).toBe(403);
      expect((await port.readCurrent()).facts.membershipOperation?.phase).toBe('join-read-pending');
    });
  });

});
