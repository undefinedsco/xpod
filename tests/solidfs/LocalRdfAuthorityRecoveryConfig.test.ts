import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Local RDF authority recovery Components configuration', () => {
  it('keeps recovery and its journal on Local only', async () => {
    const [ local, cloud, base ] = await Promise.all([
      readConfig('config/local.json'),
      readConfig('config/cloud.json'),
      readConfig('config/xpod.base.json'),
    ]);

    expect(byId(local, 'urn:undefineds:xpod:LocalRdfAuthorityJournal')).toMatchObject({
      '@type': 'RootedSolidFsSyncJournal',
      rootFilePath: { '@id': 'urn:solid-server:default:variable:rootFilePath' },
    });
    expect(byId(local, 'urn:undefineds:xpod:LocalRdfAuthorityRecoveryInitializer')).toMatchObject({
      '@type': 'LocalRdfAuthorityRecoveryInitializer',
      journal: { '@id': 'urn:undefineds:xpod:LocalRdfAuthorityJournal' },
      index: { '@id': 'urn:undefineds:xpod:MixDataAccessor' },
    });
    expect(findById(cloud, 'urn:undefineds:xpod:LocalRdfAuthorityRecoveryInitializer')).toBeUndefined();
    expect(findById(base, 'urn:undefineds:xpod:LocalRdfAuthorityRecoveryInitializer')).toBeUndefined();
  });

  it('replays Local authority state before workers without dropping the edge initializer', async () => {
    const local = await readConfig('config/local.json');
    const sequence = byId(local, 'urn:solid-server:default:PrimarySequenceInitializer');
    const ids = sequence.handlers.map((handler: { '@id': string }) => handler['@id']);

    expect(ids.indexOf('urn:undefineds:xpod:LocalRdfAuthorityRecoveryInitializer'))
      .toBeGreaterThan(ids.indexOf('urn:solid-server:default:PrimaryParallelInitializer'));
    expect(ids.indexOf('urn:undefineds:xpod:LocalRdfAuthorityRecoveryInitializer'))
      .toBeLessThan(ids.indexOf('urn:solid-server:default:WorkerManager'));
    expect(ids).toContain('urn:undefineds:xpod:EdgeNodeAgentInitializer');
  });

  it('wires committed Local writes to the same journal', async () => {
    const local = await readConfig('config/local.json');
    const accessor = byId(local, 'urn:undefineds:xpod:MixDataAccessor');

    expect(accessor).toMatchObject({
      rdfFileDataAccessor: { '@id': 'urn:solid-server:default:FileDataAccessor' },
      rdfFileMapper: { '@id': 'urn:solid-server:default:FileIdentifierMapper' },
      localRdfAuthorityJournal: { '@id': 'urn:undefineds:xpod:LocalRdfAuthorityJournal' },
      textSearchIndexingEnabled: true,
      rdfSearchIntentSink: { '@id': 'urn:undefineds:xpod:RdfSearchIntentSink' },
    });
  });

  it('finalizes the structured RDF authority in every runtime profile', async () => {
    const base = await readConfig('config/xpod.base.json');
    const finalizer = byId(base, 'urn:solid-server:default:CleanupFinalizer');
    const finalizableIds = finalizer.handlers.map(
      (handler: { finalizable?: { '@id'?: string } }) => handler.finalizable?.['@id'],
    );
    expect(finalizableIds).toContain('urn:undefineds:xpod:SolidRdfDataAccessor');

    for (const configPath of [
      'config/local.json',
      'config/bun.json',
      'config/xpod.json',
      'config/cloud.json',
    ]) {
      const config = await readConfig(configPath);
      expect(config.import, configPath).toContain('./xpod.base.json');
    }
  });

  it('wires Cloud text commits to the same durable embedding intent without the retired listener', async () => {
    const cloud = await readConfig('config/cloud.json');
    const accessor = byId(cloud, 'urn:undefineds:xpod:MixDataAccessor');

    expect(accessor).toMatchObject({
      textSearchIndexingEnabled: true,
      rdfSearchIntentSink: { '@id': 'urn:undefineds:xpod:RdfSearchIntentSink' },
    });
    for (const retiredId of [
      'urn:undefineds:xpod:DerivedIndexChangeJournal',
      'urn:undefineds:xpod:RdfDerivedIndexingListener',
      'urn:undefineds:xpod:DerivedIndexEmbeddingService',
      'urn:undefineds:xpod:DerivedIndexProviderRegistry',
    ]) {
      expect(findById(cloud, retiredId)).toBeUndefined();
    }
    expect(JSON.stringify(cloud)).not.toContain('text-embedding-004');

    const sequence = byId(cloud, 'urn:solid-server:default:PrimarySequenceInitializer');
    const handlers = sequence[
      'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/SequenceHandler.jsonld#SequenceHandler_handlers'
    ];
    const ids = handlers.map((handler: { '@id': string }) => handler['@id']);
    expect(ids).not.toContain('urn:undefineds:xpod:DerivedIndexChangeJournal');

    const backendOverride = cloud['@graph'].find((entry) =>
      entry.overrideInstance?.['@id'] === 'urn:solid-server:default:ResourceStore_Backend');
    expect(backendOverride?.overrideParameters).toMatchObject({
      '@type': 'ObservableResourceStore',
    });
    expect(backendOverride?.overrideParameters).not.toHaveProperty('options_recorders');
  });

  async function readConfig(configPath: string): Promise<{ '@graph': any[] }> {
    return JSON.parse(await readFile(path.join(process.cwd(), configPath), 'utf8'));
  }

  function findById(config: { '@graph': any[] }, id: string): any {
    return config['@graph'].find((entry) => entry['@id'] === id);
  }

  function byId(config: { '@graph': any[] }, id: string): any {
    const value = findById(config, id);
    expect(value, `Missing ${id}`).toBeDefined();
    return value;
  }
});
