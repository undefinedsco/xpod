import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('drizzle-solid SPARQL runtime bundle', () => {
  it('constructs Comunica without resolving a runtime node_modules package', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-comunica-bundle-'));
    temporaryRoots.push(temporaryRoot);
    const outputPath = path.join(temporaryRoot, 'runtime.cjs');

    await build({
      stdin: {
        contents: [
          "import { createBundledQueryEngine } from './src/runtime/configure-drizzle-solid.ts';",
          '(async () => {',
          '  const engine = await createBundledQueryEngine();',
          "  if (typeof engine.queryBindings !== 'function') process.exit(2);",
          '})().catch((error) => { console.error(error); process.exit(1); });',
        ].join('\n'),
        resolveDir: repoRoot,
        sourcefile: 'runtime-bundle-entry.ts',
        loader: 'ts',
      },
      outfile: outputPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent',
    });

    const result = spawnSync('bun', [ outputPath ], {
      cwd: temporaryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_PATH: '',
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 30_000);
});
