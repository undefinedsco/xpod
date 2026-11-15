import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const cloud = JSON.parse(readFileSync(path.join(root, 'config/cloud.json'), 'utf8'));
const native = JSON.parse(readFileSync(path.join(root, 'config/cloud.qlever.json'), 'utf8'));

describe('native RC cloud profile', () => {
  it('keeps current PG storage, FTS/VEC, acceleration, maintenance and DSN parameters', () => {
    expect(native.import).toEqual(['./cloud.json']);
    expect(native['@graph']).toHaveLength(2);
    const { comment: _comment, '@id': _id, ...parameters } = cloud['@graph'].find(
      (entry: Record<string, unknown>) => entry['@id'] === 'urn:undefineds:xpod:SolidRdfEngine',
    );
    expect(native['@graph'][0]).toEqual({
      '@type': 'Override',
      overrideInstance: { '@id': 'urn:undefineds:xpod:SolidRdfEngine' },
      overrideParameters: { ...parameters, options_nativeSparqlEnabled: true },
    });
  });

  it('routes the existing default SPARQL authority through QLever without a secondary engine', () => {
    expect(native['@graph'][1]).toEqual({
      '@type': 'Override',
      overrideInstance: { '@id': 'urn:undefineds:xpod:DefaultSparqlEngine' },
      overrideParameters: {
        '@type': 'QleverSparqlEngine',
        rdfEngine: { '@id': 'urn:undefineds:xpod:SolidRdfEngine' },
      },
    });
    expect(JSON.stringify(native)).not.toMatch(/Comunica|RdfQuerySparqlEngine/);
  });
});
