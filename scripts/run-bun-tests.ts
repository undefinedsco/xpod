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
 * Each discovered file runs sequentially in its own Bun process, so no single process keeps every
 * file's context alive at once. Discovery, `--isolate`, assertions and per-test budgets are unchanged.
 *
 * Usage: bun scripts/run-bun-tests.ts [--list]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const { collectBunOnlyTests } = createRequire(import.meta.url)('./bun-test-discovery.cjs') as { collectBunOnlyTests(root: string): string[] };

type Outcome = { code: number | null; signal: NodeJS.Signals | null; error?: string };

/** Run one already-discovered file in a fresh Bun process and settle exactly once. */
function runFile(file: string): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    let settled = false;
    const settle = (outcome: Outcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(outcome);
    };
    // The absolute path is passed verbatim: a bare relative filter could match another file.
    const child = spawn(process.execPath, ['test', '--isolate', file], { cwd: ROOT, stdio: 'inherit' });
    // Settle after the child has closed.
    child.on('close', (code, signal) => settle({ code, signal }));
    child.on('error', (error) => settle({ code: null, signal: null, error: error.message }));
  });
}

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
  const failed: string[] = [];
  for (const file of files) {
    const relative = path.relative(ROOT, file);
    console.log(`\n=== ${relative}`);
    const outcome = await runFile(file);
    if (outcome.error !== undefined) {
      // A startup failure is a gate failure, never a silent skip.
      console.error(`failed to start bun test for ${relative}: ${outcome.error}`);
      failed.push(relative);
      continue;
    }
    if (outcome.signal !== null) {
      console.error(`${relative} was terminated by ${outcome.signal}`);
      failed.push(relative);
      continue;
    }
    if (outcome.code !== 0) {
      // A completed nonzero child is an ordinary test failure: keep going, as `bun test` without
      // `--bail` does, so later files still run and every failure is reported.
      console.error(`${relative} exited with code ${String(outcome.code)}`);
      failed.push(relative);
    }
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${files.length} Bun-only test file(s) failed:`);
    for (const file of failed) {
      console.error(`  ${file}`);
    }
    return 1;
  }
  return 0;
}

process.exit(await main(process.argv.slice(2)));
