import { describe, expect, it } from 'vitest';
import { actualMembershipAcpFixture, actualMembershipWacFixture } from '../helpers/ActualMembershipWacFixture';
import { MembershipPolicyObserver } from '../../src/api/matrix/membershipPolicyObservation';

const negotiation = 'application/vnd.xpod.authorization-profile-negotiation+json';

/** Negative responses are emitted over the actual fixture HTTP connection only after a
 * genuine qualified CSS observation has succeeded. No response DTO seals evidence. */
describe('root actual client profile negotiation boundaries', () => {
  for (const [kind, fixture] of [['WAC', actualMembershipWacFixture], ['ACP', actualMembershipAcpFixture]] as const) {
    it(`${kind} cannot interpret bare 415 as a successful WAC declaration`, async () => {
      let rejectNegotiation = false;
      await fixture(async f => {
        expect((await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join')).coverage).toBe('complete');
        f.requests.length = 0; f.native.mockClear(); rejectNegotiation = true;
        await expect(new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join'))
          .rejects.toMatchObject({ status: 415 });
        expect(f.requests.filter(row => row.method === 'POST').map(row => row.media)).toEqual([negotiation]);
        expect(f.requests.some(row => row.method === 'HEAD')).toBe(false);
        expect(f.native).not.toHaveBeenCalled();
      }, { intercept: (request, response) => {
        if (!rejectNegotiation || request.method !== 'POST' || request.headers['content-type'] !== negotiation) return false;
        request.resume(); response.writeHead(415); response.end(); return true;
      } });
    });

    it(`${kind} rejects a positive declaration that does not echo the physical challenge`, async () => {
      let breakEcho = false;
      let originalChallenge: string | undefined;
      await fixture(async f => {
        expect((await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join')).coverage).toBe('complete');
        f.requests.length = 0; f.native.mockClear(); breakEcho = true;
        await expect(new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join'))
          .rejects.toMatchObject({ status: 503 });
        expect(originalChallenge).toMatch(/^[a-f0-9]{32}$/u);
        expect(f.requests.filter(row => row.method === 'POST').map(row => row.media)).toEqual([negotiation]);
        expect(f.requests.some(row => row.method === 'HEAD')).toBe(false);
        expect(f.native).not.toHaveBeenCalled();
      }, { intercept: async (request, response) => {
        if (!breakEcho || request.method !== 'POST' || request.headers['content-type'] !== negotiation) return false;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        originalChallenge = body.challenge;
        response.writeHead(200, { 'Content-Type': 'application/vnd.xpod.authorization-profile+json' });
        response.end(JSON.stringify({ version: 1, profile: 'a2-profile-declaration-v1',
          guardedPolicyProfile: kind === 'WAC' ? 'wac-ground-v1' : 'acp-ground-v1',
          requesterWebId: request.headers['x-root-fixture-principal'], targetWebId: body.targetWebId,
          sourceIri: body.sourceIri, sourceDigest: body.expectedSourceDigest, contextDigest: body.contextDigest,
          challenge: `${body.challenge[0] === '0' ? '1' : '0'}${body.challenge.slice(1)}` }));
        return true;
      } });
    });
  }

  it('charges both actual ACP protocol POSTs to the original one-request budget', async () => {
    await actualMembershipAcpFixture(async f => {
      expect((await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join')).coverage).toBe('complete');
      f.requests.length = 0; f.native.mockClear();
      await expect(new MembershipPolicyObserver({ ...f.options, limits: { requests: 1 } })
        .observe(f.roomId, f.actorContext, 'join')).rejects.toMatchObject({ status: 503 });
      expect(f.requests.filter(row => row.method === 'POST').map(row => row.media)).toEqual([negotiation]);
      expect(f.native).not.toHaveBeenCalled();
    });
  });
});
