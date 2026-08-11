import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

describe('runtime package scripts environment isolation', () => {
  it('runs xpod runtimes with explicit env files and disables Bun .env autoloading', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts.local).toContain('dotenv -e .env.local -o -- env');
    expect(pkg.scripts.local).toContain('-u CSS_REDIS_CLIENT');
    expect(pkg.scripts.local).toContain('-u REDIS_URL');
    expect(pkg.scripts.local).toContain('-u CSS_MINIO_ENDPOINT');
    expect(pkg.scripts.local).toContain('bun --no-env-file src/main.ts -e .env.local -c config/local.json');
    expect(pkg.scripts.cloud).toContain('dotenv -e .env.cloud -o -- bun --no-env-file src/main.ts -e .env.cloud -c config/cloud.json');
    expect(pkg.scripts['dev:seed']).toContain('dotenv -e .env.local -o -- env');
    expect(pkg.scripts['dev:seed']).toContain('-u CSS_REDIS_CLIENT');
    expect(pkg.scripts['dev:seed']).toContain('-u REDIS_URL');
    expect(pkg.scripts['dev:seed']).toContain('bun --no-env-file src/cli/index.ts start -e .env.local -c config/local.json');
    expect(pkg.scripts['dev:seed']).toContain('--seedConfig "$PWD/config/seed.dev.json"');
    expect(pkg.scripts['dev:cloud']).toContain('dotenv -e .env.cloud -o -- bun --no-env-file src/cli/index.ts start -e .env.cloud -c config/cloud.json --seedConfig "$PWD/config/seed.dev.json"');

    for (const name of ['local', 'cloud', 'dev:seed', 'dev:cloud']) {
      expect(pkg.scripts[name]).not.toMatch(/dotenv\s+-e\s+\.env\.(local|cloud)\s+--\s+bun\s+src\/main\.ts/);
      expect(pkg.scripts[name]).toContain(name === 'dev:seed' || name === 'dev:cloud'
        ? 'bun --no-env-file src/cli/index.ts start -e'
        : 'bun --no-env-file src/main.ts -e');
    }

    expect(pkg.scripts['dev:seed']).not.toContain('CSS_SEED_CONFIG=');
    expect(pkg.scripts['dev:cloud']).not.toContain('CSS_SEED_CONFIG=');
  });

  it('registers seedConfig with the Xpod CSS CLI and reuses the CSS resolver', async() => {
    const cli = JSON.parse(await readFile(path.join(root, 'config/cli.json'), 'utf8')) as {
      '@graph': Array<{ '@type'?: string; parameters?: Array<{ '@type'?: string; name?: string; options?: { type?: string; hidden?: boolean } }> }>;
    };
    const extractor = cli['@graph'].find((entry) => entry['@type'] === 'YargsCliExtractor');
    const seedParameter = extractor?.parameters?.find((parameter) => parameter.name === 'seedConfig');

    expect(seedParameter).toEqual(expect.objectContaining({
      '@type': 'YargsParameter',
      name: 'seedConfig',
      options: expect.objectContaining({
        type: 'string',
        hidden: true,
      }),
    }));

    const resolver = JSON.parse(await readFile(path.join(root, 'config/resolver.json'), 'utf8')) as {
      '@graph': Array<{ '@type'?: string; resolvers?: Array<Record<string, unknown>> }>;
    };
    const shorthand = resolver['@graph'].find((entry) => entry['@type'] === 'CombinedShorthandResolver');
    const seedResolver = shorthand?.resolvers?.find((entry) => entry['CombinedShorthandResolver:_resolvers_key'] === 'urn:solid-server:default:variable:seedConfig');

    expect(seedResolver).toEqual(expect.objectContaining({
      'CombinedShorthandResolver:_resolvers_key': 'urn:solid-server:default:variable:seedConfig',
      'CombinedShorthandResolver:_resolvers_value': {
        '@type': 'AssetPathExtractor',
        key: 'seedConfig',
      },
    }));
  });
});
