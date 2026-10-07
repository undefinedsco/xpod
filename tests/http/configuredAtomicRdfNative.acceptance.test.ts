// Root-owned configured accessor and actual HTTP/native-protocol acceptance.
// Fixture identities and Comunica do not prove user Gateway DPoP or production QLever.
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { AtomicFileDataAccessor, RepresentationMetadata, guardStream } from '@solid/community-server';
import { ComponentsManager } from 'componentsjs';
import { Parser } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { guardedPolicyClosureFixture } from '../helpers/GuardedPolicyClosureFixture';

type Fixture = Parameters<Parameters<typeof guardedPolicyClosureFixture>[0]>[0];
const mixPrefix = 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/dist/storage/accessors/MixDataAccessor.jsonld#MixDataAccessor_';

async function configuredFixture(
  kind: 'wac' | 'acp', run: (fixture: Fixture, files: AtomicFileDataAccessor) => Promise<void>,
): Promise<void> {
  let files: AtomicFileDataAccessor | undefined;
  await guardedPolicyClosureFixture(async fixture => {
    if (!files) throw new Error('Configured RDF accessor was not instantiated');
    await run(fixture, files);
  }, {
    policyKind: kind,
    rdfFileDataAccessor: async ({ origin, rootFilePath }) => {
      const manager = await ComponentsManager.build({
        mainModulePath: path.resolve('.'), typeChecking: false, dumpErrorState: false,
      });
      await manager.configRegistry.register(path.resolve('config/local.json'));
      const mix = manager.objectLoader.resources['urn:undefineds:xpod:MixDataAccessor'];
      const target = mix?.property[`${mixPrefix}rdfFileDataAccessor`];
      if (!target) throw new Error('Actual local profile has no explicit RDF accessor');
      files = await manager.instantiate<AtomicFileDataAccessor>(target.value, { variables: {
        'urn:solid-server:default:variable:baseUrl': origin,
        'urn:solid-server:default:variable:rootFilePath': rootFilePath,
      } });
      expect(files).toBeInstanceOf(AtomicFileDataAccessor);
      return files;
    },
  });
}

describe('independent actual configured RDF atomic native boundary', () => {
  it.each(['wac', 'acp'] as const)('persists a guarded %s source update through the configured writer, preserving unrelated RDF', async kind => {
    await configuredFixture(kind, async (f, files) => {
      const before = new Parser({ baseIRI: f.document }).parse(await f.readPersisted(f.document));
      const writes = vi.spyOn(files, 'writeDocument');
      try {
        const response = await f.post({ version: 1, update: f.sourceUpdate, guard: f.expected() });
        expect(response.status, response.text).toBe(204);
        expect(f.native).toHaveBeenCalledOnce();
        expect(f.queryEngine.queryVoid).not.toHaveBeenCalled();
        expect(writes.mock.calls.some(([identifier]) => identifier.path === f.document)).toBe(true);
        const after = new Parser({ baseIRI: f.document }).parse(await f.readPersisted(f.document));
        expect(after).toHaveLength(before.length);
        for (const quad of before.filter(q => !q.object.value.includes('acceptancePhase'))) {
          expect(after.some(value => value.equals(quad))).toBe(true);
        }
        expect(after.some(q => q.object.value.includes('committed'))).toBe(true);
        const read = await fetch(f.document, { headers: { 'x-root-fixture-principal': f.owner } });
        expect(read.status).toBe(200);
        expect(await read.text()).toContain('committed');
      } finally { writes.mockRestore(); }
    });
  });

  it('persists an ACP policy update through the configured writer and refuses the subsequently stale closure', async () => {
    await configuredFixture('acp', async (f, files) => {
      const guard = f.expected();
      const sourceBefore = await f.readPersisted(f.document);
      const writes = vi.spyOn(files, 'writeDocument');
      try {
        const response = await f.post({ version: 1, update: f.policyUpdate, guard });
        expect(response.status, response.text).toBe(204);
        expect(f.native).toHaveBeenCalledOnce();
        expect(writes.mock.calls.some(([identifier]) => identifier.path === f.roomAcl)).toBe(true);
        expect(await f.readPersisted(f.roomAcl)).toContain('http://www.w3.org/ns/solid/acp#');
        expect(await f.readPersisted(f.document)).toBe(sourceBefore);
        f.native.mockClear(); writes.mockClear();
        const stale = await f.post({ version: 1, update: f.sourceUpdate, guard });
        expect(stale.status, stale.text).toBe(409);
        expect(f.native).not.toHaveBeenCalled();
        expect(writes).not.toHaveBeenCalled();
        expect(await f.readPersisted(f.document)).toBe(sourceBefore);
      } finally { writes.mockRestore(); }
    });
  });

  it('hides an actual incomplete staged replacement from Pod listing and HTTP reads, then removes its own failed temp', async () => {
    await configuredFixture('acp', async (f, files) => {
      const staging = path.join(f.directory, 'data/.internal/tempFiles');
      const beforeNames = new Set(await readdir(staging));
      const before = await f.readPersisted(f.document);
      const metadata = new RepresentationMetadata({ path: f.document }, 'text/turtle');
      const held = new PassThrough();
      const finished = files.writeDocument({ path: f.document }, guardStream(held), metadata)
        .then(() => undefined, error => error as Error);
      const partial = '<urn:root:atomic-hidden> <urn:root:value> "incomplete';
      held.write(partial);
      try {
        let name: string | undefined;
        const deadline = Date.now() + 5000;
        while (!name && Date.now() < deadline) {
          for (const candidate of await readdir(staging)) {
            if (!beforeNames.has(candidate) && await readFile(path.join(staging, candidate), 'utf8') === partial) {
              name = candidate; break;
            }
          }
          if (!name) await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(name).toBeDefined();
        expect(await f.readPersisted(f.document)).toBe(before);
        const children: string[] = [];
        for await (const child of files.getChildren({ path: f.pod })) children.push(child.identifier.value);
        expect(children.some(iri => iri.includes('.internal') || iri.includes('temp-'))).toBe(false);
        const response = await fetch(`${f.origin}.internal/tempFiles/${name}`, {
          headers: { 'x-root-fixture-principal': f.owner },
        });
        expect([403, 404]).toContain(response.status);
        expect(await response.text()).not.toContain(partial);
      } finally {
        held.destroy(new Error('Root owned incomplete write cancelled'));
        expect(await finished).toBeInstanceOf(Error);
      }
      expect(await f.readPersisted(f.document)).toBe(before);
      expect(await readdir(staging)).toEqual([...beforeNames]);
    });
  });
});
