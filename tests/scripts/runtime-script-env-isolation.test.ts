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
    expect(pkg.scripts['dev:seed']).toContain('bun --no-env-file src/main.ts -e .env.local -c config/local.json');
    expect(pkg.scripts['dev:cloud']).toContain('dotenv -e .env.cloud -o -- bun --no-env-file src/main.ts -e .env.cloud -c config/cloud.json');

    for (const name of ['local', 'cloud', 'dev:seed', 'dev:cloud']) {
      expect(pkg.scripts[name]).not.toMatch(/dotenv\s+-e\s+\.env\.(local|cloud)\s+--\s+bun\s+src\/main\.ts/);
      expect(pkg.scripts[name]).toContain('bun --no-env-file src/main.ts -e');
    }
  });
});
