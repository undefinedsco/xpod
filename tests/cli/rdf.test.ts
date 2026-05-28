import { describe, expect, it } from 'vitest';
import {
  buildSparqlPatch,
  documentResourceInput,
  resolveSparqlEndpoint,
} from '../../src/cli/commands/rdf';

describe('rdf command helpers', () => {
  it('strips fragments before fetching or patching the RDF document', () => {
    expect(documentResourceInput('settings/credentials.ttl#cred-openai')).toBe('settings/credentials.ttl');
    expect(documentResourceInput('https://pod.example/alice/settings/credentials.ttl#cred-openai'))
      .toBe('https://pod.example/alice/settings/credentials.ttl');
  });

  it('wraps triple snippets in SPARQL Update operations', () => {
    const sparql = buildSparqlPatch({
      delete: '<s> <p> "old" .',
      insert: '<s> <p> "new" .',
    });

    expect(sparql).toContain('DELETE DATA');
    expect(sparql).toContain('<s> <p> "old" .');
    expect(sparql).toContain('INSERT DATA');
    expect(sparql).toContain('<s> <p> "new" .');
  });

  it('passes through full SPARQL Update text', () => {
    const update = 'PREFIX ex: <https://example.com/> INSERT DATA { ex:s ex:p "v" }';

    expect(buildSparqlPatch({ insert: update })).toBe(update);
  });

  it('resolves Pod-root and scoped SPARQL sidecar endpoints', () => {
    expect(resolveSparqlEndpoint('https://pod.example/alice/'))
      .toBe('https://pod.example/alice/-/sparql');
    expect(resolveSparqlEndpoint('https://pod.example/alice/', 'photos/'))
      .toBe('https://pod.example/alice/photos/-/sparql');
  });
});
