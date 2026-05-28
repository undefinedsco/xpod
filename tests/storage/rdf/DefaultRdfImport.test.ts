import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('embedded RDF component imports', () => {
  it('keeps the SolidRdfEngine path free of static compatibility-engine imports', () => {
    const subgraphEngine = readFileSync('src/storage/sparql/SubgraphQueryEngine.ts', 'utf8');
    const compatibilityEngine = readFileSync('src/storage/sparql/CompatibilitySparqlEngine.ts', 'utf8');
    const quadstoreAccessor = readFileSync('src/storage/accessors/QuadstoreSparqlDataAccessor.ts', 'utf8');
    const quintStoreAccessor = readFileSync('src/storage/accessors/QuintStoreSparqlDataAccessor.ts', 'utf8');
    const solidEngine = readFileSync('src/storage/rdf/SolidRdfSparqlEngine.ts', 'utf8');
    const terminalManager = readFileSync('src/terminal/TerminalSessionManager.ts', 'utf8');
    const index = readFileSync('src/index.ts', 'utf8');

    expect(subgraphEngine).not.toContain('Comunica');
    expect(subgraphEngine).not.toContain('QuintstoreSparqlEngine');
    expect(compatibilityEngine).not.toContain('@comunica/');
    expect(compatibilityEngine).not.toContain("from './ComunicaQuintEngine'");
    expect(compatibilityEngine).not.toContain("from './QuintEngine'");
    expect(quadstoreAccessor).not.toContain("import { QuintEngine }");
    expect(quintStoreAccessor).not.toContain("import { ComunicaQuintEngine }");
    expect(solidEngine).not.toContain('@comunica/');
    expect(terminalManager).not.toContain("import { AclPermissionService }");
    expect(index).not.toContain('CompatibilitySparqlEngineImpl');
    expect(index).not.toContain('ComunicaQuintEngine');
    expect(index).not.toContain('QuintEngine');
  });
});
