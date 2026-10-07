import { describe, expect, it, vi } from 'vitest';
import { InternalServerError, PermissionReader } from '@solid/community-server';
import { guardedPolicyClosureFixture, rootAcpPolicy } from '../helpers/GuardedPolicyClosureFixture';

const requestMedia = 'application/vnd.xpod.authorization-profile-negotiation+json';
const responseMedia = 'application/vnd.xpod.authorization-profile+json';
type Fixture = Parameters<Parameters<typeof guardedPolicyClosureFixture>[0]>[0];

async function request(f: Fixture, target = f.owner, extra: Record<string, unknown> = {}) {
  return { ...await f.observationRequest(target), profile: 'a2-profile-negotiation-v1', ...extra };
}

describe('actual HTTP authorization profile qualification', () => {
  it('declares the actual ACP profile with exact full identities and independently verified source digest, without effects', async () => {
    await guardedPolicyClosureFixture(async f => {
      const target = `${f.pod}profile/bob?account=full#me`;
      expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(403);
      const body = await request(f, target);
      const writes = vi.spyOn(f.lockedStore, 'setRepresentation');
      const response = await fetch(`${f.room}-/sparql`, {
        method: 'POST', headers: { 'content-type': requestMedia }, body: JSON.stringify(body),
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(response.headers.get('content-type')?.split(';')[0]).toBe(responseMedia);
      expect(JSON.parse(text)).toEqual({
        version: 1, profile: 'a2-profile-declaration-v1', guardedPolicyProfile: 'acp-ground-v1',
        requesterWebId: f.owner, targetWebId: target, sourceIri: f.source,
        sourceDigest: body.expectedSourceDigest, contextDigest: body.contextDigest, challenge: body.challenge,
      });
      expect(f.native).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(f.queryEngine.queryVoid).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

  it('rejects an extra caller profile assertion instead of reflecting it into a declaration', async () => {
    await guardedPolicyClosureFixture(async f => {
      const response = await f.post(await request(f, f.owner, { guardedPolicyProfile: 'wac-ground-v1' }), requestMedia);
      expect(response.status).toBe(400);
      expect(response.text).not.toContain('a2-profile-declaration-v1');
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

  it('declares WAC only through its bound actual capability and keeps the ACP observation media unsupported', async () => {
    await guardedPolicyClosureFixture(async f => {
      expect((await fetch(f.document, { method: 'HEAD' })).status).toBe(200);
      const body = await request(f);
      const response = await fetch(`${f.room}-/sparql`, {
        method: 'POST', headers: { 'content-type': requestMedia }, body: JSON.stringify(body),
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(response.headers.get('content-type')?.split(';')[0]).toBe(responseMedia);
      expect(JSON.parse(text)).toEqual({
        version: 1, profile: 'a2-profile-declaration-v1', guardedPolicyProfile: 'wac-ground-v1',
        requesterWebId: f.owner, targetWebId: f.owner, sourceIri: f.source,
        sourceDigest: body.expectedSourceDigest, contextDigest: body.contextDigest, challenge: body.challenge,
      });
      const acpResponse = await f.post(await f.observationRequest(), 'application/vnd.xpod.authorization-observation+json');
      expect(acpResponse.status).toBe(415);
      expect(f.native).not.toHaveBeenCalled();
    }, { observation: {} });
  });

  it('refuses a capability bound to WAC while the actual handler profile is ACP', async () => {
    await guardedPolicyClosureFixture(async f => {
      const children = vi.spyOn(f.accessor, 'getChildren');
      const response = await f.post(await request(f), requestMedia);
      expect(response.status).toBe(415);
      expect(response.text).not.toContain('a2-profile-declaration-v1');
      expect(children).not.toHaveBeenCalled();
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {
      boundArgs: actual => {
        const changed = [...actual] as typeof actual;
        changed[9] = 'wac-ground-v1';
        return changed;
      },
    } });
  });

  it('does not declare a profile when ordinary source Read is actually denied to the requester', async () => {
    await guardedPolicyClosureFixture(async f => {
      const policy = f.policyIri(f.document);
      await f.putRdfSet(policy, rootAcpPolicy(policy, f.document, f.owner, ['Read'], { deny: true, label: 'owner-source-deny' }));
      expect((await fetch(f.document, { method: 'HEAD' })).status).toBe(403);
      const response = await f.post(await request(f), requestMedia);
      expect(response.status).toBe(403);
      expect(response.text).not.toContain('a2-profile-declaration-v1');
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

  it('does not declare a profile to a requester who can Read the source but lacks room Control', async () => {
    await guardedPolicyClosureFixture(async f => {
      const requester = `${f.pod}profile/read-only#me`;
      await f.putRdfSet(f.podAcl, `${f.ownerPolicy}\n${rootAcpPolicy(f.podAcl, f.pod, requester, ['Read'], { label: 'read-only' })}`);
      const headers = { 'x-root-fixture-principal': requester };
      expect((await fetch(f.document, { method: 'HEAD', headers })).status).toBe(200);
      const children = vi.spyOn(f.accessor, 'getChildren');
      const response = await fetch(`${f.room}-/sparql`, {
        method: 'POST', headers: { ...headers, 'content-type': requestMedia },
        body: JSON.stringify(await request(f)),
      });
      const text = await response.text();
      expect(response.status, text).toBe(403);
      expect(text).not.toContain('a2-profile-declaration-v1');
      expect(children).not.toHaveBeenCalled();
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

  it('does not declare a profile for a source hash stale against the actual physical document', async () => {
    await guardedPolicyClosureFixture(async f => {
      const body = await request(f);
      await f.putRdf(f.document, `${await f.readPersisted(f.document)}\n<urn:root:added> <urn:root:value> "changed" .`);
      const response = await f.post(body, requestMedia);
      expect(response.status).toBe(409);
      expect(response.text).not.toContain('a2-profile-declaration-v1');
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

  it('refuses an absent capability even when the assembly advertises the known ACP profile', async () => {
    await guardedPolicyClosureFixture(async f => {
      const children = vi.spyOn(f.accessor, 'getChildren');
      const response = await f.post(await request(f), requestMedia);
      expect(response.status).toBe(415);
      expect(response.text).not.toContain('a2-profile-declaration-v1');
      expect(children).not.toHaveBeenCalled();
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: { disabled: true } });
  });

  it('refuses a WAC profile label without a bound capability even though ordinary source Read works', async () => {
    await guardedPolicyClosureFixture(async f => {
      expect((await fetch(f.document, { method: 'HEAD' })).status).toBe(200);
      const response = await f.post(await request(f), requestMedia);
      expect(response.status).toBe(415);
      expect(response.text).not.toContain('a2-profile-declaration-v1');
      expect(f.native).not.toHaveBeenCalled();
    }, { observation: { disabled: true } });
  });

  it('does not enumerate or disclose a requester-denied child while qualifying the room profile', async () => {
    await guardedPolicyClosureFixture(async f => {
      const hidden = `${f.room}hidden-profile/`;
      await f.putContainer(hidden);
      const policy = f.policyIri(hidden);
      await f.putRdfSet(policy, rootAcpPolicy(policy, hidden, f.owner, ['Read'], { deny: true, label: 'hidden-deny' }));
      expect((await fetch(hidden, { method: 'HEAD' })).status).toBe(403);
      const children = vi.spyOn(f.accessor, 'getChildren');
      const response = await f.post(await request(f), requestMedia);
      expect(response.status).toBe(403);
      expect(children.mock.calls.some(([identifier]) => identifier.path === hidden)).toBe(false);
      expect(response.text).not.toContain(hidden);
      expect(response.text).not.toContain('a2-profile-declaration-v1');
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

  it('preserves an ordinary custom route but refuses it before custom dispatch during qualification', async () => {
    let calls = 0; let delegate: PermissionReader | undefined;
    const custom = new class extends PermissionReader {
      public override async handle(input: Parameters<PermissionReader['handle']>[0]) {
        calls++;
        if (!delegate) throw new Error('Root custom reader is not ready');
        return await delegate.handleSafe(input);
      }
    }();
    await guardedPolicyClosureFixture(async f => {
      expect((await fetch(f.document, { method: 'HEAD' })).status).toBe(200);
      expect(calls).toBeGreaterThan(0);
      calls = 0;
      const children = vi.spyOn(f.accessor, 'getChildren');
      const response = await f.post(await request(f), requestMedia);
      expect(response.status).toBe(415);
      expect(calls).toBe(0);
      expect(children).not.toHaveBeenCalled();
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {
      routes: room => ({ [`^${new URL(room).pathname.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`]: custom }),
      reader: (actual, builtin) => { delegate = builtin; return actual; },
    } });
  });

  it('refuses WAC qualification when only the target bypasses the installed default dispatch', async () => {
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
      const response = await f.post(await request(f, target), requestMedia);
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

  it('does not declare a profile when the target reader fails after a genuine default dispatch', async () => {
    let target = '';
    await guardedPolicyClosureFixture(async f => {
      target = `${f.pod}profile/target-error#me`;
      expect((await fetch(f.document, { method: 'HEAD' })).status).toBe(200);
      expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(500);
      const response = await f.post(await request(f, target), requestMedia);
      expect([500, 503]).toContain(response.status);
      expect(response.text).not.toContain('a2-profile-declaration-v1');
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {
      reader: actual => new class extends PermissionReader {
        public override async handle(input: Parameters<PermissionReader['handle']>[0]) {
          const result = await actual.handleSafe(input);
          if (input.credentials.agent?.webId === target) throw new InternalServerError('Root target reader failed after dispatch');
          return result;
        }
      }(),
    } });
  });
});
