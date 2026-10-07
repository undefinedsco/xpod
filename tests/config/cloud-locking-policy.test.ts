import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface GraphEntry extends Record<string, unknown> {
  overrideInstance?: { '@id'?: string };
  overrideParameters?: Record<string, unknown>;
}

async function graphOf(configPath: string): Promise<GraphEntry[]> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { '@graph': GraphEntry[] };
  return config['@graph'];
}

describe('CSS locking policy', () => {
  it.each([
    [ 'cloud', 'config/cloud.json', 'UrlAwareRedisLocker' ],
    [ 'local', 'config/local.json', 'GreedyReadWriteLocker' ],
    [ 'xpod', 'config/xpod.json', 'GreedyReadWriteLocker' ],
  ])('wraps the %s ResourceLocker in a hierarchical locker with no timeout release', async(_name, configPath, lockerType) => {
    const override = (await graphOf(configPath)).find(
      entry => entry.overrideInstance?.['@id'] === 'urn:solid-server:default:ResourceLocker',
    );
    const parameters = override?.overrideParameters;

    expect(parameters?.['@type']).toBe('HierarchicalReadWriteLocker');
    expect(parameters?.locker).toMatchObject({ '@type': lockerType });
    expect(parameters?.locker).not.toHaveProperty('attemptSettings_retryCount');
    // The old WrappedExpiringReadWriteLocker released a lock by Promise.race timeout even while the
    // locked callback still ran. The hierarchy must not carry that expiration field.
    expect(parameters).not.toHaveProperty('expiration');
    expect(parameters?.identifierStrategy).toMatchObject({
      '@id': 'urn:solid-server:default:IdentifierStrategy',
    });
  });

  it('injects that same ResourceLocker instance into the scoped SPARQL handler', async() => {
    // The ordinary LDP path and the scoped SPARQL write path have to share one lock space, or an
    // ancestor read lock on one side would not exclude a scope write on the other.
    const handler = (await graphOf('config/xpod.base.json')).find(
      entry => entry['@id'] === 'urn:undefineds:xpod:SubgraphSparqlHttpHandler',
    );
    expect(handler?.locks).toEqual({ '@id': 'urn:solid-server:default:ResourceLocker' });
  });
});
