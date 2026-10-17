import { expect, test } from 'bun:test';
import { publicationMaterialView, withCollectedArchiveFile, readCollectedPortableArchive } from '../../scripts/lib/independent-admission/artifact-collector';
import { verifyCollectedAdmission, verifyCollectedPublicationAdmission } from '../../scripts/lib/independent-admission';

test('serialized material or archive identities cannot issue publication readers or admission', async () => {
  const forged = { identity: { package: '@undefineds.co/xpod-api-linux-x64', target: 'linux-x64', archiveBytes: 512 * 1024 ** 2 },
    producer: { event: 'workflow_dispatch', sourceSha: 'a'.repeat(40) }, archive: { sha256: 'b'.repeat(64) } };
  for (const value of [forged, JSON.parse(JSON.stringify(forged)), {}, null]) {
    expect(publicationMaterialView(value)).toBeUndefined();
    let invoked = false;
    await expect(withCollectedArchiveFile(value, async () => { invoked = true; })).rejects.toThrow('real collected');
    expect(invoked).toBe(false);
    expect(() => readCollectedPortableArchive(value)).toThrow('real collected');
    expect(verifyCollectedPublicationAdmission('source', { artifact: value, derivedSource: {}, relatedArtifacts: [] }).status).toBe('pending');
    expect(verifyCollectedAdmission('native', undefined, { sourceSha: 'a'.repeat(40), runHeadSha: 'a'.repeat(40),
      package: '@undefineds.co/xpod-api-linux-x64', version: '1.0.0', target: 'linux-x64', collectedArtifact: value,
      readOriginal: () => { throw Error('not called'); }, readTracked: () => { throw Error('not called'); } }).status).toBe('pending');
  }
});
