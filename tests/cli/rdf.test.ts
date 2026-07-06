import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import {
  buildSparqlPatch,
  documentResourceInput,
  resolveSparqlEndpoint,
} from '../../src/cli/commands/rdf';

function runXpodCli(args: string[]) {
  return spawnSync('bun', [ 'src/cli/index.ts', ...args ], {
    cwd: process.cwd(),
    encoding: 'utf-8',
  });
}

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

  it('documents rdf query as a --sparql option rather than a positional query', () => {
    const help = runXpodCli([ 'rdf', 'query', '--help' ]);
    const output = `${help.stdout}\n${help.stderr}`;

    expect(help.status).toBe(0);
    expect(output).toContain('--sparql');
    expect(output).toMatch(/not as a p\s*ositional argument/u);
  });

  it('keeps xpod-cli agent skill aligned with rdf query syntax', () => {
    const skill = readFileSync('plugins/xpod-cli/skills/xpod-cli/SKILL.md', 'utf-8');

    expect(skill).toContain('xpod rdf query --sparql');
    expect(skill).toContain('not');
    expect(skill).toContain('positional');
  });
});
