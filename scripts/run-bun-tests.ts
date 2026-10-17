#!/usr/bin/env bun
/**
 * The Bun test entry (audit N19).
 *
 * Some tests cannot run under vitest: they import `bun:test` (and sometimes Bun-only APIs). They
 * were excluded from `vitest.config.ts` and had no runner of their own, so they could rot without
 * anyone noticing — which is how `ui/src/api/network-settings.test.ts` drifted away from the
 * signature of the module it tests.
 *
 * This script collects exactly those files and runs them under `bun test`:
 *   - everything under `tests/bun/**`, and
 *   - every file outside it that imports `bun:test`.
 *
 * Usage: bun scripts/run-bun-tests.ts [--list]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const { collectBunOnlyTests } = createRequire(import.meta.url)('./bun-test-discovery.cjs') as { collectBunOnlyTests(root: string): string[] };

async function main(argv: string[]): Promise<number> {
  const files = collectBunOnlyTests(ROOT);
  if (files.length === 0) {
    console.error('no Bun-only test files found; the entry would silently run nothing');
    return 1;
  }

  if (argv.includes('--list')) {
    for (const file of files) {
      console.log(path.relative(ROOT, file));
    }
    console.log(`${files.length} Bun-only test file(s)`);
    return 0;
  }

  console.log(`running ${files.length} Bun-only test file(s) with bun test`);
  const child = spawn('bun', [ 'test', ...files ], { cwd: ROOT, stdio: 'inherit' });
  return await new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      console.error(`failed to start bun test: ${error.message}`);
      resolve(1);
    });
  });
}

process.exit(await main(process.argv.slice(2)));
