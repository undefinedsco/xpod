import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Pod resource ownership', () => {
  it('leaves CSS in charge of its native Pod resources and profile authorization', async() => {
    const config = JSON.parse(await readFile('config/xpod.base.json', 'utf8')) as {
      '@graph': Array<Record<string, unknown>>;
    };

    const overriddenInstances = config['@graph']
      .map((entry) => entry.overrideInstance as { '@id'?: string } | undefined)
      .map((instance) => instance?.['@id'])
      .filter((id): id is string => Boolean(id));

    expect(overriddenInstances).not.toContain('urn:solid-server:default:PodResourcesGenerator');

    const podCreatorOverride = config['@graph'].find((entry) => {
      const instance = entry.overrideInstance as { '@id'?: string } | undefined;
      return instance?.['@id'] === 'urn:solid-server:default:PodCreator';
    });
    expect(podCreatorOverride?.overrideParameters).toMatchObject({
      '@type': 'ProvisionPodCreator',
      resourceStore: { '@id': 'urn:solid-server:default:ResourceStore' },
    });
  });
});
