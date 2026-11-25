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
 * Each discovered file runs in its own Bun process, so no single process keeps every file's context
 * alive at once. Up to one process per CPU runs at a time (`--jobs N` overrides); each file's output
 * is buffered and printed whole when it finishes, so logs never interleave. Discovery, `--isolate`,
 * assertions and per-test budgets are unchanged.
 *
 * Usage: bun scripts/run-bun-tests.ts [--list] [--jobs N]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const { collectBunOnlyTests } = createRequire(import.meta.url)('./bun-test-discovery.cjs') as { collectBunOnlyTests(root: string): string[] };

type Outcome = { code: number | null; signal: NodeJS.Signals | null; error?: string; output: Buffer[] };

/** Run one already-discovered file in a fresh Bun process and settle exactly once. */
function runFile(file: string, jobs: number): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    let settled = false;
    const output: Buffer[] = [];
    const settle = (outcome: Omit<Outcome, 'output'>): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ...outcome, output });
    };
    // The absolute path is passed verbatim: a bare relative filter could match another file.
    // Bun's 5 s default timeout only exists to catch hangs; sharing the CPUs with other files
    // must not turn a slow-but-finishing test into a failure. Explicit per-test budgets still apply.
    const timeout = jobs > 1 ? ['--timeout', '30000'] : [];
    const child = spawn(process.execPath, ['test', '--isolate', ...timeout, file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    // Both streams share one buffer so the file's log keeps its original order.
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk));
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

  const jobsIndex = argv.indexOf('--jobs');
  const jobs = jobsIndex === -1 ? availableParallelism() : Number(argv[jobsIndex + 1]);
  if (!Number.isSafeInteger(jobs) || jobs < 1) {
    console.error('--jobs requires a positive integer');
    return 1;
  }

  console.log(`running ${files.length} Bun-only test file(s) with bun test, ${jobs} at a time`);
  const failed: string[] = [];
  const report = (relative: string, outcome: Outcome): void => {
    process.stdout.write(`\n=== ${relative}\n`);
    for (const chunk of outcome.output) {
      process.stdout.write(chunk);
    }
    if (outcome.error !== undefined) {
      // A startup failure is a gate failure, never a silent skip.
      console.error(`failed to start bun test for ${relative}: ${outcome.error}`);
      failed.push(relative);
    } else if (outcome.signal !== null) {
      console.error(`${relative} was terminated by ${outcome.signal}`);
      failed.push(relative);
    } else if (outcome.code !== 0) {
      // A completed nonzero child is an ordinary test failure: keep going, as `bun test` without
      // `--bail` does, so later files still run and every failure is reported.
      console.error(`${relative} exited with code ${String(outcome.code)}`);
      failed.push(relative);
    }
  };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next++];
      report(path.relative(ROOT, file), await runFile(file, jobs));
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));

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
