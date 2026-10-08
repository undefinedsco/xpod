import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataFactory } from 'n3';
import { NotFoundHttpError, RepresentationMetadata, SingleRootIdentifierStrategy } from '@solid/community-server';
import { LocalPodContainerMetadataInitializer } from '../../src/provision/LocalPodContainerMetadataInitializer';
import { LocalPodProvisioningService } from '../../src/provision/LocalPodProvisioningService';
import { PodDeletionOperationRepository } from '../../src/identity/drizzle/PodDeletionOperationRepository';
import { PodLookupRepository } from '../../src/identity/drizzle/PodLookupRepository';
import { SolidRdfEngine } from '../../src/storage/rdf';
import { SolidRdfDataAccessor } from '../../src/storage/accessors/SolidRdfDataAccessor';
import { createTestDir } from '../utils/sqlite';

const { namedNode } = DataFactory;
const baseUrl = 'https://node.example/';
const fixtures: Array<{ directory: string; accessor: SolidRdfDataAccessor }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.accessor.finalize();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

async function fixture(managed = true, authMode = 'acp') {
  const directory = createTestDir('local-pod-bootstrap-upgrade');
  const identityDbUrl = `sqlite:${path.join(directory, 'identity.sqlite')}`;
  const rdfIndexPath = path.join(directory, 'rdf-index.sqlite');
  const service = new LocalPodProvisioningService({ baseUrl, rootDir: path.join(directory, 'data'),
    identityDbUrl, rdfIndexPath, sparqlEndpoint: `sqlite:${path.join(directory, 'quints.sqlite')}`,
    oidcIssuer: managed ? 'https://id.example/' : baseUrl, authMode });
  const pod = await service.createPod({ podName: 'alice', webId: managed
    ? 'https://id.example/alice/profile/card#me' : `${baseUrl}alice/profile/card#me` });
  const engine = new SolidRdfEngine({ index: { path: rdfIndexPath } });
  await engine.open();
  const accessor = new SolidRdfDataAccessor(engine, new SingleRootIdentifierStrategy(baseUrl));
  fixtures.push({ directory, accessor });
  const settings = `${pod.podUrl}settings/`;
  // Reproduce the legacy server's missing operational metadata, preserving authoritative containment.
  await engine.delete({ graph: namedNode(`meta:${settings}`) });
  const initializer = new LocalPodContainerMetadataInitializer(accessor, identityDbUrl, baseUrl);
  const operations = new PodDeletionOperationRepository(identityDbUrl);
  return { directory, identityDbUrl, engine, accessor, settings, pod, initializer, operations };
}

describe('LocalPodContainerMetadataInitializer', () => {
  it.each([
    { managed: false, authMode: 'acp' }, { managed: false, authMode: 'acl' },
    { managed: true, authMode: 'acp' }, { managed: true, authMode: 'acl' },
  ])('repairs old advertised metadata before serving (managed=$managed, auth=$authMode)', async ({ managed, authMode }) => {
    const f = await fixture(managed, authMode);
    const original = path.join(f.directory, 'data/alice/original.txt');fs.writeFileSync(original, 'unchanged original');
    await expect(f.accessor.getMetadata({ path: f.settings })).rejects.toBeInstanceOf(NotFoundHttpError);
    await f.initializer.handle();
    await expect(f.accessor.getMetadata({ path: f.settings })).resolves.toBeInstanceOf(RepresentationMetadata);
    const first = await f.engine.scan({ pattern: { graph: namedNode(`meta:${f.settings}`) } });
    await f.initializer.handle();
    const second = await f.engine.scan({ pattern: { graph: namedNode(`meta:${f.settings}`) } });
    expect(second.quads).toEqual(first.quads);
    expect(fs.readFileSync(original, 'utf8')).toBe('unchanged original');
  });

  it('preserves existing operational metadata exactly', async () => {
    const f = await fixture();
    const metadata = new RepresentationMetadata({ path: f.settings });
    metadata.add(namedNode('https://example/custom'), DataFactory.literal('preserved'));
    await f.accessor.writeContainer({ path: f.settings }, metadata);
    const before = await f.engine.scan({ pattern: { graph: namedNode(`meta:${f.settings}`) } });
    await f.initializer.handle();
    expect((await f.engine.scan({ pattern: { graph: namedNode(`meta:${f.settings}`) } })).quads).toEqual(before.quads);
  });

  it.each(['containment', 'root metadata'])('does not invent containers when %s is absent', async (missing) => {
    const f = await fixture();
    await f.engine.delete(missing === 'containment'
      ? { graph: namedNode(f.pod.podUrl), object: namedNode(f.settings) }
      : { graph: namedNode(`meta:${f.pod.podUrl}`) });
    await f.initializer.handle();
    await expect(f.accessor.getMetadata({ path: f.settings })).rejects.toBeInstanceOf(NotFoundHttpError);
  });

  it('does not repair a Pod with pending deletion', async () => {
    const f = await fixture();
    await f.operations.create({ accountId: f.pod.accountId, podId: f.pod.podId, storageUrl: f.pod.podUrl, nodeId: 'local' });
    await f.initializer.handle();
    await expect(f.accessor.getMetadata({ path: f.settings })).rejects.toBeInstanceOf(NotFoundHttpError);
  });

  it('fails safely on a competing lifecycle operation and leaves its reservation intact', async () => {
    const f = await fixture();
    await f.operations.reserveStorage(f.pod.podUrl, 'other-create', 'create');
    await expect(f.initializer.handle()).rejects.toThrow('Pod lifecycle operation already in progress');
    await expect(f.operations.reserveStorage(f.pod.podUrl, 'other-create', 'create')).resolves.toBeUndefined();
    await f.operations.releaseStorage(f.pod.podUrl, 'other-create');
    await expect(f.accessor.getMetadata({ path: f.settings })).rejects.toBeInstanceOf(NotFoundHttpError);
  });

  it('revalidates the Pod incarnation after acquiring its lifecycle reservation', async () => {
    const f = await fixture();
    vi.spyOn(PodLookupRepository.prototype, 'findById').mockResolvedValue(undefined);
    await f.initializer.handle();
    await expect(f.accessor.getMetadata({ path: f.settings })).rejects.toBeInstanceOf(NotFoundHttpError);
    await expect(f.operations.reserveStorage(f.pod.podUrl, 'next-create', 'create')).resolves.toBeUndefined();
    await f.operations.releaseStorage(f.pod.podUrl, 'next-create');
  });

  it('only repairs Pods served by this storage origin', async () => {
    const f = await fixture();
    await new LocalPodContainerMetadataInitializer(f.accessor, f.identityDbUrl, 'https://other.example/').handle();
    await expect(f.accessor.getMetadata({ path: f.settings })).rejects.toBeInstanceOf(NotFoundHttpError);
  });

  it('releases its reservation and fails startup on an unexpected storage error', async () => {
    const f = await fixture();
    vi.spyOn(f.accessor, 'getMetadata').mockRejectedValue(new Error('storage unavailable'));
    await expect(f.initializer.handle()).rejects.toThrow('storage unavailable');
    await expect(f.operations.reserveStorage(f.pod.podUrl, 'next-create', 'create')).resolves.toBeUndefined();
    await f.operations.releaseStorage(f.pod.podUrl, 'next-create');
  });

  it('is configured after RDF recovery and before CSS workers start', () => {
    const config = JSON.parse(fs.readFileSync(path.resolve('config/local.json'), 'utf8'));
    const sequence = config['@graph'].find((entry: any) => entry['@id'] === 'urn:solid-server:default:PrimarySequenceInitializer');
    const ids = sequence.handlers.map((entry: any) => entry['@id']);
    const index = ids.indexOf('urn:undefineds:xpod:LocalPodContainerMetadataInitializer');
    expect(index).toBeGreaterThan(ids.indexOf('urn:undefineds:xpod:LocalRdfAuthorityRecoveryInitializer'));
    expect(index).toBeLessThan(ids.indexOf('urn:solid-server:default:WorkerManager'));
  });
});
