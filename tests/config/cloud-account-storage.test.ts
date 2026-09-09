import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Cloud account storage config', () => {
  it('persists CSS account identity records through DrizzleIndexedStorage', () => {
    const cloudConfig = JSON.parse(fs.readFileSync(path.resolve('config/cloud.json'), 'utf8')) as {
      '@graph'?: Array<{
        overrideInstance?: { '@id'?: string };
        overrideParameters?: {
          '@type'?: string;
          connectionString?: { '@id'?: string };
        };
      }>;
    };

    const accountStorageOverride = (cloudConfig['@graph'] ?? []).find((entry) =>
      entry.overrideInstance?.['@id'] === 'urn:solid-server:default:AccountStorage');

    expect(accountStorageOverride?.overrideParameters).toMatchObject({
      '@type': 'DrizzleIndexedStorage',
      connectionString: {
        '@id': 'urn:solid-server:default:variable:identityDbUrl',
      },
    });
  });
});
