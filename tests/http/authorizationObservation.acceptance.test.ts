import { describe, expect, it } from 'vitest';
import { InternalServerError, PermissionBasedAuthorizer, PermissionReader } from '@solid/community-server';
import { Parser, Store, Writer } from 'n3';
import type { GuardedPolicySnapshot } from '../../src/storage/rdf/GuardedPolicySnapshot';
import { expectedSourceDigest, guardedPolicyClosureFixture, rootAcpPolicy } from '../helpers/GuardedPolicyClosureFixture';

type Fixture = Parameters<Parameters<typeof guardedPolicyClosureFixture>[0]>[0];
const media = 'application/vnd.xpod.authorization-observation+json';

async function grantTargetRead(f: Fixture, target: string) {
  const quads = new Parser({ baseIRI: f.podAcl }).parse(`${f.ownerPolicy}\n${
    rootAcpPolicy(f.podAcl, f.pod, target, ['Read'], { label: 'target' })}`);
  const writer = new Writer({ format: 'Turtle' });
  writer.addQuads(new Store(quads).getQuads(null, null, null, null));
  const turtle = await new Promise<string>((resolve, reject) => {
    writer.end((error, text) => error ? reject(error) : resolve(text));
  });
  await f.putRdf(f.podAcl, turtle);
}

async function observe(f: Fixture, targetWebId = f.owner, extra: Record<string, unknown> = {}) {
  const sourceDigest = expectedSourceDigest(f.source, f.document,
    new Parser({ baseIRI: f.document }).parse(await f.readPersisted(f.document)));
  const request = { version: 1, profile: 'acp-agent-read-v1', sourceIri: f.source,
    expectedSourceDigest: sourceDigest, targetWebId, contextDigest: 'ab'.repeat(32), challenge: 'cd'.repeat(16), ...extra };
  const response = await fetch(`${f.room}-/sparql`, {
    method: 'POST', headers: { 'content-type': media }, body: JSON.stringify(request),
  });
  const text = await response.text();
  return { status: response.status, type: response.headers.get('content-type'), text,
    json: response.status === 200 ? JSON.parse(text) : undefined, request };
}

describe('actual CSS ACP authorization observation', () => {
  it('returns a closed complete read table agreeing with actual HEAD and causes zero native effects', async () => {
    await guardedPolicyClosureFixture(async f => {
      const result = await observe(f);
      expect(result.status).toBe(200);
      expect(result.type?.split(';')[0]).toBe(media);
      expect(Object.keys(result.json).sort()).toEqual([
        'version', 'profile', 'requesterWebId', 'targetWebId', 'sourceIri', 'sourceDigest',
        'contextDigest', 'challenge', 'guard', 'read',
      ].sort());
      expect(result.json.sourceDigest).toBe(result.request.expectedSourceDigest);
      expect(result.json.sourceIri).toBe(f.source);
      expect(result.json.requesterWebId).toBe(f.owner);
      expect(result.json.contextDigest).toBe(result.request.contextDigest);
      expect(result.json.challenge).toBe(result.request.challenge);
      const normalized = (guard: GuardedPolicySnapshot) => ({ ...guard,
        resources: guard.resources.map(row => ({ ...row, children: [...row.children].sort() }))
          .sort((a, b) => a.iri.localeCompare(b.iri)),
        ancestors: [...guard.ancestors].sort((a, b) => a.iri.localeCompare(b.iri)),
        policies: [...guard.policies].sort((a, b) => a.iri.localeCompare(b.iri)),
      });
      expect(normalized(result.json.guard)).toEqual(normalized(f.expected()));
      expect(result.json.read.map((row: { iri: string }) => row.iri).sort())
        .toEqual(f.expected().resources.map(row => row.iri).sort());
      for (const row of result.json.read) {
        expect(Object.keys(row).sort()).toEqual(['allowed', 'iri']);
        const head = await fetch(row.iri, { method: 'HEAD' });
        expect(row.allowed).toBe(head.status === 200);
        expect(head.status).toBe(200);
      }
      expect(f.native).not.toHaveBeenCalled();
      expect(f.queryEngine.queryVoid).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

  it('rejects missing capability before observation traversal or mutation', async () => {
    await guardedPolicyClosureFixture(async f => {
      const result = await observe(f);
      expect(result.status).toBe(415);
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: { disabled: true } });
  });

  it('rejects an extra request field without treating the body as SPARQL', async () => {
    await guardedPolicyClosureFixture(async f => {
      expect((await observe(f, f.owner, { permissionOverride: true })).status).toBe(400);
      expect(f.native).not.toHaveBeenCalled();
      expect(f.queryEngine.queryVoid).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

  it('does not use requester dispatch coverage to certify a target that bypasses the real route', async () => {
    let target = ''; let bypassCalls = 0;
    await guardedPolicyClosureFixture(async f => {
      target = `${f.pod}profile/bob#me`;
      await grantTargetRead(f, target);
      const head = await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } });
      expect(head.status).toBe(200);
      bypassCalls = 0; f.native.mockClear();
      const result = await observe(f, target);
      expect(bypassCalls, `HTTP ${result.status}: ${result.text}`).toBeGreaterThan(0);
      expect(result.status).toBe(415);
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {
      reader: (actual, builtinDefault) => new class extends PermissionReader {
        public override async handle(input: Parameters<PermissionReader['handle']>[0]) {
          if (input.credentials.agent?.webId === target) {
            bypassCalls++;
            // Real installed default reader/ACP engine, with identical permissions; only route provenance is missing.
            return await builtinDefault.handleSafe(input);
          }
          return await actual.handleSafe(input);
        }
      }(),
    } });
  });

  it('fails the whole observation when a real authorizer faults after successful target reading', async () => {
    let target = ''; let fault = false; let faultCalls = 0;
    await guardedPolicyClosureFixture(async f => {
      target = `${f.pod}profile/bob#me`;
      await grantTargetRead(f, target);
      expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(200);
      f.native.mockClear(); fault = true;
      const result = await observe(f, target);
      expect(faultCalls, `HTTP ${result.status}: ${result.text}`).toBeGreaterThan(0);
      expect([500, 503]).toContain(result.status);
      expect(result.json).toBeUndefined();
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {
      authorizer: () => new class extends PermissionBasedAuthorizer {
        public override async handle(input: Parameters<PermissionBasedAuthorizer['handle']>[0]) {
          if (fault && input.credentials.agent?.webId === target) {
            faultCalls++;
            throw new InternalServerError('Root injected actual authorizer failure');
          }
          return await super.handle(input);
        }
      }(),
    } });
  });

  it('reports normal target Read denial as false after a complete qualified observation', async () => {
    await guardedPolicyClosureFixture(async f => {
      const target = `${f.pod}profile/bob#me`;
      expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(403);
      const result = await observe(f, target);
      expect(result.status).toBe(200);
      expect(result.json.read).toHaveLength(f.expected().resources.length);
      expect(result.json.read.every((row: { allowed: boolean }) => row.allowed === false)).toBe(true);
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

  it('treats exact duplicate ground policy triples as the same RDF set', async () => {
    await guardedPolicyClosureFixture(async f => {
      await f.putRdf(f.podAcl, `${f.ownerPolicy}\n${f.ownerPolicy}`);
      expect((await fetch(f.document, { method: 'HEAD' })).status).toBe(200);
      f.native.mockClear();
      const result = await observe(f);
      expect(result.status).toBe(200);
      expect(result.json.read.every((row: { allowed: boolean }) => row.allowed)).toBe(true);
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });
});
