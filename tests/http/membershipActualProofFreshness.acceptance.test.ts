import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { actualMembershipAcpFixture, actualMembershipWacFixture } from '../helpers/ActualMembershipWacFixture';
import { MembershipPolicyObserver, proveMembershipEffectiveRead } from '../../src/api/matrix/membershipPolicyObservation';

/** Actual CSS, registered Pods, named vault leases and full physical RDF.
 * Counted fixture principals do not attest Gateway DPoP or production QLever. */
describe('root actual asynchronous membership proof freshness', () => {
  it('rejects a full physical WAC source addition before returning the Read proof', async () => {
    await actualMembershipWacFixture(async f => {
      const initial = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      const result = await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join');
      expect(result.coverage).toBe('complete');
      const calibrated = await proveMembershipEffectiveRead(result, f.actor);
      expect(calibrated.profile).toBe('wac-effective-read-v1');
      expect(calibrated.noneRead).toBe(true);
      await f.indexedPut(f.document, [...initial.quads, DataFactory.quad(
        DataFactory.namedNode(`${f.document}#unrelated-record`), DataFactory.namedNode('urn:root:proof-change'),
        DataFactory.literal('retained canonical facts with a new physical quad'))]);
      f.native.mockClear();
      await expect(proveMembershipEffectiveRead(result, f.actor)).rejects.toMatchObject({ status: 409 });
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('rejects a revoked WAC named lease before proof with no further owner transport', async () => {
    await actualMembershipWacFixture(async f => {
      const result = await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join');
      expect(result.coverage).toBe('complete');
      expect((await proveMembershipEffectiveRead(result, f.actor)).noneRead).toBe(true);
      await f.credentials.revoke(f.binding.credentialRef);
      const before = f.requests.length;
      f.native.mockClear();
      await expect(proveMembershipEffectiveRead(result, f.actor)).rejects.toMatchObject({ status: 403 });
      expect(f.requests).toHaveLength(before);
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('rechecks the ACP lease after a genuine successful physical canonical response', async () => {
    await actualMembershipAcpFixture(async f => {
      let revokeAfterHeaders = false;
      let completedResponse = false;
      const original = f.options.podAccess.getPodFetch;
      f.options.podAccess.getPodFetch = async (webId, request) => {
        const named = await original(webId, request);
        return async (input, init) => {
          const response = await named(input, init);
          if (revokeAfterHeaders && String(input) === f.document && (init?.method ?? 'GET') === 'GET') {
            expect(response.status).toBe(200);
            expect(response.url).toBe(f.document);
            completedResponse = true;
            await f.credentials.revoke(f.binding.credentialRef);
          }
          return response;
        };
      };
      const result = await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join');
      expect(result.coverage).toBe('complete');
      expect((await proveMembershipEffectiveRead(result, f.actor)).profile).toBe('acp-effective-read-v1');
      revokeAfterHeaders = true;
      f.native.mockClear();
      await expect(proveMembershipEffectiveRead(result, f.actor)).rejects.toMatchObject({ status: 403 });
      expect(completedResponse).toBe(true);
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('preserves the established public WAC Read-proof DTO shape', async () => {
    await actualMembershipWacFixture(async f => {
      f.native.mockClear();
      const result = await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join');
      const proof = await proveMembershipEffectiveRead(result, f.actor);
      expect(proof.profile).toBe('wac-effective-read-v1');
      expect(Object.keys(proof).sort()).toEqual(['profile', 'actorWebId', 'resources', 'allRead', 'noneRead'].sort());
      expect(proof.resources.every(row => 'policyIri' in row && 'inheritedFrom' in row)).toBe(true);
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  for (const [kind, fixture] of [['WAC', actualMembershipWacFixture], ['ACP', actualMembershipAcpFixture]] as const) {
    it(`${kind} rechecks a revocation after the final source bookend response`, async () => {
      await fixture(async f => {
        let checking = false;
        let sourceReads = 0;
        let calibratedReadCount = 0;
        let revoked = false;
        const original = f.options.podAccess.getPodFetch;
        f.options.podAccess.getPodFetch = async (webId, request) => {
          const named = await original(webId, request);
          return async (input, init) => {
            const response = await named(input, init);
            if (checking && String(input) === f.document && (init?.method ?? 'GET') === 'GET') {
              expect(response.status).toBe(200);
              expect(response.url).toBe(f.document);
              // Derive the final bookend from the successful actual proof, so this
              // boundary test does not prescribe the number of internal reads.
              sourceReads++;
              if (sourceReads === calibratedReadCount) {
                await f.credentials.revoke(f.binding.credentialRef);
                revoked = true;
              }
            }
            return response;
          };
        };
        const result = await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join');
        expect(result.coverage).toBe('complete');
        const beforeCalibration = f.requests.length;
        const calibrated = await proveMembershipEffectiveRead(result, f.actor);
        expect(calibrated.profile).toBe(kind === 'WAC' ? 'wac-effective-read-v1' : 'acp-effective-read-v1');
        calibratedReadCount = f.requests.slice(beforeCalibration).filter(row =>
          row.method === 'GET' && row.url === f.document).length;
        expect(calibratedReadCount).toBeGreaterThan(0);
        checking = true; f.native.mockClear();
        let failure: unknown;
        try { await proveMembershipEffectiveRead(result, f.actor); }
        catch (error) { failure = error; }
        expect(sourceReads).toBe(calibratedReadCount); expect(revoked).toBe(true);
        expect(failure).toMatchObject({ status: 403 });
        expect(f.native).not.toHaveBeenCalled();
      });
    });
  }
});
