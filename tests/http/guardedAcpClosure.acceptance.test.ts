// Root-owned actual CSS ACP reader/HTTP/shared-lock and persisted native-protocol
// checks. Fixture identities are not DPoP/current Gateway or production QLever.
import { describe, expect, it, vi } from 'vitest';
import { Parser } from 'n3';
import { NotFoundHttpError } from '@solid/community-server';
import { AuthorityResourceTracker, authorityResourceTracker } from '../../src/storage/AuthorityResourceTracker';
import { metadataRequestContext } from '../../src/storage/MetadataRequestContext';
import { guardedPolicyClosureFixture, expectedGroundDigest, rootAcpPolicy } from '../helpers/GuardedPolicyClosureFixture';

const acp = 'http://www.w3.org/ns/solid/acp#';
const read = async (iri: string, agent: string) => {
  const response = await fetch(iri, {method: 'HEAD', headers: {'x-root-fixture-principal': agent}});
  await response.arrayBuffer();
  return response.status;
};
const fixture = <T>(run: Parameters<typeof guardedPolicyClosureFixture<T>>[0]) => guardedPolicyClosureFixture(run, {policyKind: 'acp'});

describe('independent ACP actual-root closure and HTTP semantics', () => {
  it.each(['missing', 'empty'] as const)('keeps inherited Read through a %s direct ACR', async state => {
    await fixture(async f => {
      const bob = `${f.origin}bob/profile/card#me`;
      const inherited = rootAcpPolicy(f.podAcl, f.pod, bob, ['Read'], {label: 'bob'});
      await f.putRdf(f.podAcl, `${f.ownerPolicy}\n${inherited}`);
      if (state === 'empty') await f.putRdf(f.policyIri(f.document), '');
      expect(await read(f.document, bob)).toBe(200);
      expect(await read(f.room, bob)).toBe(200);
    });
  });
  it('actual server-root deny overrides a direct allow, independently of triple order', async () => {
    await fixture(async f => {
      const bob = `${f.origin}bob/profile/card#me`;
      const direct = f.policyIri(f.document);
      await f.putRdf(direct, rootAcpPolicy(direct, f.document, bob, ['Read'], {selfOnly: true}));
      expect(await read(f.document, bob)).toBe(200);
      const root = f.policyIri(f.origin);
      const denied = rootAcpPolicy(root, f.origin, bob, ['Read'], {deny: true});
      await f.putRdf(root, denied);
      expect(await read(f.document, bob)).toBe(403);
      const quads = new Parser({baseIRI: root}).parse(denied);
      const reversed = [...quads].reverse().map(value => `<${value.subject.value}> <${value.predicate.value}> <${value.object.value}> .`).join('\n');
      await f.putRdf(root, reversed);
      expect(await read(f.document, bob)).toBe(403);
    });
  });
  it('accessControl for a container does not grant its children', async () => {
    await fixture(async f => {
      const bob = `${f.origin}bob/profile/card#me`;
      await f.putRdf(f.roomAcl, rootAcpPolicy(f.roomAcl, f.room, bob, ['Read'], {selfOnly: true}));
      expect(await read(f.room, bob)).toBe(200);
      expect(await read(f.document, bob)).toBe(403);
    });
  });
  it('Control maps to ACR Read without allowing ordinary content Read', async () => {
    await fixture(async f => {
      const bob = `${f.origin}bob/profile/card#me`;
      await f.putRdf(f.roomAcl, rootAcpPolicy(f.roomAcl, f.room, bob, ['Control']));
      expect(await read(f.roomAcl, bob)).toBe(200);
      expect(await read(f.document, bob)).toBe(403);
    });
  });
  it.each(['PublicAgent', 'AuthenticatedAgent'] as const)('supports the installed %s value under acp:agent, with no invented agentClass', async special => {
    await fixture(async f => {
      await f.putRdf(f.roomAcl, rootAcpPolicy(f.roomAcl, f.room, `${acp}${special}`, ['Read']));
      expect(await read(f.document, `${f.origin}bob/profile/card#me`)).toBe(200);
      expect(await read(f.document, '')).toBe(special === 'PublicAgent' ? 200 : 403);
      const guard = f.expected();
      const body = rootAcpPolicy(f.roomAcl, f.room, `${acp}${special}`, ['Read']);
      Object.assign(guard.policies.find(value => value.iri === f.roomAcl)!, {
        state: 'present', digest: expectedGroundDigest(f.roomAcl, new Parser({baseIRI: f.roomAcl}).parse(body), 'acp'),
      });
      f.native.mockClear();
      const response = await f.post({version: 1, update: f.sourceUpdate, guard});
      expect(response.status, response.text).toBe(204);
      expect(f.native).toHaveBeenCalledOnce();
    });
  });
  it('includes a missing actual root beyond the registered Pod despite a present Pod ACR', async () => {
    await fixture(async f => {
      const closure = await f.readClosure();
      expect(closure.profile).toBe('acp-ground-v1');
      expect(closure.ancestors).toContainEqual({iri: f.origin, policyIri: f.policyIri(f.origin)});
      expect(closure.policies).toContainEqual({iri: f.policyIri(f.origin), kind: 'acp', state: 'absent404', digest: null});
      expect(closure.resources.every(value => value.iri.startsWith(f.room))).toBe(true);
    });
  });
  it.each(['source', 'policy'] as const)('accepts an unchanged actual-root closure and persists one guarded %s update', async kind => {
    await fixture(async f => {
      const response = await f.post({version: 1, update: kind === 'source' ? f.sourceUpdate : f.policyUpdate, guard: f.expected()});
      expect(response.status, response.text).toBe(204);
      expect(f.native).toHaveBeenCalledOnce();
      expect(f.queryEngine.queryVoid).not.toHaveBeenCalled();
      expect(await f.readPersisted(kind === 'source' ? f.document : f.roomAcl)).toContain(kind === 'source' ? 'committed' : acp);
    });
  });
  it.each(['source', 'policy'] as const)('rejects creation of an observed-missing server-root ACR before %s native write', async kind => {
    await fixture(async f => {
      const guard = f.expected();
      const root = f.policyIri(f.origin);
      await f.putRdf(root, rootAcpPolicy(root, f.origin, `${f.origin}bob/profile/card#me`, ['Read'], {deny: true}));
      f.native.mockClear();
      const before = await f.readPersisted(f.document);
      const response = await f.post({version: 1, update: kind === 'source' ? f.sourceUpdate : f.policyUpdate, guard});
      expect(response.status, response.text).toBe(409);
      expect(f.native).not.toHaveBeenCalled();
      expect(await f.readPersisted(f.document)).toBe(before);
    });
  });
  it('distinguishes a present-empty root and detects its later full policy', async () => {
    await fixture(async f => {
      const root = f.policyIri(f.origin);
      await f.putRdf(root, '');
      const guard = f.expected();
      const entry = guard.policies.find(value => value.iri === root)!;
      Object.assign(entry, {state: 'present-empty', digest: expectedGroundDigest(root, [], 'acp')});
      await f.putRdf(root, rootAcpPolicy(root, f.origin, `${f.origin}bob/profile/card#me`, ['Read']));
      f.native.mockClear();
      const response = await f.post({version: 1, update: f.sourceUpdate, guard});
      expect(response.status, response.text).toBe(409);
      expect(f.native).not.toHaveBeenCalled();
    });
  });
  it('does not allow a write outside the room merely because server-root policy is observed', async () => {
    await fixture(async f => {
      const root = f.policyIri(f.origin);
      const update = f.policyUpdate.replaceAll(`<${f.roomAcl}>`, `<${root}>`);
      const response = await f.post({version: 1, update, guard: f.expected()});
      expect([400, 415], response.text).toContain(response.status);
      expect(f.native).not.toHaveBeenCalled();
    });
  });
  it('does not require materialized metadata for the strategy-defined virtual authorization root', async () => {
    await fixture(async f => {
      const original = f.accessor.getMetadata.bind(f.accessor);
      const metadata = vi.spyOn(f.accessor, 'getMetadata').mockImplementation(async identifier => {
        if (identifier.path === f.origin) throw new NotFoundHttpError('Virtual strategy root');
        return original(identifier);
      });
      try {
        const closure = await f.readClosure();
        expect(closure.ancestors).toContainEqual({iri: f.origin, policyIri: f.policyIri(f.origin)});
        expect(metadata.mock.calls.some(([identifier]) => identifier.path === f.origin)).toBe(false);
      } finally { metadata.mockRestore(); }
    });
  });
  it.each(['untyped ACR', 'foreign resource', 'missing matcher', 'cross-document matcher', 'noneOf-only',
    'applyMembers', 'client attribute', 'literal agent', 'unknown ACP predicate', 'untyped second ACR', 'invented agentClass'] as const)('refuses %s before any native mutation', async shape => {
    await fixture(async f => {
      let body = rootAcpPolicy(f.roomAcl, f.room, f.owner, ['Read', 'Write', 'Control']);
      if (shape === 'untyped ACR') body = body.replace(`a <${acp}AccessControlResource>; `, '');
      if (shape === 'foreign resource') body = body.replace(`<${acp}resource> <${f.room}>`, `<${acp}resource> <${f.pod}>`);
      if (shape === 'missing matcher') body = body.replace(new RegExp(`<${f.roomAcl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#owner-matcher> a[\\s\\S]*$`, 'u'), '');
      if (shape === 'cross-document matcher') body = body.replaceAll(`<${f.roomAcl}#owner-matcher>`, `<${f.podAcl}#owner-matcher>`);
      if (shape === 'noneOf-only') body = body.replace(`<${acp}anyOf>`, `<${acp}noneOf>`);
      if (shape === 'applyMembers') body = body.replace(`<${acp}apply>`, `<${acp}applyMembers>`);
      if (shape === 'client attribute') body += `\n<${f.roomAcl}#owner-matcher> <${acp}client> <${acp}PublicClient> .`;
      if (shape === 'literal agent') body = body.replace(`<${acp}agent> <${f.owner}>`, `<${acp}agent> ${JSON.stringify(f.owner)}`);
      if (shape === 'unknown ACP predicate') body += `\n<${f.roomAcl}#owner-matcher> <${acp}unsupportedCondition> "unknown" .`;
      if (shape === 'untyped second ACR') body += `\n<${f.roomAcl}#untyped-acr> <${acp}resource> <${f.room}>; <${acp}accessControl> <${f.roomAcl}#owner-control> .`;
      if (shape === 'invented agentClass') body += `\n<${f.roomAcl}#owner-matcher> <${acp}agentClass> <${acp}PublicAgent> .`;
      await f.putRdf(f.roomAcl, body);
      const guard = f.expected();
      Object.assign(guard.policies.find(value => value.iri === f.roomAcl)!, {
        state: 'present', digest: expectedGroundDigest(f.roomAcl, new Parser({baseIRI: f.roomAcl}).parse(body), 'acp'),
      });
      f.native.mockClear();
      const response = await f.post({version: 1, update: f.sourceUpdate, guard});
      expect(response.status, JSON.stringify({response, nativeWrites: f.native.mock.calls.length})).toBe(415);
      expect(f.native).not.toHaveBeenCalled();
      expect(await f.readPersisted(f.document)).toContain('pending');
    });
  });
  it('guards all eight historical days while direct policies still require actual-root ancestry', async () => {
    await fixture(async f => {
      const bob = `${f.origin}bob/profile/card#me`;
      await f.putRdf(f.roomAcl, rootAcpPolicy(f.roomAcl, f.room, bob, ['Read']));
      const dates = Array.from({length: 8}, (_, i) => `2026-09-${String(20 + i).padStart(2, '0')}`);
      const histories: string[] = [];
      for (const date of dates) {
        const container = `${f.room}${date}/`;
        await f.putContainer(container);
        const history = `${container}events.ttl`;
        await f.putRdf(history, '<urn:history> <urn:text> "old history" .');
        histories.push(history);
      }
      for (const history of histories) expect(await read(history, bob)).toBe(200);
      const denied = f.policyIri(histories[0]);
      await f.putRdf(denied, rootAcpPolicy(denied, histories[0], bob, ['Read'], {deny: true, selfOnly: true}));
      expect(await read(histories[0], bob)).toBe(403);
      expect(await read(histories[7], bob)).toBe(200);
      const closure = await f.readClosure();
      expect(histories.every(history => closure.resources.some(value => value.iri === history))).toBe(true);
      expect(closure.ancestors.some(value => value.iri === f.origin)).toBe(true);
    });
  });
  it.each(['source', 'policy'] as const)('rejects a warm missing actual-root ACR changed by the shared writer before locked %s commit', async kind => {
    await fixture(async f => {
      const root = f.policyIri(f.origin);
      const guard = f.expected();
      const generation = authorityResourceTracker.snapshot(root);
      const otherWorker = new AuthorityResourceTracker();
      const originalPlan = f.locks.withWriteLockAndReadDependencies.bind(f.locks);
      const plan = vi.spyOn(f.locks, 'withWriteLockAndReadDependencies').mockImplementationOnce(async (...args) => {
        const mutation = vi.spyOn(authorityResourceTracker, 'runMutation').mockImplementation((iri, callback) => otherWorker.runMutation(iri, callback));
        try {
          await metadataRequestContext.run({metadataCache: new Map()}, () => f.putRdf(root,
            rootAcpPolicy(root, f.origin, `${f.origin}bob/profile/card#me`, ['Read'], {deny: true})));
        } finally { mutation.mockRestore(); }
        return originalPlan(...args);
      });
      try {
        f.native.mockClear();
        const response = await f.post({version: 1, update: kind === 'source' ? f.sourceUpdate : f.policyUpdate, guard});
        expect(otherWorker.generation(root)).toBe(1);
        expect(authorityResourceTracker.snapshot(root)).toEqual(generation);
        expect(response.status, response.text).toBe(409);
        expect(f.native).not.toHaveBeenCalled();
        expect(await f.readPersisted(f.document)).toContain('pending');
      } finally { plan.mockRestore(); }
    });
  });
});
