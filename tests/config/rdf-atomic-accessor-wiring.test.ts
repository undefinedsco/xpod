import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface GraphEntry extends Record<string, unknown> {
  overrideInstance?: { '@id'?: string };
}
async function graphOf(configPath: string): Promise<GraphEntry[]> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { '@graph': GraphEntry[] };
  return config['@graph'];
}
const ATOMIC_ID = 'urn:undefineds:xpod:AtomicRdfFileDataAccessor';

/**
 * B-owned nonacceptance wiring lock for the RDF authority atomic accessor reuse. It asserts the ONE
 * shared installed CSS AtomicFileDataAccessor declaration and that every profile binds MixDataAccessor's
 * RDF authority mirror to it, while ordinary/internal FileDataAccessor and Minio stay untouched.
 */
describe('RDF authority atomic accessor config wiring', () => {
  it('declares exactly one shared installed CSS AtomicFileDataAccessor in xpod.base.json', async() => {
    const entries = (await graphOf('config/xpod.base.json')).filter(entry => entry['@id'] === ATOMIC_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      '@type': 'AtomicFileDataAccessor',
      resourceMapper: { '@id': 'urn:solid-server:default:FileIdentifierMapper' },
      rootFilePath: { '@id': 'urn:solid-server:default:variable:rootFilePath' },
      tempFilePath: '/.internal/tempFiles/',
    });
  });

  it.each(['local', 'cloud', 'xpod', 'bun'])('binds MixDataAccessor.rdfFileDataAccessor to the shared atomic accessor in %s.json', async name => {
    const mix = (await graphOf(`config/${name}.json`)).find(entry => entry['@id'] === 'urn:undefineds:xpod:MixDataAccessor');
    expect(mix?.rdfFileDataAccessor).toEqual({ '@id': ATOMIC_ID });
    // Ordinary/internal (unstructured) accessor is NOT retargeted to the atomic instance.
    const unstructured = mix?.unstructuredDataAccessor as { '@id'?: string } | undefined;
    expect([ 'urn:solid-server:default:FileDataAccessor', 'urn:undefineds:xpod:RemoteDataAccessor' ]).toContain(unstructured?.['@id']);
  });

  it('never globally overrides urn:solid-server:default:FileDataAccessor', async() => {
    for (const name of [ 'xpod.base', 'local', 'cloud', 'xpod', 'bun' ]) {
      const override = (await graphOf(`config/${name}.json`)).find(entry =>
        entry.overrideInstance?.['@id'] === 'urn:solid-server:default:FileDataAccessor');
      expect(override, `${name}.json must not override the default FileDataAccessor`).toBeUndefined();
    }
  });
});
