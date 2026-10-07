// Own direct-read coverage: actual retained file, journal and real SQLite facts/text/vector indexes.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SingleRootIdentifierStrategy, RepresentationMetadata, arrayifyStream } from '@solid/community-server';
import { DataFactory, Parser } from 'n3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalPhysicalOperationService } from '../../src/storage/LocalPhysicalOperationService';
import { AuthorityFreshnessService, AuthorityPendingFreshnessProvider } from '../../src/storage/AuthorityFreshnessService';
import { RootedSolidFsSyncJournal } from '../../src/solidfs/SolidFsSyncJournal';
import { SolidRdfEngine } from '../../src/storage/rdf/SolidRdfEngine';
import { SolidRdfDataAccessor } from '../../src/storage/accessors/SolidRdfDataAccessor';

const modes = ['scan', 'metadata-graph-scan', 'container-scan', 'data', 'metadata', 'children', 'graph-prefix',
  'text-sources', 'text-search', 'text-chunks', 'vector-search', 'stats'] as const;
describe('Local direct reads share current authority freshness', () => {
  let directory: string; let root: string; let file: string; let service: LocalPhysicalOperationService;
  let engine: SolidRdfEngine; let accessor: SolidRdfDataAccessor; let journal: RootedSolidFsSyncJournal;
  const base = 'https://own.invalid/'; const resource = `${base}alice/notes.ttl`;
  const graph = DataFactory.namedNode(resource); const identifier = { path: resource };
  const body = '<#note> <urn:own:name> "old" .\n';
  beforeEach(async () => {
    await mkdir('.test-data/local-read-freshness', { recursive: true });
    directory = await mkdtemp(path.resolve('.test-data/local-read-freshness/own-')); root = path.join(directory, 'data');
    file = path.join(root, 'alice', 'notes.ttl'); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, body);
    service = new LocalPhysicalOperationService(root);
    engine = new SolidRdfEngine({ operationService: service, index: { path: path.join(directory, 'facts.sqlite') },
      textIndex: { path: path.join(directory, 'text.sqlite') }, vectorIndex: { path: path.join(directory, 'vector.sqlite') } });
    accessor = new SolidRdfDataAccessor(engine, new SingleRootIdentifierStrategy(base), service);
    journal = new RootedSolidFsSyncJournal(root, directory, service);
    const metadata = new RepresentationMetadata(identifier);
    metadata.addQuad(graph, DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), DataFactory.namedNode('http://www.w3.org/ns/ldp#Resource'));
    await accessor.writeRdfSourceDocument(identifier, new Parser({ baseIRI: resource }).parse(body), metadata, { source: resource, workspace: base });
    engine.indexTextSource({ source: resource, workspace: base }, 'old');
    engine.indexVectorSource({ source: resource, workspace: base }, [{ chunkKey: 'own', ordinal: 0, level: 0, embedding: [1, 0], content: 'old', startOffset: 0, endOffset: 3 }]);
    engine.setAuthorityFreshnessProvider(new AuthorityPendingFreshnessProvider(new AuthorityFreshnessService(journal)));
  });
  afterEach(async () => { await accessor.finalize(); journal.close(); await rm(directory, { recursive: true, force: true }); });

  async function read(mode: typeof modes[number]): Promise<unknown> {
    switch (mode) {
      case 'scan': return engine.scan({ pattern: { graph } });
      case 'metadata-graph-scan': return engine.scan({ pattern: { graph: DataFactory.namedNode(`meta:${resource}`) } });
      case 'container-scan': return engine.scan({ pattern: { graph: DataFactory.namedNode(`${base}alice/`) } });
      case 'data': return arrayifyStream(await accessor.getData(identifier));
      case 'metadata': return accessor.getMetadata(identifier);
      case 'children': { const values = []; for await (const value of accessor.getChildren({ path: `${base}alice/` })) { values.push(value); } return values; }
      case 'graph-prefix': return accessor.getDataByGraphPrefix(`${base}alice/`);
      case 'text-sources': return engine.listTextSources();
      case 'text-search': return engine.searchText('old');
      case 'text-chunks': return engine.listTextSourceChunks(resource);
      case 'vector-search': return engine.searchVector({ embedding: [1, 0] });
      case 'stats': return engine.storageStats();
    }
  }

  it.each(modes)('%s is healthy idle and refuses pending retained authority before serving old derived facts', async mode => {
    await expect(read(mode)).resolves.toBeDefined();
    await service.run(async () => {
      await writeFile(file, '<#note> <urn:own:name> "current" .\n');
      journal.recordAuthorityPending({ path: 'alice/notes.ttl', resource, sourcePath: file, contentType: 'text/turtle',
        source: 'filesystem', projection: 'direct', type: 'updated' }, { workspace: base, cwd: root, projection: 'direct', entries: [] }, 'current');
    });
    await expect(read(mode)).rejects.toMatchObject({ statusCode: 503 });
    expect(journal.listAuthorityPending()).toHaveLength(1);
  });
});
