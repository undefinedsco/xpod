import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
          "  const rows = await (await engine.queryBindings('SELECT ?x WHERE { VALUES ?x { 1 } }')).toArray();",
          "  if (rows.length !== 1 || rows[0].get('x')?.value !== '1') process.exit(2);",
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

    for (const runtime of ['node', 'bun']) {
    const result = spawnSync(runtime, [ outputPath ], {
      cwd: temporaryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_PATH: '',
      },
      timeout: 15_000,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }
  }, 30_000);

  it('runs the normal Bun ESM bundle outside source, preserving early CSS and repeated initialization', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-comunica-esm-'));
    temporaryRoots.push(temporaryRoot);
    const entry = path.join(temporaryRoot, 'input.ts');
    await writeFile(path.join(temporaryRoot, 'package.json'), '{"type":"module"}');
    await writeFile(entry, [
      `import { createBundledQueryEngine, ensureDrizzleSolidRuntimeConfigured } from ${JSON.stringify(path.join(repoRoot, 'src/runtime/configure-drizzle-solid.ts'))};`,
      `import { createXpodComunicaQueryEngine } from ${JSON.stringify(path.join(repoRoot, 'src/storage/rdf/XpodComunicaQueryEngine.ts'))};`,
      `import * as observer from ${JSON.stringify(path.join(repoRoot, 'node_modules/@comunica/actor-query-result-serialize-sparql-json/lib/index.js'))};`,
      'const before = observer.ActionObserverHttp.prototype.onRun;',
      'ensureDrizzleSolidRuntimeConfigured(); ensureDrizzleSolidRuntimeConfigured();',
      "if (observer.ActionObserverHttp.prototype.onRun !== before) throw Error('patch initialized twice');",
      'const direct = createXpodComunicaQueryEngine();',
      'for (const engine of [direct, await createBundledQueryEngine()]) {',
      "  const rows = await (await engine.queryBindings('SELECT ?x WHERE { VALUES ?x { 1 } }')).toArray();",
      "  if (rows.length !== 1 || rows[0].get('x')?.value !== '1') throw Error('incorrect binding');",
      '}',
      "console.log('BUNDLED_QUERY_OK');",
    ].join('\n'));
    const built = spawnSync('bun', ['build', '--target=node', '--format=esm', '--outfile', path.join(temporaryRoot, 'runtime.mjs'), entry], { cwd: repoRoot, encoding: 'utf8', timeout: 15_000 });
    expect(built.status, built.stdout + built.stderr).toBe(0);
    await rm(entry);
    await writeFile(path.join(temporaryRoot, 'entry.mjs'), "import {createRequire} from 'node:module';globalThis.require=createRequire(import.meta.url);await import('./runtime.mjs');");
    const profile = path.join(temporaryRoot, 'deny.sb');
    await writeFile(profile, `(version 1)\n(allow default)\n(deny file-read* (subpath ${JSON.stringify(repoRoot)}))\n`);
    for (const runtime of ['node', 'bun']) {
      const command = process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : runtime;
      const args = process.platform === 'darwin' ? ['-f', profile, runtime, path.join(temporaryRoot, 'entry.mjs')] : [path.join(temporaryRoot, 'entry.mjs')];
      const result = spawnSync(command, args, { cwd: temporaryRoot, encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH, HOME: temporaryRoot, NODE_PATH: '', NODE_OPTIONS: '' } });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('BUNDLED_QUERY_OK');
    }
  }, 45_000);
});
