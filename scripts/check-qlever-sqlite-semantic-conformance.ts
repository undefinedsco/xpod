#!/usr/bin/env bun
import { runLocalQleverSemanticConformance } from '../src/acceptance/QleverSemanticConformance';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readOptionalIntegerEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const report = await runLocalQleverSemanticConformance({
    fixturePath: requiredEnv('XPOD_QLEVER_SEMANTIC_FIXTURE_PATH'),
    runtimeCommand: requiredEnv('XPOD_QLEVER_SQLITE_RUNTIME_COMMAND'),
    artifactPath: requiredEnv('XPOD_QLEVER_SQLITE_SEMANTIC_ARTIFACT_PATH'),
    tempRoot: process.env.XPOD_QLEVER_SQLITE_SEMANTIC_TEMP_ROOT,
    runtimeCwd: process.env.XPOD_QLEVER_SQLITE_RUNTIME_CWD,
    timeoutMs: readOptionalIntegerEnv('XPOD_QLEVER_SQLITE_SEMANTIC_TIMEOUT_MS'),
  });

  if (hasFlag('--json')) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write([
      `[qlever-sqlite-semantic-conformance] backend: ${report.backend}`,
      `[qlever-sqlite-semantic-conformance] engine: ${report.engine}`,
      `[qlever-sqlite-semantic-conformance] cases: ${report.results.length}/${report.caseIds.length}`,
      `[qlever-sqlite-semantic-conformance] failed: ${report.failed.length}`,
      `[qlever-sqlite-semantic-conformance] deniedRowsObserved: ${report.authorization.deniedRowsObserved}`,
      `[qlever-sqlite-semantic-conformance] canonicalDigest: ${report.canonicalDigest}`,
      `[qlever-sqlite-semantic-conformance] ${report.status === 'ok' ? 'OK' : 'FAILED'}`,
    ].join('\n'));
    process.stdout.write('\n');
  }

  if (report.status !== 'ok') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const failure = {
    status: 'failed',
    backend: 'sqlite',
    error: error instanceof Error ? error.message : String(error),
    command: [
      'XPOD_QLEVER_SEMANTIC_FIXTURE_PATH=<fixture.cjs>',
      'XPOD_QLEVER_SQLITE_RUNTIME_COMMAND=<xpod_qlever_local_runtime>',
      'XPOD_QLEVER_SQLITE_SEMANTIC_ARTIFACT_PATH=<sqlite-report.json>',
      'bun scripts/check-qlever-sqlite-semantic-conformance.ts',
    ].join(' '),
  };
  process.stdout.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
});
