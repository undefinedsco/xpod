import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const requireFromRepo = createRequire(`${process.cwd()}/package.json`);

describe('package exports', () => {
  it('exposes the managed task API as a public package subpath', () => {
    const packageJson = requireFromRepo('./package.json') as {
      exports?: Record<string, unknown>;
    };

    expect(packageJson.exports).toMatchObject({
      './api/tasks': {
        types: './dist/api/tasks/index.d.ts',
        default: './dist/api/tasks/index.js',
      },
    });
  });
});
