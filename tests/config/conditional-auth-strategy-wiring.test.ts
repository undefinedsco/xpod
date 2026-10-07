/**
 * Runtime-free, actual-class DI proof for the conditional authorization-resource primitive.
 *
 * Both supported composers are exercised:
 * - `createCssChildRuntimeConfig` (CSS child process: `main.ts`, `xpod start`), and
 * - `createCssRuntimeConfig` (public SDK `startXpodRuntime` -> `XpodRuntime` -> lifecycle).
 *
 * The real config is resolved by the real Components.js manager. A construction strategy mirrors
 * Components.js' CommonJS strategy but maps the two components under test to their actual classes
 * including the real handler, authorization/auxiliary strategies, identifier strategy and locking
 * store. Unrelated services are runtime-free stubs. A real in-memory hierarchy locker is shared by
 * the store and handler; identity/usage DB options are empty. Local's physical operation service
 * uses its real, privately owned SQLite coordination database. No HTTP server is started.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ComponentsManager, ConstructionStrategyCommonJs } from 'componentsjs';
import type { ICreationStrategyInstanceOptions } from 'componentsjs';
import {
  SuffixAuxiliaryIdentifierStrategy,
  SingleRootIdentifierStrategy,
  ComposedAuxiliaryStrategy,
  RoutingAuxiliaryStrategy,
  RdfValidator,
  GreedyReadWriteLocker,
  MemoryResourceLocker,
  MemoryMapStorage,
  type AuxiliaryIdentifierStrategy,
  type ResourceIdentifier,
} from '@solid/community-server';
import { afterEach, describe, expect, it } from 'vitest';
import { createCssChildRuntimeConfig } from '../../src/runtime/css-process';
import { createCssRuntimeConfig } from '../../src/runtime/bootstrap';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import { AgentReadObservation } from '../../src/authorization/AgentReadObservation';
import { LockingResourceStore } from '../../src/storage/LockingResourceStore';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';
import { LocalPhysicalOperationService } from '../../src/storage/LocalPhysicalOperationService';
import { ClusterIdentifierStrategy } from '../../src/util/identifiers/ClusterIdentifierStrategy';
import type { AuthMode } from '../../src/authorization/AuthMode';

const HANDLER = 'urn:undefineds:xpod:SubgraphSparqlHttpHandler';
const IDENTITY_DB_VARIABLE = 'urn:solid-server:default:variable:identityDbUrl';
const USAGE_DB_VARIABLE = 'urn:solid-server:default:variable:usageDbUrl';

// No representation reads occur in this constructor-only proof.
const UNRELATED_SERVICE_IDS = [
  'urn:undefineds:xpod:SubgraphQueryEngine',
  'urn:undefineds:xpod:MixDataAccessor',
  'urn:solid-server:default:CredentialsExtractor',
  'urn:solid-server:default:PermissionReader',
  'urn:solid-server:default:Authorizer',
  'urn:solid-server:default:ResourceStore',
  'urn:solid-server:default:ResourceStore_Patching',
  'urn:solid-server:default:RepresentationConverter',
];

const ACTUAL_CLASSES: Record<string, typeof SubgraphSparqlHttpHandler | typeof SuffixAuxiliaryIdentifierStrategy
  | typeof SingleRootIdentifierStrategy | typeof ComposedAuxiliaryStrategy | typeof RoutingAuxiliaryStrategy
  | typeof RdfValidator | typeof LockingResourceStore | typeof ClusterIdentifierStrategy
  | typeof AgentReadObservation | typeof LocalPhysicalOperationService> = {
  SubgraphSparqlHttpHandler, SuffixAuxiliaryIdentifierStrategy, SingleRootIdentifierStrategy,
  ComposedAuxiliaryStrategy, RoutingAuxiliaryStrategy, RdfValidator, LockingResourceStore, ClusterIdentifierStrategy,
  AgentReadObservation, LocalPhysicalOperationService,
};

const operationServices: LocalPhysicalOperationService[] = [];

/** Map the components under test to their actual classes; reject anything else. */
class ActualClassConstruct extends ConstructionStrategyCommonJs {
  public constructor() {
    super({ req: (() => { throw new Error('unexpected require'); }) as unknown as NodeJS.Require });
  }

  public override createInstance(options: ICreationStrategyInstanceOptions<unknown>): unknown {
    const constructor = options.requireElement ? ACTUAL_CLASSES[options.requireElement] : undefined;
    if (constructor) {
      const instance = options.callConstructor ? Reflect.construct(constructor, options.args) : constructor;
      if (instance instanceof LocalPhysicalOperationService) { operationServices.push(instance); }
      return instance;
    }
    throw new Error(`Unexpected component construction: ${options.requireName}#${options.requireElement}`);
  }
}

const runtimeRoots: string[] = [];

afterEach(async () => {
  for (const service of operationServices.splice(0)) {
    await service.close();
    for (const suffix of [ '', '-wal', '-shm' ]) {
      fs.rmSync(`${service.databasePath}${suffix}`, { force: true });
    }
  }
  for (const root of runtimeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function newRuntimeRoot(label: string): string {
  const baseDir = path.resolve('.test-data', 'conditional-auth-strategy-wiring');
  fs.mkdirSync(baseDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(baseDir, label));
  runtimeRoots.push(root);
  return root;
}

/** Compose the runtime config with one of the two supported composers. */
function composeConfig(composer: 'child' | 'sdk', authMode: AuthMode, base: 'local' | 'cloud'): string {
  if (composer === 'child') {
    return createCssChildRuntimeConfig({
      configPath: path.resolve(`config/${base}.json`),
      runtimeRoot: newRuntimeRoot(`child-${base}-${authMode}-`),
      authMode,
    }).configPath;
  }
  return createCssRuntimeConfig({
    id: `wiring-${base}-${authMode}`,
    mode: base,
    runtimeRoot: newRuntimeRoot(`sdk-${base}-${authMode}-`),
    cssAuthMode: authMode,
  } as Parameters<typeof createCssRuntimeConfig>[0]);
}

async function loadManager(configPath: string) {
  const manager = await ComponentsManager.build({
    mainModulePath: process.cwd(),
    typeChecking: false,
    dumpErrorState: false,
    constructionStrategy: new ActualClassConstruct(),
  });
  await manager.configRegistry.register(configPath);
  const registry = manager.configConstructorPool.getInstanceRegistry();
  for (const id of UNRELATED_SERVICE_IDS) {
    registry[id] = Promise.resolve({});
  }
  const locks = new HierarchicalReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), new SingleRootIdentifierStrategy('https://pod.example/'));
  registry['urn:solid-server:default:ResourceLocker'] = Promise.resolve(locks);
  return manager;
}

describe('conditional auth auxiliary DI wiring (actual classes, both composers)', () => {
  for (const composer of [ 'child', 'sdk' ] as const) {
    for (const base of [ 'local', 'cloud' ] as const) {
      for (const authMode of [ 'acp', 'acl', 'allow-all' ] as const) {
        it(`instantiates the real handler with the ${authMode} strategy (${composer}, ${base})`, async() => {
          const manager = await loadManager(composeConfig(composer, authMode, base));
          const instance = await manager.instantiate<SubgraphSparqlHttpHandler>(HANDLER, {
            variables: {
              [IDENTITY_DB_VARIABLE]: '',
              [USAGE_DB_VARIABLE]: '',
              'urn:solid-server:default:variable:baseUrl': 'https://pod.example/',
              'urn:solid-server:default:variable:allowedHosts': '',
              'urn:solid-server:default:variable:rootFilePath': newRuntimeRoot(`authority-${base}-${authMode}-`),
            },
          });

          expect(instance).toBeInstanceOf(SubgraphSparqlHttpHandler);
          const strategy = (instance as unknown as { authStrategy?: AuxiliaryIdentifierStrategy }).authStrategy;
          const guard = instance as unknown as { guardedPolicyProfile?: string; authorityStore: LockingResourceStore;
            locks: HierarchicalReadWriteLocker; identifierStrategy: unknown; auxiliaryStrategy: AuxiliaryIdentifierStrategy;
            operationService?: LocalPhysicalOperationService };
          // ACP now has a server closure profile; all twelve actual-class strategy,
          // authority-store and locker checks remain. Client ACP proof is a separate gate.
          expect(guard.guardedPolicyProfile).toBe(authMode === 'acl' ? 'wac-ground-v1' : authMode === 'acp' ? 'acp-ground-v1' : undefined);
          expect(guard.authorityStore).toBeInstanceOf(LockingResourceStore);
          expect(guard.authorityStore.usesAuthorityLocker(guard.locks)).toBe(true);
          expect(guard.locks).toBeInstanceOf(HierarchicalReadWriteLocker);
          expect(guard.identifierStrategy).toBeInstanceOf(base === 'cloud' ? ClusterIdentifierStrategy : SingleRootIdentifierStrategy);
          expect(guard.auxiliaryStrategy).toBeInstanceOf(RoutingAuxiliaryStrategy);

          if (base === 'local') {
            expect(guard.operationService).toBeInstanceOf(LocalPhysicalOperationService);
            expect((guard.authorityStore as unknown as { operationService?: LocalPhysicalOperationService })
              .operationService).toBe(guard.operationService);
          }

          if (authMode === 'allow-all') {
            // allow-all composes the empty auxiliary strategy: the optional parameter is omitted,
            // never a dangling non-null reference.
            expect(strategy).toBeUndefined();
            return;
          }

          expect(strategy).toBeInstanceOf(SuffixAuxiliaryIdentifierStrategy);
          const suffix = authMode === 'acp' ? '.acr' : '.acl';
          const other = authMode === 'acp' ? '.acl' : '.acr';
          const identifier = (extension: string): ResourceIdentifier =>
            ({ path: `https://pod.example/alice/room.ttl${extension}` });
          expect(strategy!.isAuxiliaryIdentifier(identifier(suffix))).toBe(true);
          // The other authorization mode's suffix is not recognised by this mode's strategy.
          expect(strategy!.isAuxiliaryIdentifier(identifier(other))).toBe(false);
        }, 60_000);
      }
    }
  }
});
