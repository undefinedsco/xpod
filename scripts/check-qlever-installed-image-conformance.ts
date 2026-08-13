#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertSemanticConformanceParity } from '../src/acceptance/QleverSemanticConformance';
import type { NativeSearchConformanceReport } from '../src/acceptance/QleverSearchConformance';

interface Args {
  installedImage: string;
  pgImage: string;
  fixturePath: string;
  artifactDir: string;
  timeoutMs: number;
}

interface InstalledReport {
  schemaVersion: 1;
  backend: 'sqlite' | 'pg';
  status: 'ok';
  semantic: Parameters<typeof assertSemanticConformanceParity>[0];
  search: NativeSearchConformanceReport;
}

const IMMUTABLE_IMAGE_REF = /^.+@sha256:[a-f0-9]{64}$/;
const FORBIDDEN_PRODUCT_LOG = /product[- ]fallback|compatibility.*fallback|rdf3x|degraded|stub|mock/iu;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireImmutableImage(name: string, value: string): string {
  if (!IMMUTABLE_IMAGE_REF.test(value)) {
    throw new Error(`${name} must be an immutable image digest reference: ${value}`);
  }
  return value;
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function readArgs(): Args {
  return {
    installedImage: requireImmutableImage(
      'XPOD_INSTALLED_IMAGE_REF',
      required('XPOD_INSTALLED_IMAGE_REF', argValue('--installed-image') ?? process.env.XPOD_INSTALLED_IMAGE_REF),
    ),
    pgImage: requireImmutableImage(
      'XPOD_PG17_QLEVER_IMAGE_REF',
      required('XPOD_PG17_QLEVER_IMAGE_REF', argValue('--pg-image') ?? process.env.XPOD_PG17_QLEVER_IMAGE_REF),
    ),
    fixturePath: path.resolve(required(
      'XPOD_QLEVER_SEMANTIC_FIXTURE_PATH',
      argValue('--fixture') ?? process.env.XPOD_QLEVER_SEMANTIC_FIXTURE_PATH,
    )),
    artifactDir: path.resolve(
      argValue('--artifact-dir')
      ?? process.env.XPOD_QLEVER_INSTALLED_CONFORMANCE_ARTIFACT_DIR
      ?? mkdtempSync(path.join(tmpdir(), 'xpod-qlever-installed-conformance-')),
    ),
    timeoutMs: positiveInteger(
      'XPOD_QLEVER_INSTALLED_CONFORMANCE_TIMEOUT_MS',
      process.env.XPOD_QLEVER_INSTALLED_CONFORMANCE_TIMEOUT_MS ?? '1200000',
    ),
  };
}

function runStep(
  label: string,
  command: string,
  commandArgs: string[],
  options: { scanProductLogs?: boolean; timeoutMs?: number } = {},
): string {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (options.scanProductLogs !== false && FORBIDDEN_PRODUCT_LOG.test(output)) {
    throw new Error(`${label} emitted a forbidden product fallback marker\n${output}`);
  }
  if (result.error) throw new Error(`${label} failed: ${result.error.message}\n${output}`);
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status}\n${output}`);
  return output;
}

async function waitForPg17(container: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'xpod'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (ready.status === 0) {
      const native = spawnSync('docker', [
        'exec', container, 'psql', '-U', 'postgres', '-d', 'xpod', '-Atc',
        "SELECT xpod_rdf.native_sparql_capabilities()->>'ready'",
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (native.status === 0 && native.stdout.trim() === 'true') return;
    }
    await Bun.sleep(1_000);
  }
  throw new Error('PG17 QLever image did not become native-ready within 120 seconds');
}

function runInstalledProduct(
  args: Args,
  network: string,
  backend: 'sqlite' | 'pg',
  artifactPath: string,
): void {
  const dockerArgs = [
    'run', '--rm', '--network', network,
    '--mount', `type=bind,src=${args.fixturePath},dst=/fixtures/qlever-semantic-conformance.cjs,readonly`,
    '--mount', `type=bind,src=${args.artifactDir},dst=/artifacts`,
    '-e', `XPOD_QLEVER_CONFORMANCE_BACKEND=${backend}`,
    '-e', 'XPOD_QLEVER_SEMANTIC_FIXTURE_PATH=/fixtures/qlever-semantic-conformance.cjs',
    '-e', `XPOD_QLEVER_CONFORMANCE_ARTIFACT_PATH=/artifacts/${path.basename(artifactPath)}`,
    '-e', `XPOD_QLEVER_CONFORMANCE_TIMEOUT_MS=${args.timeoutMs}`,
  ];
  if (backend === 'pg') {
    dockerArgs.push('-e', 'XPOD_QLEVER_PG_DSN=postgres://postgres:xpod@qlever-pg:5432/xpod');
  }
  dockerArgs.push(
    args.installedImage,
    'node', 'dist/acceptance/run-installed-qlever-conformance.js',
  );
  runStep(`installed Xpod ${backend} conformance`, 'docker', dockerArgs, { timeoutMs: args.timeoutMs });
}

async function main(): Promise<void> {
  const args = readArgs();
  mkdirSync(args.artifactDir, { recursive: true });
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const network = `xpod-qlever-conformance-${suffix}`;
  const pgContainer = `xpod-qlever-pg-${suffix}`;
  const sqliteArtifact = path.join(args.artifactDir, 'sqlite-installed-conformance.json');
  const pgArtifact = path.join(args.artifactDir, 'pg-installed-conformance.json');

  runStep('inspect installed Xpod image', 'docker', ['image', 'inspect', args.installedImage], { scanProductLogs: false });
  runStep('inspect PG17 QLever image', 'docker', ['image', 'inspect', args.pgImage], { scanProductLogs: false });
  runStep('create conformance network', 'docker', ['network', 'create', network], { scanProductLogs: false });
  try {
    runInstalledProduct(args, network, 'sqlite', sqliteArtifact);
    runStep('start PG17 QLever image', 'docker', [
      'run', '--rm', '-d', '--name', pgContainer, '--network', network, '--network-alias', 'qlever-pg',
      '-e', 'POSTGRES_PASSWORD=xpod', '-e', 'POSTGRES_DB=xpod', args.pgImage,
    ], { scanProductLogs: false });
    await waitForPg17(pgContainer);
    runInstalledProduct(args, network, 'pg', pgArtifact);

    const pgLogs = runStep('read PG17 QLever logs', 'docker', ['logs', pgContainer], { scanProductLogs: false });
    if (FORBIDDEN_PRODUCT_LOG.test(pgLogs)) {
      throw new Error(`PG17 QLever logs emitted a forbidden product fallback marker\n${pgLogs}`);
    }
    const local = JSON.parse(readFileSync(sqliteArtifact, 'utf8')) as InstalledReport;
    const cloud = JSON.parse(readFileSync(pgArtifact, 'utf8')) as InstalledReport;
    const semanticParity = assertSemanticConformanceParity(local.semantic, cloud.semantic);
    if (JSON.stringify(local.search) !== JSON.stringify(cloud.search)) {
      throw new Error(`Local/Cloud native search mismatch\nlocal=${JSON.stringify(local.search)}\ncloud=${JSON.stringify(cloud.search)}`);
    }

    writeFileSync(path.join(args.artifactDir, 'installed-image-conformance.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'ok',
      installedImage: args.installedImage,
      pgImage: args.pgImage,
      semanticParity,
      search: local.search,
      artifacts: { sqlite: sqliteArtifact, pg: pgArtifact },
    }, null, 2)}\n`);
  } finally {
    spawnSync('docker', ['rm', '-f', pgContainer], { stdio: 'ignore' });
    spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
