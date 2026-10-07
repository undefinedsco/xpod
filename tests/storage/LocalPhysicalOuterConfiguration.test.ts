// Own assembly qualification. CSS infrastructure adapters are declared fixtures; protected classes are real.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { ComponentsManager, ConstructionStrategyCommonJs, type ICreationStrategyInstanceOptions } from 'componentsjs';
import { RouterHandler, AuthorizingHttpHandler, WacAllowHttpHandler } from '@solid/community-server';
import { describe, expect, it } from 'vitest';
import { LocalPhysicalOperationService } from '../../src/storage/LocalPhysicalOperationService';
import { LocalPhysicalParsingHttpHandler } from '../../src/http/LocalPhysicalParsingHttpHandler';
import { LockingResourceStore } from '../../src/storage/LockingResourceStore';
import { MixDataAccessor } from '../../src/storage/accessors/MixDataAccessor';
import { SolidRdfDataAccessor } from '../../src/storage/accessors/SolidRdfDataAccessor';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import { SolidRdfEngine } from '../../src/storage/rdf/SolidRdfEngine';
import { LocalQleverNativeSparqlClient } from '../../src/storage/rdf/LocalQleverNativeSparqlClient';
import { RdfTextIndex } from '../../src/storage/rdf/RdfTextIndex';
import { RdfVectorIndex } from '../../src/storage/rdf/RdfVectorIndex';
import { SqliteVectorStore } from '../../src/storage/vector/SqliteVectorStore';
import { VectorHttpHandler } from '../../src/http/vector/VectorHttpHandler';
import { RootedSolidFsSyncJournal } from '../../src/solidfs/SolidFsSyncJournal';

describe('Local configured outer assembly', () => {
  it.each(['webacl', 'acp'])('uses the same actual protected LdpHandler for %s auxiliary routes and all outer consumers', async profile => {
    await mkdir('.test-data/local-outer-configuration', { recursive: true });
    const directory = await mkdtemp(path.resolve('.test-data/local-outer-configuration/own-'));
    const classes: Record<string, Function> = { LocalPhysicalOperationService, LocalPhysicalParsingHttpHandler,
      LockingResourceStore, MixDataAccessor, SolidRdfDataAccessor, SubgraphSparqlHttpHandler, SolidRdfEngine,
      LocalQleverNativeSparqlClient, RdfTextIndex, RdfVectorIndex, RootedSolidFsSyncJournal,
      RouterHandler, AuthorizingHttpHandler, WacAllowHttpHandler, SqliteVectorStore, VectorHttpHandler };
    const instances: Array<{ name: string; args: unknown[]; value: unknown }> = [];
    class OwnConstruction extends ConstructionStrategyCommonJs {
      public override getVariableValue(options: Parameters<ConstructionStrategyCommonJs['getVariableValue']>[0]): unknown {
        // Declared infrastructure-fixture inputs only; protected physical root/facts/baseUrl are explicit.
        return options.settings.variables?.[options.variableName];
      }
      public override createInstance(options: ICreationStrategyInstanceOptions<unknown>): unknown {
        const name = options.requireElement ?? '';
        const constructor = classes[name];
        const value = constructor ? Reflect.construct(constructor, options.args) : {
          handleSafe: async () => undefined, canHandle: async () => undefined,
          setAuthorityFreshnessProvider: () => undefined,
        };
        instances.push({ name, args: options.args, value });
        return value;
      }
    }
    const manager = await ComponentsManager.build({ mainModulePath: process.cwd(), typeChecking: false,
      dumpErrorState: false, constructionStrategy: new OwnConstruction() });
    let service: LocalPhysicalOperationService | undefined;
    let engine: SolidRdfEngine | undefined;
    try {
      await manager.configRegistry.register(path.resolve('config/local.json'));
      await manager.configRegistry.register(path.resolve(`node_modules/@solid/community-server/config/ldp/authorization/${profile}.json`));
      await manager.configRegistry.register(path.resolve(`node_modules/@solid/community-server/config/util/auxiliary/${profile === 'acp' ? 'acr' : 'acl'}.json`));
      const variables = { 'urn:solid-server:default:variable:rootFilePath': path.join(directory, 'data'),
        'urn:solid-server:default:variable:rdfIndexPath': path.join(directory, 'facts.sqlite'),
        'urn:solid-server:default:variable:baseUrl': 'https://own.invalid/' };
      service = await manager.instantiate<LocalPhysicalOperationService>('urn:undefineds:xpod:LocalPhysicalOperationService', { variables });
      const ldp = await manager.instantiate('urn:solid-server:default:LdpHandler', { variables });
      expect(ldp).toBeInstanceOf(LocalPhysicalParsingHttpHandler);
      const credentials = await manager.instantiate('urn:solid-server:default:CredentialsExtractor', { variables });
      const parsing = instances.find(item => item.value === ldp)!;
      expect(parsing.args[2], 'preparation shares the original request-keyed CSS credentials cache').toBe(credentials);
      expect((instances.find(item => item.name === 'AuthorizingHttpHandler')!.args[0] as { credentialsExtractor: unknown }).credentialsExtractor).toBe(credentials);
      const auxiliary = await manager.instantiate('urn:solid-server:default:AuthResourceHttpHandler', { variables });
      const route = instances.find(item => item.value === auxiliary)!;
      expect((route.args[0] as { handler: unknown }).handler).toBe(ldp);
      expect((route.args[0] as { allowedPathNames: string[] }).allowedPathNames.join('')).toContain(profile === 'acp' ? 'acr' : 'acl');
      for (const id of ['urn:solid-server:default:ResourceStore_Locking', 'urn:undefineds:xpod:MixDataAccessor',
        'urn:undefineds:xpod:SolidRdfDataAccessor', 'urn:undefineds:xpod:SubgraphSparqlHttpHandler',
        'urn:undefineds:xpod:VectorStore', 'urn:undefineds:xpod:VectorHttpHandler']) {
        await manager.instantiate(id, { variables });
      }
      engine = await manager.instantiate<SolidRdfEngine>('urn:undefineds:xpod:SolidRdfEngine', { variables });
      for (const name of ['LocalPhysicalParsingHttpHandler', 'MixDataAccessor', 'SolidRdfDataAccessor', 'SubgraphSparqlHttpHandler']) {
        const creation = instances.find(item => item.name === name)!;
        expect(creation.args, name).toContain(service);
      }
      const locking = instances.find(item => item.name === 'LockingResourceStore')!;
      expect((locking.args[3] as { operationService: unknown }).operationService).toBe(service);
      for (const name of ['SqliteVectorStore', 'VectorHttpHandler']) {
        const options = instances.find(item => item.name === name)!.args[0] as { operationService: unknown; connectionString?: string };
        expect(options.operationService, name).toBe(service);
        if (name === 'SqliteVectorStore') { expect(options.connectionString).toBe(variables['urn:solid-server:default:variable:rdfIndexPath']); }
      }
      expect(service.canonicalRoot).toBe(path.join(directory, 'data'));
      const physical = instances.filter(item => item.name === 'LocalPhysicalOperationService');
      expect(physical).toHaveLength(1);
    } finally { if (engine) { await engine.close(); } else { await service?.close(); } await rm(directory, { recursive: true, force: true }); }
  }, 30000);
});
