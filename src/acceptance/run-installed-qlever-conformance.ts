#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runLocalQleverSemanticConformance,
  runPostgresQleverSemanticConformance,
} from './QleverSemanticConformance';
import type { SemanticConformanceReport } from './RdfSemanticConformance';
import {
  createLocalNativeSearchEngine,
  runNativeSearchFusionAcceptance,
  runPostgresNativeSearchFusionAcceptance,
  type NativeSearchConformanceReport,
} from './QleverSearchConformance';
import { resolveLocalQleverRuntimeCommand } from '../storage/rdf/LocalQleverNativeSparqlClient';

interface InstalledConformanceReport {
  schemaVersion: 1;
  backend: 'sqlite' | 'pg';
  status: 'ok';
  semantic: SemanticConformanceReport;
  search: NativeSearchConformanceReport;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function runInstalledQleverConformance(): Promise<InstalledConformanceReport> {
  const backend = requiredEnv('XPOD_QLEVER_CONFORMANCE_BACKEND');
  if (backend !== 'sqlite' && backend !== 'pg') {
    throw new Error(`XPOD_QLEVER_CONFORMANCE_BACKEND must be sqlite or pg, got ${backend}`);
  }
  const fixturePath = requiredEnv('XPOD_QLEVER_SEMANTIC_FIXTURE_PATH');
  const artifactPath = requiredEnv('XPOD_QLEVER_CONFORMANCE_ARTIFACT_PATH');
  const timeoutMs = Number(process.env.XPOD_QLEVER_CONFORMANCE_TIMEOUT_MS ?? 60_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('XPOD_QLEVER_CONFORMANCE_TIMEOUT_MS must be a positive integer');
  }
  const tempRoot = process.env.XPOD_QLEVER_CONFORMANCE_TEMP_ROOT
    ?? path.join(os.tmpdir(), `xpod-qlever-installed-${process.pid}-${randomUUID()}`);
  mkdirSync(tempRoot, { recursive: true });

  let semantic: SemanticConformanceReport;
  let search: NativeSearchConformanceReport;
  if (backend === 'sqlite') {
    const runtimeCommand = resolveLocalQleverRuntimeCommand();
    semantic = await runLocalQleverSemanticConformance({
      fixturePath,
      runtimeCommand,
      artifactPath: path.join(tempRoot, 'sqlite-semantic.json'),
      tempRoot: path.join(tempRoot, 'semantic'),
      timeoutMs,
    });
    const searchDatabase = path.join(tempRoot, 'search.sqlite');
    rmSync(searchDatabase, { force: true });
    search = await runNativeSearchFusionAcceptance(
      createLocalNativeSearchEngine(runtimeCommand, searchDatabase),
    );
  } else {
    const connectionString = requiredEnv('XPOD_QLEVER_PG_DSN');
    semantic = await runPostgresQleverSemanticConformance({
      fixturePath,
      connectionString,
      artifactPath: path.join(tempRoot, 'pg-semantic.json'),
      timeoutMs,
    });
    search = await runPostgresNativeSearchFusionAcceptance(connectionString);
  }

  if (semantic.status !== 'ok' || semantic.skipped.length !== 0 || semantic.failed.length !== 0) {
    throw new Error(`${backend} semantic conformance failed: ${JSON.stringify(semantic.failed)}`);
  }
  const report: InstalledConformanceReport = {
    schemaVersion: 1,
    backend,
    status: 'ok',
    semantic,
    search,
  };
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) {
  runInstalledQleverConformance()
    .then((report) => process.stdout.write(`${JSON.stringify({
      status: report.status,
      backend: report.backend,
      semanticCases: report.semantic.results.length,
      search: report.search,
    })}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
