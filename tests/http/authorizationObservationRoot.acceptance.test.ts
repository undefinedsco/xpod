import { describe, expect, it } from 'vitest';
import { guardedPolicyClosureFixture, rootAcpPolicy, expectedGroundDigest } from '../helpers/GuardedPolicyClosureFixture';

const media = 'application/vnd.xpod.authorization-observation+json';

describe('actual authorization observation root policy outside Pod', () => {
  it('rereads missing, empty and present actual root policies without reusing a prior 404', async () => {
    await guardedPolicyClosureFixture(async f => {
      const rootPolicy = f.policyIri(f.origin);
      expect(rootPolicy.startsWith(f.pod)).toBe(false);
      const observe = async () => {
        const response = await f.post(await f.observationRequest(), media);
        expect(response.status, `${response.text}; ${JSON.stringify(f.handlerErrors)}`).toBe(200);
        return JSON.parse(response.text);
      };
      const missing = await observe();
      expect(missing.guard.ancestors.some((row: { iri: string }) => row.iri === f.origin)).toBe(true);
      expect(missing.guard.policies.find((row: { iri: string }) => row.iri === rootPolicy).state).toBe('absent404');
      await f.putRdf(rootPolicy, '');
      expect((await fetch(f.document, { method: 'HEAD' })).status).toBe(200);
      const empty = await observe();
      const emptyPolicy = empty.guard.policies.find((row: { iri: string }) => row.iri === rootPolicy);
      expect(emptyPolicy.state).toBe('present-empty');
      expect(emptyPolicy.digest).toBe(expectedGroundDigest(rootPolicy, [], 'acp'));
      await f.putRdf(rootPolicy, rootAcpPolicy(rootPolicy, f.origin, f.owner, ['Read'], { label: 'root-marker-policy' }));
      const present = await observe();
      const current = present.guard.policies.find((row: { iri: string }) => row.iri === rootPolicy);
      expect(current.state).toBe('present');
      expect(current.digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(current.digest).not.toBe(emptyPolicy.digest);
      expect(JSON.stringify(present)).not.toContain('root-marker-policy');
      for (const row of present.read) {
        expect(row.allowed).toBe((await fetch(row.iri, { method: 'HEAD' })).status === 200);
      }
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });
  it('keeps inherited target Read through an empty direct policy and records its actual empty digest', async () => {
    await guardedPolicyClosureFixture(async f => {
      const target = `${f.pod}profile/bob#me`;
      await f.putRdfSet(f.podAcl, `${f.ownerPolicy}\n${rootAcpPolicy(f.podAcl, f.pod, target, ['Read'], { label: 'target' })}`);
      const direct = f.policyIri(f.document);
      await f.putRdf(direct, '');
      expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(200);
      const response = await f.post(await f.observationRequest(target), media);
      expect(response.status, response.text).toBe(200);
      const result = JSON.parse(response.text);
      expect(result.guard.policies.find((row: { iri: string }) => row.iri === direct)).toEqual({
        iri: direct, kind: 'acp', state: 'present-empty', digest: expectedGroundDigest(direct, [], 'acp'),
      });
      expect(result.read.find((row: { iri: string }) => row.iri === f.document).allowed).toBe(true);
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

  it('uses a private server-root deny without disclosing its policy body or granting target Read', async () => {
    await guardedPolicyClosureFixture(async f => {
      const target = `${f.pod}profile/bob#me`;
      await f.putRdfSet(f.podAcl, `${f.ownerPolicy}\n${rootAcpPolicy(f.podAcl, f.pod, target, ['Read'], { label: 'target' })}`);
      const rootPolicy = f.policyIri(f.origin);
      const denied = rootAcpPolicy(rootPolicy, f.origin, target, ['Read'], { deny: true, label: 'private-global-deny-marker' });
      await f.putRdf(rootPolicy, denied);
      expect((await fetch(rootPolicy, { method: 'HEAD' })).status).toBe(403);
      expect((await fetch(f.document, { method: 'HEAD' })).status).toBe(200);
      expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(403);
      const response = await f.post(await f.observationRequest(target), media);
      expect(response.status, response.text).toBe(200);
      const result = JSON.parse(response.text);
      for (const row of result.read) {
        expect(row.allowed).toBe(false);
        expect((await fetch(row.iri, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(403);
      }
      expect(result.guard.policies.some((row: { iri: string }) => row.iri === rootPolicy)).toBe(true);
      expect(response.text).not.toContain('private-global-deny-marker');
      expect(response.text).not.toContain('http://www.w3.org/ns/solid/acp#deny');
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

});
