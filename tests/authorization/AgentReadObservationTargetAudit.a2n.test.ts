import { describe, expect, it } from 'vitest';
import { PermissionReader } from '@solid/community-server';
import { guardedPolicyClosureFixture } from '../helpers/GuardedPolicyClosureFixture';

const requestMedia = 'application/vnd.xpod.authorization-profile-negotiation+json';
type Fixture = Parameters<Parameters<typeof guardedPolicyClosureFixture>[0]>[0];

async function negotiationRequest(f: Fixture, target = f.owner, extra: Record<string, unknown> = {}) {
  return { ...await f.observationRequest(target), profile: 'a2-profile-negotiation-v1', ...extra };
}

describe('A2N target default-dispatch audit (own product regression)', () => {
  it('refuses qualification when only the target bypasses the installed default dispatch', async() => {
    let target = ''; let unknown = ''; let targetCalls = 0;
    await guardedPolicyClosureFixture(async f => {
      target = `${f.pod}profile/target#me`; unknown = `${f.pod}profile/unknown#me`;
      const acl = 'http://www.w3.org/ns/auth/acl#';
      await f.putRdfSet(f.podAcl, `${f.ownerPolicy}\n<${f.podAcl}#target> a <${acl}Authorization>;\n`
        + `  <${acl}agent> <${target}>; <${acl}default> <${f.pod}>; <${acl}mode> <${acl}Read> .`);
      expect((await fetch(f.document, { method: 'HEAD' })).status).toBe(200);
      expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(403);
      expect(targetCalls).toBeGreaterThan(0);
      targetCalls = 0;
      const response = await f.post(await negotiationRequest(f, target), requestMedia);
      expect(response.status, response.text).toBe(415);
      expect(response.text).not.toContain('a2-profile-declaration-v1');
      expect(f.native).not.toHaveBeenCalled();
    }, { observation: {
      reader: (actual, builtin) => new class extends PermissionReader {
        public override async handle(input: Parameters<PermissionReader['handle']>[0]) {
          if (input.credentials.agent?.webId === target) {
            targetCalls++;
            return await builtin.handleSafe({ ...input, credentials: { agent: { webId: unknown } } });
          }
          return await actual.handleSafe(input);
        }
      }(),
    } });
  });

  it('still declares a qualified WAC profile when the audited target Read is a normal denial', async() => {
    await guardedPolicyClosureFixture(async f => {
      const unknown = `${f.pod}profile/nobody#me`;
      const body = await negotiationRequest(f, unknown);
      const response = await fetch(`${f.room}-/sparql`, {
        method: 'POST', headers: { 'content-type': requestMedia }, body: JSON.stringify(body),
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const parsed = JSON.parse(text);
      expect(Object.keys(parsed)).toEqual([
        'version', 'profile', 'guardedPolicyProfile', 'requesterWebId', 'targetWebId', 'sourceIri',
        'sourceDigest', 'contextDigest', 'challenge',
      ]);
      expect(parsed.guardedPolicyProfile).toBe('wac-ground-v1');
      expect(parsed.targetWebId).toBe(unknown);
      expect(parsed).not.toHaveProperty('read');
      expect(parsed).not.toHaveProperty('guard');
      expect(f.native).not.toHaveBeenCalled();
    }, { observation: {} });
  });

  it('keeps an ACP target denial qualified too (no effectiveRead publication)', async() => {
    await guardedPolicyClosureFixture(async f => {
      const unknown = `${f.pod}profile/nobody#me`;
      const body = await negotiationRequest(f, unknown);
      const response = await f.post(body, requestMedia);
      expect(response.status, response.text).toBe(200);
      expect(JSON.parse(response.text)).not.toHaveProperty('read');
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });
});
