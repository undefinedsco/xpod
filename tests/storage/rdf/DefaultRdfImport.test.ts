import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('RDF SPARQL component imports', () => {
  it('keeps public SPARQL executors inside the owned RDF engine boundary', () => {
    const subgraphEngine = readFileSync('src/storage/sparql/SubgraphQueryEngine.ts', 'utf8');
    const qleverEngine = readFileSync('src/storage/rdf/QleverSparqlEngine.ts', 'utf8');
    const cloudEngine = readFileSync('src/storage/rdf/RdfQuerySparqlEngine.ts', 'utf8');
    const comunicaEngine = readFileSync('src/storage/rdf/XpodComunicaQueryEngine.ts', 'utf8');
    const terminalManager = readFileSync('src/terminal/TerminalSessionManager.ts', 'utf8');
    const index = readFileSync('src/index.ts', 'utf8');

    expect(subgraphEngine).not.toContain('Comunica');
    expect(subgraphEngine).not.toContain('QuintstoreSparqlEngine');
    expect(qleverEngine).not.toContain('@comunica/');
    expect(qleverEngine).not.toContain('fallback');
    expect(cloudEngine).toContain('createXpodComunicaQueryEngine');
    expect(cloudEngine).not.toContain('fallback');
    expect(cloudEngine).not.toContain('Shadow');
    expect(comunicaEngine).toContain('@comunica/query-sparql-solid');
    expect(comunicaEngine).not.toContain('fallback');
    expect(terminalManager).not.toContain("import { AclPermissionService }");
    expect(index).not.toContain('CompatibilitySparql');
    expect(index).not.toContain('QuadstoreSparql');
    expect(index).not.toContain('QuintStoreSparql');
    expect(index).not.toContain('Comunica');
  });

  it('uses QLever for local profiles and the public Postgres authority for Cloud', () => {
    const profileExpectations = new Map([
      [ 'config/local.json', 'QleverSparqlEngine' ],
      [ 'config/cloud.json', 'RdfQuerySparqlEngine' ],
      [ 'config/bun.json', 'QleverSparqlEngine' ],
      [ 'config/xpod.json', 'QleverSparqlEngine' ],
    ]);

    for (const [ profilePath, expectedType ] of profileExpectations) {
      const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
      const graph = profile['@graph'] as Record<string, unknown>[];
      const defaultEngine = graph.find((node) => node['@id'] === 'urn:undefineds:xpod:DefaultSparqlEngine');

      expect(defaultEngine, `${profilePath} should define DefaultSparqlEngine`).toBeTruthy();
      expect(defaultEngine?.['@type']).toBe(expectedType);
      expect(defaultEngine?.rdfEngine).toEqual({ '@id': 'urn:undefineds:xpod:SolidRdfEngine' });
      expect(Object.keys(defaultEngine ?? {})).toEqual(expect.arrayContaining([ '@id', '@type', 'rdfEngine' ]));
      expect(defaultEngine).not.toHaveProperty('fallback');
      expect(defaultEngine).not.toHaveProperty('shadowStore');
      expect(defaultEngine).not.toHaveProperty('enablePrimary');
    }
  });
});
