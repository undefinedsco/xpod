import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Cloud account storage config', () => {
  it('persists CSS account identity records through DrizzleIndexedStorage with the login guard intact', () => {
    const cloudConfig = JSON.parse(fs.readFileSync(path.resolve('config/cloud.json'), 'utf8')) as {
      '@graph'?: Array<{
        overrideInstance?: { '@id'?: string };
        overrideParameters?: {
          '@type'?: string;
          storage?: {
            '@type'?: string;
            connectionString?: { '@id'?: string };
          };
        };
      }>;
    };

    const accountStorageOverride = (cloudConfig['@graph'] ?? []).find((entry) =>
      entry.overrideInstance?.['@id'] === 'urn:solid-server:default:AccountStorage');

    // CSS 默认 AccountStorage 是 BaseLoginAccountStorage，但其"账户必须有登录方法"
    // 约束与 SP 托管账户（无密码、通过 provision receipt 持有 Pod）冲突。
    // 等位替换为 LoginMethodGuardStorage：只保留"最后一个登录方法不可删除"，
    // 底层存储换成 DrizzleIndexedStorage。
    expect(accountStorageOverride?.overrideParameters?.['@type']).toBe('LoginMethodGuardStorage');
    expect(accountStorageOverride?.overrideParameters?.storage).toMatchObject({
      '@type': 'DrizzleIndexedStorage',
      connectionString: {
        '@id': 'urn:solid-server:default:variable:identityDbUrl',
      },
    });
  });
});
