import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComponentsManager } from 'componentsjs';
import { DataFactory } from 'rdf-data-factory';
import { afterAll, describe, expect, it } from 'vitest';
import { createCssChildRuntimeConfig } from '../../src/runtime/css-process';

const repoRoot = path.resolve(__dirname, '../..');
const cloudQleverPath = path.join(repoRoot, 'config/cloud.qlever.json');
const cloudPath = path.join(repoRoot, 'config/cloud.json');
const RDF_ENGINE = 'urn:undefineds:xpod:SolidRdfEngine';
const SPARQL_ENGINE = 'urn:undefineds:xpod:DefaultSparqlEngine';

const runtimeRoots: string[] = [];

afterAll(() => {
  for (const root of runtimeRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function graphEntry(configPath: string, instanceId: string): Record<string, unknown> | undefined {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    '@graph': Array<Record<string, unknown>>;
  };
  return config['@graph'].find((entry) =>
    entry['@id'] === instanceId
    || (entry.overrideInstance as { '@id'?: string } | undefined)?.['@id'] === instanceId);
}

function overrideParameters(configPath: string, instanceId: string): Record<string, unknown> | undefined {
  return graphEntry(configPath, instanceId)?.overrideParameters as Record<string, unknown> | undefined;
}

async function resolvedComponentPath(configPath: string, instanceId: string): Promise<string | undefined> {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-qlever-optin-'));
  runtimeRoots.push(runtimeRoot);
  const runtimeConfig = createCssChildRuntimeConfig({
    configPath,
    runtimeRoot,
    authMode: 'acp',
    externalOidcIssuer: 'https://id-rc.undefineds.co/',
  });
  const manager = await ComponentsManager.build({
    mainModulePath: process.cwd(),
    logLevel: 'error',
    typeChecking: false,
  });
  await manager.configRegistry.register(runtimeConfig.configPath);
  const factory = new DataFactory();
  const engine = manager.configRegistry.getInstantiatedResource(factory.namedNode(instanceId));
  if (!engine) return undefined;
  const pool = manager.configConstructorPool as typeof manager.configConstructorPool & {
    getRawConfig(value: unknown): {
      properties?: Record<string, Array<{ value?: string }>>;
    };
  };
  const raw = pool.getRawConfig(engine);
  return raw?.properties?.[
    'https://linkedsoftwaredependencies.org/vocabularies/object-oriented#componentPath'
  ]?.[0]?.value;
}

describe('RC explicit native QLever opt-in profile', () => {
  it('imports the public Cloud profile so the baseline stays independently runnable', () => {
    const profile = JSON.parse(fs.readFileSync(cloudQleverPath, 'utf8')) as { import?: string[] };
    expect(profile.import).toEqual([ './cloud.json' ]);
  });

  it('preserves every original PostgreSQL engine parameter while adding the native opt-in', () => {
    const inlineBaseline = graphEntry(cloudPath, RDF_ENGINE);
    if (!inlineBaseline) throw new Error('cloud.json must define the PostgreSQL RDF engine');
    expect(inlineBaseline['@type']).toBe('PostgresRdfEngine');
    const native = overrideParameters(cloudQleverPath, RDF_ENGINE);
    expect(native).toBeDefined();
    expect(native).toMatchObject({
      '@type': 'PostgresRdfEngine',
      options_driver: 'pg',
      options_rdfAccelerationProfile: 'pg-hot-operators',
      options_autoOpen: true,
      options_maintenanceIntervalMs: 60000,
      options_maintenanceSourceBatchSize: 256,
      options_textIndex: { '@id': 'urn:undefineds:xpod:PostgresRdfTextIndex' },
      options_vectorIndex: { '@id': 'urn:undefineds:xpod:PostgresRdfVectorIndex' },
      options_nativeSparqlEnabled: true,
    });
    for (const key of [ 'options_driver', 'options_connectionString', 'options_rdfAccelerationProfile',
      'options_autoOpen', 'options_maintenanceIntervalMs', 'options_maintenanceSourceBatchSize' ]) {
      expect(native?.[key]).toEqual(inlineBaseline[key]);
    }
  });

  it('routes the default SPARQL engine to the native QLever adapter with no Comunica fallback', () => {
    const baseline = graphEntry(cloudPath, SPARQL_ENGINE);
    expect(baseline?.['@type']).toBe('RdfQuerySparqlEngine');
    const native = overrideParameters(cloudQleverPath, SPARQL_ENGINE);
    expect(native).toMatchObject({
      '@type': 'QleverSparqlEngine',
      rdfEngine: { '@id': RDF_ENGINE },
    });
  });

  it('binds the native opt-in through the real Components.js graph', async() => {
    const cloudEngine = await resolvedComponentPath(cloudPath, SPARQL_ENGINE);
    const nativeEngine = await resolvedComponentPath(cloudQleverPath, SPARQL_ENGINE);
    expect(cloudEngine).toBe('RdfQuerySparqlEngine');
    expect(nativeEngine).toBe('QleverSparqlEngine');
  }, 120_000);
});
