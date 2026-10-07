// Root-owned prerequisite calibration: actual CSS/index/native protocol and ORM source.
// Counted principals and Comunica are not Gateway DPoP or production QLever evidence.
import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { actualMembershipAcpFixture } from '../helpers/ActualMembershipWacFixture';
import { expectedSourceDigest, rootAcpPolicy } from '../helpers/GuardedPolicyClosureFixture';
import { canonicalSourceFenceSparql } from '../../src/api/matrix/canonicalSourceFence';
import { AUTHORIZATION_OBSERVATION_MEDIA_TYPE, parseAuthorizationObservationResponse }
  from '../../src/storage/rdf/AuthorizationObservation';
import { GUARDED_SPARQL_MEDIA_TYPE } from '../../src/storage/rdf/GuardedPolicySnapshot';

describe('root actual ACP direct-policy primitive prerequisite', () => {
  it.each(['absent404', 'present-empty'] as const)(
    'creates and removes an additive Read grant from %s without losing inherited owner access', async state => {
      await actualMembershipAcpFixture(async f => {
        if (state === 'present-empty') await f.putRdf(f.roomAcl, '');
        const initial = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
        const head = async (iri: string, principal: string) => {
          const response = await fetch(iri, { method: 'HEAD', headers: { 'x-root-fixture-principal': principal } });
          await response.arrayBuffer();
          return response.status;
        };
        const observe = async () => {
          const request = await f.observationRequest(f.actor);
          const response = await fetch(`${f.room}-/sparql`, { method: 'POST',
            headers: { 'content-type': AUTHORIZATION_OBSERVATION_MEDIA_TYPE,
              'x-root-fixture-principal': f.owner }, body: JSON.stringify(request) });
          const text = await response.text();
          expect(response.status, text).toBe(200);
          return parseAuthorizationObservationResponse(JSON.parse(text));
        };
        const guardedUpdate = async (update: string, guard: Awaited<ReturnType<typeof observe>>['guard']) => {
          const response = await fetch(`${f.room}-/sparql`, { method: 'POST',
            headers: { 'content-type': GUARDED_SPARQL_MEDIA_TYPE,
              'x-root-fixture-principal': f.owner }, body: JSON.stringify({ version: 1, update, guard }) });
          const body = await response.text();
          expect(response.status, body).toBe(204);
        };
        expect(await head(f.room, f.owner)).toBe(200);
        expect(await head(f.document, f.owner)).toBe(200);
        expect(await head(f.document, f.actor)).toBe(403);
        const before = await observe();
        expect(before.guard.profile).toBe('acp-ground-v1');
        expect(before.guard.resources.find(row => row.iri === f.room)?.policyIri).toBe(f.roomAcl);
        expect(before.guard.policies.find(row => row.iri === f.roomAcl)?.state).toBe(state);
        expect(before.read.every(row => !row.allowed)).toBe(true);

        const body = rootAcpPolicy(f.roomAcl, f.room, f.actor, ['Read'], { label: 'primitive-reader' });
        const where = canonicalSourceFenceSparql(initial);
        f.native.mockClear();
        await guardedUpdate(`INSERT { GRAPH <${f.roomAcl}> { ${body} } } WHERE { ${where} }`, before.guard);
        expect(f.native).toHaveBeenCalledTimes(1);
        expect(f.queryEngine.queryVoid).not.toHaveBeenCalled();
        expect(await head(f.room, f.actor)).toBe(200);
        expect(await head(f.document, f.actor)).toBe(200);
        expect(await head(f.roomAcl, f.actor)).toBe(403);
        expect(await head(f.document, f.owner)).toBe(200);
        const installed = await observe(); // Requires actual requester Control and ordinary Read again.
        expect(installed.read.every(row => row.allowed)).toBe(true);
        expect(installed.guard.policies.find(row => row.iri === f.roomAcl)?.state).toBe('present');

        // Delete only the nine Read-owned triples; keep the ACR type/resource shell.
        const acr = `${f.roomAcl}#acr`;
        const owned = new Parser({ baseIRI: f.roomAcl }).parse(body).filter(q =>
          q.subject.value !== acr || q.predicate.value.endsWith('accessControl')
          || q.predicate.value.endsWith('memberAccessControl'));
        expect(owned).toHaveLength(9);
        const triples = owned.map(q => `<${q.subject.value}> <${q.predicate.value}> <${q.object.value}> .`).join('\n');
        await guardedUpdate(`DELETE { GRAPH <${f.roomAcl}> { ${triples} } } WHERE { ${where} }`, installed.guard);
        expect(f.native).toHaveBeenCalledTimes(2);
        expect(await head(f.room, f.actor)).toBe(403);
        expect(await head(f.document, f.actor)).toBe(403);
        expect(await head(f.document, f.owner)).toBe(200);
        const removed = await observe();
        expect(removed.read.every(row => !row.allowed)).toBe(true);
        const current = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
        expect(expectedSourceDigest(f.source, f.document, current.quads))
          .toBe(expectedSourceDigest(f.source, f.document, initial.quads));
        const remaining = await f.policyBody(f.roomAcl);
        expect(remaining).toHaveLength(2);
        expect(remaining.every(q => q.subject.value === acr)).toBe(true);
      });
    });

  it.each(['untyped', 'foreign resource', 'orphan control', 'second ACR'] as const)(
    'refuses a malformed empty ACR shell (%s) before native effects', async shape => {
      await actualMembershipAcpFixture(async f => {
        const acp = 'http://www.w3.org/ns/solid/acp#';
        const acr = `${f.roomAcl}#acr`;
        const shell = `<${acr}> a <${acp}AccessControlResource>; <${acp}resource> <${f.room}> .`;
        await f.putRdf(f.roomAcl, shell);
        const initial = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
        const response = await fetch(`${f.room}-/sparql`, { method: 'POST',
          headers: { 'content-type': AUTHORIZATION_OBSERVATION_MEDIA_TYPE,
            'x-root-fixture-principal': f.owner }, body: JSON.stringify(await f.observationRequest(f.actor)) });
        const text = await response.text();
        expect(response.status, text).toBe(200);
        const { guard } = parseAuthorizationObservationResponse(JSON.parse(text));
        let malformed = shell;
        if (shape === 'untyped') malformed = `<${acr}> <${acp}resource> <${f.room}> .`;
        if (shape === 'foreign resource') malformed = shell.replace(`<${f.room}>`, `<${f.pod}>`);
        if (shape === 'orphan control') malformed += `\n<${f.roomAcl}#orphan> a <${acp}AccessControl> .`;
        if (shape === 'second ACR') malformed += `\n<${f.roomAcl}#other> a <${acp}AccessControlResource>; <${acp}resource> <${f.room}> .`;
        await f.putRdf(f.roomAcl, malformed);
        f.native.mockClear();
        const update = `INSERT { GRAPH <${f.roomAcl}> { <${acr}> <urn:root:must-not-write> <urn:root:value> } }
          WHERE { ${canonicalSourceFenceSparql(initial)} }`;
        const refused = await fetch(`${f.room}-/sparql`, { method: 'POST',
          headers: { 'content-type': GUARDED_SPARQL_MEDIA_TYPE,
            'x-root-fixture-principal': f.owner }, body: JSON.stringify({ version: 1, update, guard }) });
        const refusal = await refused.text();
        expect(refused.status, refusal).toBe(415);
        expect(f.native).not.toHaveBeenCalled();
        const current = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
        expect(expectedSourceDigest(f.source, f.document, current.quads))
          .toBe(expectedSourceDigest(f.source, f.document, initial.quads));
      });
    });
});
