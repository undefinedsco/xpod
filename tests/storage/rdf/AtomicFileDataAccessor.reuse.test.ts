import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { AtomicFileDataAccessor, ExtensionBasedMapper, RepresentationMetadata, guardStream }
  from '@solid/community-server';

/**
 * B-owned nonacceptance reuse lock for the installed CSS AtomicFileDataAccessor used as the RDF authority
 * mirror. Verifies the temp -> rename -> metadata body guarantee and its no-overclaim boundary (body and
 * metadata are separate writes; a body-stream error retains the old complete body/metadata and cleans the
 * accessor's OWN staging temp). Fixtures are owned under .test-data/rdf-atomic-accessor-reuse/.
 */
const ROOT_URL = 'http://localhost/';
const identifier = { path: `${ROOT_URL}alice/room/doc.ttl` };
const BASE_DIR = path.resolve('.test-data/rdf-atomic-accessor-reuse');
async function makeRoot(): Promise<string> {
  await mkdir(BASE_DIR, { recursive: true });
  return await mkdtemp(path.join(BASE_DIR, 'case-'));
}
const metadataFor = (revision: string, contentType = 'text/turtle'): RepresentationMetadata => {
  const metadata = new RepresentationMetadata(identifier);
  metadata.contentType = contentType;
  // A non-content-type quad makes the metadata file materialize, so retention is observable; a distinct
  // revision value makes "old metadata retained" distinguishable from an early replacement write.
  metadata.add(DataFactory.namedNode('urn:xpod:test:revision'), DataFactory.literal(revision));
  return metadata;
};
/** Do NOT swallow readdir errors: expected directories must exist after CSS writes. */
async function names(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}
const delay = async(ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)); };

describe('installed CSS AtomicFileDataAccessor reuse for the RDF authority mirror', () => {
  it('writes body then metadata through the internal staging directory and leaves no temp files', async() => {
    const root = await makeRoot();
    try {
      await mkdir(path.join(root, 'alice/room'), { recursive: true });
      const accessor = new AtomicFileDataAccessor(new ExtensionBasedMapper(ROOT_URL, root), root, '/.internal/tempFiles/');
      await accessor.writeDocument(identifier, guardStream(Readable.from([ '<a> <b> <c> .' ])), metadataFor('old'));
      expect(await readFile(path.join(root, 'alice/room/doc.ttl'), 'utf8')).toBe('<a> <b> <c> .');
      expect(await names(path.join(root, 'alice/room'))).toEqual([ 'doc.ttl', 'doc.ttl.meta' ]);
      expect(await readFile(path.join(root, 'alice/room/doc.ttl.meta'), 'utf8')).toContain('old');
      // Staging lives OUTSIDE the owner Pod under the server root, and is empty after a successful commit.
      expect(await names(path.join(root, '.internal/tempFiles'))).toEqual([]);
      expect(await names(path.join(root, 'alice'))).toEqual([ 'room' ]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('observes real partial bytes in the new staging temp, then retains the old complete body and metadata when the body stream errors', async() => {
    const root = await makeRoot();
    try {
      await mkdir(path.join(root, 'alice/room'), { recursive: true });
      const staging = path.join(root, '.internal/tempFiles');
      const accessor = new AtomicFileDataAccessor(new ExtensionBasedMapper(ROOT_URL, root), root, '/.internal/tempFiles/');
      await accessor.writeDocument(identifier, guardStream(Readable.from([ '<old> <p> <o> .' ])), metadataFor('old'));
      const oldBody = await readFile(path.join(root, 'alice/room/doc.ttl'), 'utf8');
      const oldMeta = await readFile(path.join(root, 'alice/room/doc.ttl.meta'), 'utf8');

      // A controllable stream: emit real partial bytes, keep it open so they land in the staging temp.
      const failing = new Readable({ read() { /* data is pushed explicitly below */ } });
      failing.push('<partial> <p> <o> .');
      const write = accessor.writeDocument(identifier, guardStream(failing), metadataFor('replacement'));

      // Observe the NEW own staging temp with the partial bytes before we destroy the stream.
      let tempName: string | undefined;
      for (let attempt = 0; attempt < 400; attempt++) {
        const entries = await names(staging);
        if (entries.length === 1) {
          const partial = await readFile(path.join(staging, entries[0]), 'utf8');
          if (partial === '<partial> <p> <o> .') { tempName = entries[0]; break; }
        } else if (entries.length > 1) {
          throw new Error(`Unexpected multiple staging temps: ${entries.join(', ')}`);
        }
        await delay(5);
      }
      expect(tempName, 'a new staging temp with the pushed partial bytes must appear').toBeDefined();
      expect(await readFile(path.join(staging, tempName!), 'utf8')).toBe('<partial> <p> <o> .');

      failing.destroy(new Error('stream failed mid-body'));
      await expect(write).rejects.toThrow();
      // The old complete body AND the old metadata survive; the replacement metadata is never written.
      expect(await readFile(path.join(root, 'alice/room/doc.ttl'), 'utf8')).toBe(oldBody);
      expect(await readFile(path.join(root, 'alice/room/doc.ttl.meta'), 'utf8')).toBe(oldMeta);
      expect(await readFile(path.join(root, 'alice/room/doc.ttl.meta'), 'utf8')).toContain('old');
      expect(await names(staging)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
