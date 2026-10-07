import { describe, expect, it } from 'vitest';
import { actualMembershipWacFixture } from '../helpers/ActualMembershipWacFixture';
import { applyMembershipReadDelta } from '../../src/api/matrix/membershipPolicyObservation';

const guarded = 'application/vnd.xpod.guarded-sparql-update+json';

describe('root actual WAC guarded policy consumption deadline', () => {
  it('does not give a guarded policy write a new total budget after its observation', async () => {
    await actualMembershipWacFixture(async f => {
      const port = await f.membership.openForJoin(f.roomId, f.actorContext);
      await port.reserveJoin(await port.readCurrent(), { operationId: '$root-policy-expiry', createdAt: 20 });
      let delayedSetup = false;
      let policyAttempts = 0;
      const original = f.options.podAccess.getPodFetch;
      f.options.podAccess.getPodFetch = async (webId, request) => {
        const named = await original(webId, request);
        return async (input, init) => {
          if (!delayedSetup && String(input) === f.document && (init?.method ?? 'GET') === 'GET') {
            delayedSetup = true;
            await new Promise(resolve => setTimeout(resolve, 600));
          }
          if (String(input) === `${f.room}-/sparql` && init?.method === 'POST'
            && new Headers(init.headers).get('content-type') === guarded) {
            policyAttempts++;
            // The real named fetch still enforces its supplied signal and current lease.
            // A refreshed total budget permits this request after the original TTL.
            await new Promise(resolve => setTimeout(resolve, 1100));
          }
          return await named(input, init);
        };
      };
      f.native.mockClear();
      let failure: unknown;
      try {
        await applyMembershipReadDelta({ ...f.options, limits: { totalTimeoutMs: 1500, requestTimeoutMs: 1200 } },
          f.roomId, f.actorContext, { kind: 'join', operationId: '$root-policy-expiry' });
      } catch (error) { failure = error; }
      expect(delayedSetup).toBe(true); expect(policyAttempts).toBe(1);
      expect(failure, JSON.stringify({ policyAttempts, actualPolicyPosts: f.requests.filter(row =>
        row.method === 'POST' && row.media === guarded).length, nativeCalls: f.native.mock.calls.length })).toBeDefined();
      expect(f.requests.filter(row => row.method === 'POST' && row.media === guarded)).toEqual([]);
      expect(f.native).not.toHaveBeenCalled();
      expect((await port.readCurrent()).facts.membershipOperation?.phase).toBe('join-read-pending');
    });
  });
});
