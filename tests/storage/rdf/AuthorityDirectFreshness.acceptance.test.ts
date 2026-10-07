// Root-owned actual pending file/index contract, not a normal-write crash or current Gateway claim.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SingleRootIdentifierStrategy, arrayifyStream } from '@solid/community-server';
import type { Quad } from '@rdfjs/types';
import { DataFactory, Parser } from 'n3';
import { expect, it } from 'vitest';
import { RootedSolidFsSyncJournal } from '../../../src/solidfs/SolidFsSyncJournal';
import { AuthorityFreshnessService, AuthorityPendingFreshnessProvider, hashAuthoritySource } from '../../../src/storage/AuthorityFreshnessService';
import { LocalPhysicalOperationService } from '../../../src/storage/LocalPhysicalOperationService';
import { SolidRdfDataAccessor } from '../../../src/storage/accessors/SolidRdfDataAccessor';
import { SolidRdfEngine } from '../../../src/storage/rdf/SolidRdfEngine';

it.each([ 'scan', 'direct-accessor-data' ] as const)('%s agrees with retained pending authority or refuses explicitly', async mode => {
  const parent = path.resolve('.test-data/authority-direct-freshness');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'root-'));
  const root = path.join(directory, 'authority');
  await mkdir(path.join(root, 'alice'), { recursive: true });
  const base = 'https://root.invalid/';
  const source = `${base}alice/messages.ttl`;
  const file = path.join(root, 'alice', 'messages.ttl');
  const old = `<${source}#msg-id> <urn:root:direct-freshness> "old" .`;
  const current = `<${source}#msg-id> <urn:root:direct-freshness> "current" .`;
  const parse = (body: string): Quad[] => new Parser({ baseIRI: source }).parse(body).map(quad =>
    DataFactory.quad(quad.subject, quad.predicate, quad.object, DataFactory.namedNode(source)));
  const graph = DataFactory.namedNode(source);
  const operations = new LocalPhysicalOperationService(root);
  const engine = new SolidRdfEngine({ operationService: operations, index: { path: path.join(directory, 'facts.sqlite') } });
  const accessor = new SolidRdfDataAccessor(engine, new SingleRootIdentifierStrategy(base), operations);
  const journal = new RootedSolidFsSyncJournal(root, directory, operations);
  const read = async (): Promise<Quad[]> => mode === 'scan'
    ? engine.scan({ pattern: { graph } }).quads
    : arrayifyStream<Quad>(await accessor.getData({ path: source }));
  try {
    await accessor.initialize();
    await operations.run(() => writeFile(file, old));
    engine.replaceSource(parse(old), { source, workspace: base });
    engine.setAuthorityFreshnessProvider(new AuthorityPendingFreshnessProvider(new AuthorityFreshnessService(journal)));
    expect((await read()).map(quad => quad.object.value)).toEqual([ 'old' ]);
    await operations.run(async () => {
      await writeFile(file, current);
      journal.recordAuthorityPending({ path: 'alice/messages.ttl', resource: source, sourcePath: file,
        source: 'filesystem', projection: 'direct', contentType: 'text/turtle', type: 'updated' },
      { workspace: base, cwd: root, projection: 'direct', entries: [] }, hashAuthoritySource(current));
    });
    expect(journal.listAuthorityPending()).toHaveLength(1);
    expect(() => engine.query({ patterns: [ { graph } ] })).toThrowError(expect.objectContaining({ statusCode: 503 }));
    let rows: Quad[] | undefined;
    let error: unknown;
    try { rows = await read(); } catch (caught) { error = caught; }
    if (error !== undefined) {
      expect(error, 'unconfirmed authority must be explicitly unavailable').toMatchObject({ statusCode: 503 });
    } else {
      expect(rows!.map(quad => quad.object.value), 'admission alone cannot qualify old derived facts')
        .toEqual(parse(await readFile(file, 'utf8')).map(quad => quad.object.value));
    }
  } finally {
    await accessor.finalize();
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
