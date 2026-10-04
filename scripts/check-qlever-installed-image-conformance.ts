#!/usr/bin/env bun
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import {
  assertSemanticConformanceParity,
  buildSemanticReport,
  type SemanticFixtureModule,
  type SemanticConformanceReport,
} from '../src/acceptance/RdfSemanticConformance';
import type { NativeSearchConformanceReport } from '../src/acceptance/QleverSearchConformance';

// This CLI runs in Bun; the repository's test compiler has no ambient Bun types.
declare const Bun: { sleep(milliseconds: number): Promise<void> };

interface Args {
  installedImage: string;
  pgImage: string;
  fixturePath: string;
  artifactDir: string;
  timeoutMs: number;
  sourceSha: string;
  sourceUrl: string;
  runnerSha256: string;
}

interface InstalledReport {
  schemaVersion: 1;
  backend: 'sqlite' | 'pg';
  status: 'ok';
  semantic: SemanticConformanceReport;
  search: NativeSearchConformanceReport;
}

const IMMUTABLE_IMAGE_REF = /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/;
const DOCKER_PROBE_TIMEOUT_MS = 5_000;
const PUBLIC_FIXTURE_SHA256 = 'c15f1bba83aff573b9e3bab685bf66bacb35cd82bac7a13e93e8163559ed5778';
const FORBIDDEN_PRODUCT_LOG = /product[- ]fallback|compatibility.*fallback|rdf3x|degraded|stub|mock/iu;
const RUNNER_PATH = 'dist/acceptance/run-installed-qlever-conformance.js';

class StepError extends Error {
  constructor(readonly stage: string, readonly exitStatus: number, readonly errorClass: string, diagnostic?: string) {
    super(JSON.stringify({ stage, errorClass, ...(diagnostic ? { diagnostic } : {}) }));
  }
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new StepError(name, 1, 'missing-input');
  return value;
}

function requireImmutableImage(name: string, value: string): string {
  if (!IMMUTABLE_IMAGE_REF.test(value)) throw new StepError(name, 1, 'mutable-image');
  return value;
}

function readArgs(): Args {
  const sourceSha = required('source-sha', argValue('--source-sha') ?? process.env.XPOD_SOURCE_SHA);
  const runnerSha256 = required('runner-sha256', argValue('--runner-sha256'));
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^[a-f0-9]{64}$/.test(runnerSha256)) {
    throw new StepError('source-binding', 1, 'invalid-source-or-runner-hash');
  }
  const timeoutMs = Number(process.env.XPOD_QLEVER_INSTALLED_CONFORMANCE_TIMEOUT_MS ?? '1200000');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new StepError('timeout', 1, 'invalid-input');
  return {
    installedImage: requireImmutableImage('XPOD_INSTALLED_IMAGE_REF', required(
      'XPOD_INSTALLED_IMAGE_REF', argValue('--installed-image') ?? process.env.XPOD_INSTALLED_IMAGE_REF,
    )),
    pgImage: requireImmutableImage('XPOD_PG17_QLEVER_IMAGE_REF', required(
      'XPOD_PG17_QLEVER_IMAGE_REF', argValue('--pg-image') ?? process.env.XPOD_PG17_QLEVER_IMAGE_REF,
    )),
    fixturePath: path.resolve(required('XPOD_QLEVER_SEMANTIC_FIXTURE_PATH',
      argValue('--fixture') ?? process.env.XPOD_QLEVER_SEMANTIC_FIXTURE_PATH)),
    artifactDir: path.resolve(argValue('--artifact-dir') ?? process.env.XPOD_QLEVER_INSTALLED_CONFORMANCE_ARTIFACT_DIR
      ?? mkdtempSync(path.join(tmpdir(), 'xpod-qlever-installed-conformance-'))),
    timeoutMs, sourceSha, runnerSha256,
    sourceUrl: 'https://github.com/undefinedsco/xpod',
  };
}

function runStep(
  stage: string,
  commandArgs: string[],
  options: { scanProductLogs?: boolean; timeoutMs?: number } = {},
): string {
  const result = spawnSync('docker', commandArgs, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: options.timeoutMs ?? DOCKER_PROBE_TIMEOUT_MS,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new StepError(stage, result.status && result.status > 0 ? result.status : 1,
      result.signal ? 'signal' : result.error ? 'execution-error' : 'producer-failed');
  }
  if (options.scanProductLogs !== false && FORBIDDEN_PRODUCT_LOG.test(`${result.stdout}\n${result.stderr}`)) {
    throw new StepError(stage, 1, 'forbidden-product-fallback');
  }
  return result.stdout.trim();
}

export function validateInstalledReport(
  report: InstalledReport,
  backend: InstalledReport['backend'],
  fixture: SemanticFixtureModule,
): void {
  if (report.schemaVersion !== 1 || report.status !== 'ok' || report.backend !== backend) {
    throw new Error('invalid installed report envelope');
  }
  const semantic = report.semantic;
  const expectedEngine = backend === 'sqlite'
    ? 'local-qlever-prepared-update-authority' : 'pg-qlever-prepared-update-authority';
  if (semantic.schemaVersion !== 1 || semantic.backend !== backend || semantic.engine !== expectedEngine
    || semantic.status !== 'ok' || semantic.skipped.length || semantic.failed.length
    || !isDeepStrictEqual(semantic.caseIds, [...fixture.REQUIRED_CASES])
    || semantic.results.length !== fixture.REQUIRED_CASES.length
    || semantic.authorization.deniedRowsObserved !== 0 || !semantic.sourceScope.sourceDeniedValidatedBy) {
    throw new Error('incomplete semantic conformance');
  }
  fixture.semanticConformanceCases.forEach((testCase, index) => {
    const result = semantic.results[index];
    if (result.caseId !== testCase.id || result.status !== 'ok'
      || !isDeepStrictEqual(result.canonical, testCase.expectedCanonical)
      || result.preparedUpdates !== testCase.updates.length
      || !Number.isInteger(result.appliedDelta.deletedRows) || result.appliedDelta.deletedRows < 0
      || !Number.isInteger(result.appliedDelta.insertedRows) || result.appliedDelta.insertedRows < 0
      || !result.authority.startsWith(backend === 'sqlite' ? 'sqlite:' : 'postgres-schema:')) throw new Error('semantic canonical or authority mismatch');
  });
  const recomputed = buildSemanticReport({
    backend, engine: expectedEngine, caseIds: semantic.caseIds, failed: semantic.failed,
    results: semantic.results, sourceDeniedValidatedBy: semantic.sourceScope.sourceDeniedValidatedBy,
  });
  if (semantic.canonicalDigest !== recomputed.canonicalDigest) throw new Error('semantic digest mismatch');
  const content = 'alpha late vector canonical card';
  const oldRow = [{ retrieval: content, source: 'https://pod.example/alice/projects/native/old-card.md' }];
  const movedRow = [{ retrieval: content, source: 'https://pod.example/alice/projects/native/moved-card.md' }];
  const expectedSearch: NativeSearchConformanceReport = {
    textOnlyBeforeVector: [{ retrieval: content }], fusedBeforeVector: [],
    fusedAfterVector: oldRow, fusedAfterVectorExact: oldRow,
    fusedDuringMove: movedRow, fusedDuringMoveExact: movedRow, fusedAfterMove: movedRow,
    oldSourceAfterMove: [], deniedSource: [],
  };
  if (!isDeepStrictEqual(report.search, expectedSearch)) throw new Error('incomplete native search conformance');
}

export function validateImageInspection(raw: string, ref: string, source?: { sha: string; url: string }): void {
  const images = JSON.parse(raw) as { RepoDigests?: string[]; Config?: { Labels?: Record<string, string> } }[];
  if (images.length !== 1 || !images[0].RepoDigests?.includes(ref)) throw new Error('image digest mismatch');
  if (source && (images[0].Config?.Labels?.['org.opencontainers.image.revision'] !== source.sha
    || images[0].Config?.Labels?.['org.opencontainers.image.source'] !== source.url)) {
    throw new Error('image source mismatch');
  }
}

function registryAuth(entry: unknown): string {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error();
  const value = entry as Record<string, unknown>;
  if (Object.keys(value).some(key => !['auth', 'username', 'password', 'email'].includes(key))) throw new Error();
  if (value.email !== undefined && typeof value.email !== 'string') throw new Error();
  let auth: string | undefined;
  if (value.auth !== undefined) {
    if (typeof value.auth !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.auth)) throw new Error();
    const bytes = Buffer.from(value.auth, 'base64');
    const decoded = bytes.toString('utf8');
    const separator = decoded.indexOf(':');
    if (bytes.toString('base64') !== value.auth || !Buffer.from(decoded).equals(bytes)
      || separator <= 0) throw new Error();
    auth = value.auth;
  }
  if (value.username !== undefined || value.password !== undefined) {
    if (typeof value.username !== 'string' || !value.username || value.username.includes(':')
      || typeof value.password !== 'string') throw new Error();
    const provided = Buffer.from(`${value.username}:${value.password}`).toString('base64');
    if (auth !== undefined && auth !== provided) throw new Error('inconsistent-authority-credentials');
    auth = provided;
  }
  if (!auth) throw new Error();
  return auth;
}

export function installRegistryConfig(raw: string, existingRaw: string, output: string): void {
  let stage = 'registry-parse';
  let diagnostic = 'source-json';
  try {
    const source = JSON.parse(raw) as { auths?: Record<string, unknown> };
    diagnostic = 'existing-json';
    const existing = JSON.parse(existingRaw) as { auths?: Record<string, unknown> };
    stage = 'registry-authority';
    diagnostic = 'auths-shape';
    if (!source?.auths || typeof source.auths !== 'object' || Array.isArray(source.auths)) throw new Error();
    // Docker accepts legacy scheme-prefixed keys. Admit only this fixed authority;
    // never execute credential helpers or carry foreign registry credentials forward.
    const keys = ['ccr.ccs.tencentyun.com', 'https://ccr.ccs.tencentyun.com',
      'https://ccr.ccs.tencentyun.com/', 'https://ccr.ccs.tencentyun.com/v1/'];
    const selected = keys.filter(key => Object.prototype.hasOwnProperty.call(source.auths, key));
    diagnostic = 'missing-authority';
    if (!selected.length) throw new Error();
    diagnostic = 'invalid-auth-entry';
    const entries = selected.map(key => registryAuth(source.auths![key]));
    diagnostic = 'inconsistent-authority-credentials';
    if (entries.some(auth => auth !== entries[0])) throw new Error();
    const auths: Record<string, unknown> = { 'ccr.ccs.tencentyun.com': { auth: entries[0] } };
    if (existing?.auths?.['ghcr.io']) auths['ghcr.io'] = existing.auths['ghcr.io'];
    stage = 'registry-write';
    diagnostic = 'exclusive-owned-write';
    writeFileSync(output, `${JSON.stringify({ auths })}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (diagnostic === 'invalid-auth-entry' && error instanceof Error
      && error.message === 'inconsistent-authority-credentials') diagnostic = 'inconsistent-authority-credentials';
    throw new StepError(stage, 1, 'authorized-config-rejected', diagnostic);
  }
}

interface PullJob {
  metadata: { name: string; namespace: string; uid: string };
  spec: { template: { spec: {
    volumes?: unknown[]; initContainers?: unknown[];
    imagePullSecrets: { name: string }[];
    containers: { name: string; image: string; imagePullPolicy: string; volumeMounts?: unknown[] }[];
  } } };
  status?: { conditions?: { type: string; status: string }[] };
}
interface PullPod {
  metadata: { uid: string; ownerReferences: { uid: string; kind: string; controller?: boolean }[] };
  status: { phase: string; containerStatuses: { name: string; imageID: string; state: { terminated?: { exitCode: number } } }[] };
}

interface AuthorityWorkload {
  kind?: unknown;
  metadata?: { name?: unknown; namespace?: unknown };
  spec?: { template?: { spec?: {
    imagePullSecrets?: { name?: unknown }[];
    containers?: { image?: unknown }[];
  } } };
}

const AUTHORITY_SECRET_NAME = /^[a-z0-9](?:[-a-z0-9]{0,251}[a-z0-9])?$/;

// The registry authority is declared by the existing fixed-PG17 workload that
// already pulls the exact immutable image; it is not a new user setting. Admit
// exactly one unique, non-conflicting imagePullSecret on that workload.
export function selectRegistryAuthority(workload: AuthorityWorkload, expectedPgImage: string): string {
  requireImmutableImage('pg-image', expectedPgImage);
  const spec = workload?.spec?.template?.spec;
  if (!spec || !isDeepStrictEqual(workload.kind, 'StatefulSet') && !isDeepStrictEqual(workload.kind, 'Deployment')
    || !Array.isArray(spec.containers) || spec.containers.length !== 1
    || spec.containers[0]?.image !== expectedPgImage) {
    throw new Error('fixed PG17 workload image binding failed');
  }
  const secrets = spec.imagePullSecrets;
  if (!Array.isArray(secrets) || secrets.length !== 1
    || typeof secrets[0]?.name !== 'string' || !AUTHORITY_SECRET_NAME.test(secrets[0].name)) {
    throw new Error('fixed PG17 workload authority is not a single unique declaration');
  }
  return secrets[0].name;
}

export function validatePullJob(job: PullJob, pods: PullPod[], expected: {
  name: string; namespace: string; uid: string; image: string; authorityName: string;
}): { jobUID: string; podUID: string; imageID: string } {
  const spec = job.spec.template.spec;
  if (!expected.uid || job.metadata.uid !== expected.uid || job.metadata.name !== expected.name
    || job.metadata.namespace !== expected.namespace
    || !AUTHORITY_SECRET_NAME.test(expected.authorityName)
    || !job.status?.conditions?.some(condition => condition.type === 'Complete' && condition.status === 'True')
    || job.status.conditions.some(condition => condition.type === 'Failed' && condition.status === 'True')
    || spec.volumes?.length || spec.initContainers?.length
    || !isDeepStrictEqual(spec.imagePullSecrets, [{ name: expected.authorityName }]) || spec.containers.length !== 1
    || spec.containers[0].image !== expected.image || spec.containers[0].imagePullPolicy !== 'Always'
    || spec.containers[0].volumeMounts?.length) throw new Error('fresh namespace pull job contract failed');
  if (pods.length !== 1 || !pods[0].metadata.uid || !pods[0].metadata.ownerReferences?.some(
    owner => owner.kind === 'Job' && owner.uid === expected.uid && owner.controller === true,
  ) || pods[0].status.phase !== 'Succeeded') throw new Error('pull pod ownership or completion failed');
  const statuses = pods[0].status.containerStatuses;
  const digest = expected.image.split('@')[1];
  if (statuses.length !== 1 || statuses[0].name !== spec.containers[0].name
    || statuses[0].state.terminated?.exitCode !== 0
    || ![expected.image, `docker-pullable://${expected.image}`, `containerd://${digest}`, `cri-o://${digest}`]
      .includes(statuses[0].imageID)) throw new Error('pull pod image digest failed');
  return { jobUID: job.metadata.uid, podUID: pods[0].metadata.uid, imageID: statuses[0].imageID };
}

const PRIVATE_FIXTURE_SHA256 = '09e389146adc51a10a26785a34ef471c66d8bbf00f61b0b69d536d29874120b8';
const PRIVATE17_CASE_SET_SHA256 = '348777fe09a4e4baba4287e579cb7b665e5d83aeab144819beb16cb34e12d24e';
const PRIVATE17_VALIDATOR_SHA256 = '3436b584435f2ea25f28d14cede7721444d333da4ca2305919b4e7cbdc726034';
const PRIVATE17_CONTRACT_SHA256 = '6f1346e598f11959b1e696639fd151f498bd8901ef658c5613435a44d5c46ca1';
// Fail closed until the private producer's final frozen source is admitted by ROOT.
const PRIVATE17_PRODUCER_SHA256 = '0fe0ca179fd4544188dc5a5d60ea7ee1ebe24f8ac4acb7f56471c3294271aa34';
const PRIVATE17_MAX_BYTES = 64 * 1024;
const PRIVATE17_ASSET = 'private17-admission.json';
const SHA256 = /^[a-f0-9]{64}$/;
const byteDigest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function strictObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error('private17 JSON fields mismatch');
  }
  return value as Record<string, unknown>;
}

export function private17ProofTag(sourceSha: string, installedImage: string): string {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)
    || !/^ghcr\.io\/undefinedsco\/xpod@sha256:[a-f0-9]{64}$/.test(installedImage)) {
    throw new StepError('private17-binding', 1, 'invalid-source-or-image');
  }
  return `private17-${sourceSha}-${installedImage.split('@sha256:')[1]}`;
}

/** Release transports bytes; ROOT's separately configured SHA is the authority. */
export function acquirePrivate17Admission(output: string, expected: {
  sourceSha: string; installedImage: string; admissionSha256: string;
}): void {
  const tag = private17ProofTag(expected.sourceSha, expected.installedImage);
  if (!SHA256.test(expected.admissionSha256)) throw new StepError('private17-authority', 1, 'missing-or-invalid-authority');
  if (path.basename(output) !== PRIVATE17_ASSET) throw new StepError('private17-path', 1, 'unexpected-asset');
  const download = spawnSync('gh', ['release', 'download', tag, '--repo', 'undefinedsco/xpod',
    '--pattern', PRIVATE17_ASSET, '--output', '-'], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: PRIVATE17_MAX_BYTES,
  });
  if (download.error || download.signal || download.status !== 0) {
    throw new StepError('private17-download', download.status && download.status > 0 ? download.status : 1,
      download.signal ? 'signal' : download.error ? 'execution-error' : 'producer-failed');
  }
  const bytes = download.stdout;
  if (!bytes?.length || bytes.length > PRIVATE17_MAX_BYTES) throw new StepError('private17-size', 1, 'invalid-size');
  if (byteDigest(bytes) !== expected.admissionSha256) throw new StepError('private17-authority', 1, 'authority-mismatch');
  writeFileSync(output, bytes, { mode: 0o600, flag: 'wx' });
}

function private17Bytes(file: string): Buffer {
  if (path.basename(file) !== PRIVATE17_ASSET) throw new Error('private17 asset path mismatch');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > PRIVATE17_MAX_BYTES) throw new Error('private17 size mismatch');
    const bytes = Buffer.alloc(PRIVATE17_MAX_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (!count || count > PRIVATE17_MAX_BYTES) throw new Error('private17 size mismatch');
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}

export function verifyPrivate17Admission(file: string, expected: {
  admissionSha256: string; installedImage: string; pgImage: string; sourceSha: string; runnerSha256: string; publicDatabase: string;
}): Record<string, unknown> {
  private17ProofTag(expected.sourceSha, expected.installedImage);
  if (!IMMUTABLE_IMAGE_REF.test(expected.pgImage) || !SHA256.test(expected.runnerSha256)
    || !/^xpod_public16_[a-z0-9_]+$/.test(expected.publicDatabase)) throw new Error('private17 pair input mismatch');
  if (!SHA256.test(expected.admissionSha256)) throw new Error('private17 artifact authority is required');
  const bytes = private17Bytes(file);
  if (byteDigest(bytes) !== expected.admissionSha256) throw new Error('private17 artifact authority mismatch');
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('private17 JSON rejected'); }
  const proof = strictObject(parsed, ['schemaVersion', 'kind', 'status', 'sourceSha', 'serviceImage', 'postgresImage',
    'runnerSHA256', 'fixtureSHA256', 'database', 'semantic', 'search', 'abi', 'producer', 'cleanup']);
  const semantic = strictObject(proof.semantic, ['completeCaseCount', 'expectedCaseSetSHA256', 'validatorVersion',
    'validatorSourceSHA256', 'contractSourceSHA256', 'canonicalDigest', 'failed', 'skipped', 'deniedRowsObserved']);
  const producer = strictObject(proof.producer, ['actualExit', 'signal', 'childCount', 'closedRawSHA256',
    'producerSourceSHA256', 'closedReceiptSHA256']);
  const cleanup = strictObject(proof.cleanup, ['databaseAbsent', 'ownedResourcesAbsent']);
  if (proof.schemaVersion !== 1 || proof.kind !== 'immutable-installed-component-admission' || proof.status !== 'ok'
    || proof.sourceSha !== expected.sourceSha || proof.serviceImage !== expected.installedImage
    || proof.postgresImage !== expected.pgImage || proof.runnerSHA256 !== expected.runnerSha256
    || proof.fixtureSHA256 !== PRIVATE_FIXTURE_SHA256 || proof.search !== 'verified' || proof.abi !== '1|true'
    || typeof proof.database !== 'string' || !/^xpod_private17_[a-z0-9_]{1,48}$/.test(proof.database)
    || proof.database === expected.publicDatabase || cleanup.databaseAbsent !== true || cleanup.ownedResourcesAbsent !== true
    || semantic.completeCaseCount !== 17 || semantic.expectedCaseSetSHA256 !== PRIVATE17_CASE_SET_SHA256
    || semantic.validatorVersion !== 'private17-canonical-digest-search-v1'
    || semantic.validatorSourceSHA256 !== PRIVATE17_VALIDATOR_SHA256 || semantic.contractSourceSHA256 !== PRIVATE17_CONTRACT_SHA256
    || typeof semantic.canonicalDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(semantic.canonicalDigest)
    || semantic.failed !== 0 || semantic.skipped !== 0 || semantic.deniedRowsObserved !== 0
    || producer.actualExit !== 0 || producer.signal !== null || typeof producer.childCount !== 'number'
    || !Number.isInteger(producer.childCount) || producer.childCount < 1 || producer.childCount > 64
    || !Array.isArray(producer.closedRawSHA256) || producer.closedRawSHA256.length !== producer.childCount
    || producer.closedRawSHA256.some(hash => typeof hash !== 'string' || !SHA256.test(hash))
    || producer.producerSourceSHA256 !== PRIVATE17_PRODUCER_SHA256
    || typeof producer.closedReceiptSHA256 !== 'string' || !SHA256.test(producer.closedReceiptSHA256)) {
    throw new Error('private17 closed exact-pair admission mismatch');
  }
  return { status: 'ok', evidenceBoundary: 'immutable-installed-component', fixtureSHA256: PRIVATE_FIXTURE_SHA256,
    sourceSha: expected.sourceSha, installedImage: expected.installedImage, pgImage: expected.pgImage,
    runnerSha256: expected.runnerSha256, database: proof.database, canonicalDigest: semantic.canonicalDigest,
    admissionSha256: expected.admissionSha256 };
}

async function waitForPg17(container: string, database: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: DOCKER_PROBE_TIMEOUT_MS,
    });
    if (ready.status === 0) {
      runStep('create isolated database', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres',
        '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${database}`], { scanProductLogs: false });
      runStep('install native extensions', ['exec', container, 'psql', '-U', 'postgres', '-d', database,
        '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS xpod_rdf; CREATE EXTENSION IF NOT EXISTS xpod_qlever;'],
      { scanProductLogs: false });
      const capability = JSON.parse(runStep('native ABI readiness', ['exec', container, 'psql', '-U', 'postgres',
        '-d', database, '-Atc', "SELECT json_build_object('version', current_setting('server_version_num')::int, 'extensions', (SELECT array_agg(extname ORDER BY extname) FROM pg_extension WHERE extname IN ('vector','xpod_rdf','xpod_qlever')), 'native', xpod_rdf.native_sparql_capabilities())"],
      { scanProductLogs: false })) as { version: number; extensions: string[]; native: { abiVersion: number; ready: boolean } };
      if (capability.version < 170000 || capability.version >= 180000
        || !isDeepStrictEqual(capability.extensions, ['vector', 'xpod_qlever', 'xpod_rdf'])
        || capability.native.abiVersion !== 1 || capability.native.ready !== true) throw new Error('native ABI readiness mismatch');
      return;
    }
    await Bun.sleep(1_000);
  }
  throw new Error('PG17 QLever image did not become native-ready within 120 seconds');
}

async function main(): Promise<void> {
  const args = readArgs();
  mkdirSync(args.artifactDir, { recursive: true, mode: 0o700 });
  const fixtureSHA256 = createHash('sha256').update(readFileSync(args.fixturePath)).digest('hex');
  if (fixtureSHA256 !== PUBLIC_FIXTURE_SHA256) throw new Error('public fixture source hash mismatch');
  const fixture = createRequire(path.resolve('package.json'))(args.fixturePath) as SemanticFixtureModule;
  if (fixture.REQUIRED_CASES.length !== 16 || fixture.semanticConformanceCases.length !== 16) throw new Error('public fixture case contract mismatch');
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const network = `xpod-qlever-conformance-${suffix}`;
  const pgContainer = `xpod-qlever-pg-${suffix}`;
  const sqliteContainer = `xpod-qlever-local-conformance-${suffix}`;
  const cloudContainer = `xpod-qlever-cloud-conformance-${suffix}`;
  const database = `xpod_public16_${suffix.replaceAll('-', '_')}`;
  const sqliteArtifact = path.join(args.artifactDir, 'sqlite-installed-conformance.json');
  const pgArtifact = path.join(args.artifactDir, 'pg-installed-conformance.json');
  if ([sqliteArtifact, pgArtifact, path.join(args.artifactDir, 'installed-image-conformance.json')].some(existsSync)) {
    throw new Error('refusing stale conformance artifacts');
  }
  const ownerNonce = randomUUID();
  const ownershipLabel = `xpod.undefineds.co/conformance-owner=${ownerNonce}`;
  const ownedResources: { kind: 'container' | 'network'; name: string; id: string }[] = [];
  const creationAttempts: { kind: 'container' | 'network'; name: string }[] = [];
  let networkID = '';
  let primary: unknown;
  let evidence: unknown;
  const createOwnedResource = (kind: 'container' | 'network', name: string, dockerArgs: string[]): string => {
    creationAttempts.push({ kind, name });
    const command = kind === 'network'
      ? ['network', 'create', '--label', ownershipLabel, name]
      : ['create', '--name', name, '--network', networkID, '--label', ownershipLabel, ...dockerArgs];
    const id = runStep(`create conformance ${kind}`, command, { scanProductLogs: false });
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker create returned no immutable resource ID');
    ownedResources.push({ kind, name, id });
    return id;
  };
  const discoverOwnedAttempt = (kind: 'container' | 'network', name: string): void => {
    const probe = spawnSync('docker', kind === 'network' ? ['network', 'inspect', name] : ['inspect', '--type', 'container', name],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: DOCKER_PROBE_TIMEOUT_MS });
    if (probe.error || probe.signal) throw new Error('Docker ownership probe failed');
    if (probe.status !== 0) {
      const list = [kind, 'ls', '-q', '--no-trunc', '--filter',
        kind === 'network' ? `name=^${name}$` : `name=^/${name}$`];
      if (kind === 'container') list.splice(2, 0, '-a');
      const remaining = runStep('check attempted resource absent', list, { scanProductLogs: false });
      if (remaining) throw new Error('Docker attempted resource ownership is unverifiable');
      return;
    }
    const objects = JSON.parse(probe.stdout) as { Id: string; Name: string; Labels?: Record<string, string>; Config?: { Labels?: Record<string, string> } }[];
    if (objects.length !== 1) throw new Error('Docker ownership inspection is invalid');
    const object = objects[0];
    const labels = kind === 'network' ? object.Labels : object.Config?.Labels;
    if (labels?.['xpod.undefineds.co/conformance-owner'] !== ownerNonce) return; // Foreign create refusal.
    if (object.Name !== (kind === 'network' ? name : `/${name}`) || !/^[a-f0-9]{64}$/.test(object.Id)) {
      throw new Error('Docker attempted resource identity mismatch');
    }
    ownedResources.push({ kind, name, id: object.Id });
  };
  const runInstalledProduct = (backend: 'sqlite' | 'pg', artifact: string, container: string): void => {
    const dockerArgs = [
      '--mount', `type=bind,src=${args.fixturePath},dst=/fixtures/qlever-semantic-conformance.cjs,readonly`,
      '--mount', `type=bind,src=${args.artifactDir},dst=/artifacts`,
      '-e', `XPOD_QLEVER_CONFORMANCE_BACKEND=${backend}`,
      '-e', 'XPOD_QLEVER_SEMANTIC_FIXTURE_PATH=/fixtures/qlever-semantic-conformance.cjs',
      '-e', `XPOD_QLEVER_CONFORMANCE_ARTIFACT_PATH=/artifacts/${path.basename(artifact)}`,
      '-e', `XPOD_QLEVER_CONFORMANCE_TIMEOUT_MS=${args.timeoutMs}`,
    ];
    if (backend === 'pg') dockerArgs.push('-e', `XPOD_QLEVER_PG_DSN=postgres://postgres:xpod@qlever-pg:5432/${database}`);
    const id = createOwnedResource('container', container, [...dockerArgs, args.installedImage, 'bun', RUNNER_PATH]);
    runStep(`installed Xpod ${backend} conformance`, ['start', '--attach', id], { timeoutMs: args.timeoutMs });
  };
  try {
    validateImageInspection(runStep('inspect installed Xpod image', ['image', 'inspect', args.installedImage],
      { scanProductLogs: false }), args.installedImage, { sha: args.sourceSha, url: args.sourceUrl });
    validateImageInspection(runStep('inspect PG17 QLever image', ['image', 'inspect', args.pgImage],
      { scanProductLogs: false }), args.pgImage);
    networkID = createOwnedResource('network', network, []);
    const probe = `xpod-qlever-runner-${suffix}`;
    const probeID = createOwnedResource('container', probe, [args.installedImage, 'bun', '-e',
      `const {createHash}=require('node:crypto');const {readFileSync}=require('node:fs');if(createHash('sha256').update(readFileSync('${RUNNER_PATH}')).digest('hex')!=='${args.runnerSha256}')process.exit(41);`]);
    runStep('compiled runner source hash', ['start', '--attach', probeID]);
    runInstalledProduct('sqlite', sqliteArtifact, sqliteContainer);
    const pgID = createOwnedResource('container', pgContainer, ['--network-alias', 'qlever-pg', '-e', 'POSTGRES_PASSWORD=xpod', args.pgImage]);
    runStep('start PG17 QLever image', ['start', pgID], { scanProductLogs: false });
    await waitForPg17(pgID, database);
    runInstalledProduct('pg', pgArtifact, cloudContainer);
    const pgLogs = runStep('read PG17 QLever logs', ['logs', pgID], { scanProductLogs: false });
    if (FORBIDDEN_PRODUCT_LOG.test(pgLogs)) throw new Error('forbidden PG product fallback');
    const local = JSON.parse(readFileSync(sqliteArtifact, 'utf8')) as InstalledReport;
    const cloud = JSON.parse(readFileSync(pgArtifact, 'utf8')) as InstalledReport;
    validateInstalledReport(local, 'sqlite', fixture);
    validateInstalledReport(cloud, 'pg', fixture);
    const semanticParity = assertSemanticConformanceParity(local.semantic, cloud.semantic);
    if (!isDeepStrictEqual(local.search, cloud.search)) throw new Error('Local/Cloud native search mismatch');
    evidence = { schemaVersion: 1, status: 'ok', installedImage: args.installedImage, pgImage: args.pgImage,
      sourceSha: args.sourceSha, sourceUrl: args.sourceUrl, runnerSha256: args.runnerSha256,
      fixtureSHA256, database, nativeAbiVersion: 1, semanticParity, search: local.search,
      artifacts: { sqlite: sqliteArtifact, pg: pgArtifact } };
  } catch (error) {
    primary = error;
  } finally {
    const cleanupFailures: string[] = [];
    for (const attempt of creationAttempts) {
      if (ownedResources.some(resource => resource.kind === attempt.kind && resource.name === attempt.name)) continue;
      try { discoverOwnedAttempt(attempt.kind, attempt.name); }
      catch { cleanupFailures.push('ownership-probe'); }
    }
    for (const resource of ownedResources.reverse()) {
      try {
        const list = [resource.kind, 'ls', '-q', '--no-trunc', '--filter', `id=${resource.id}`];
        if (resource.kind === 'container') list.splice(2, 0, '-a');
        const remaining = runStep('inspect owned immutable ID', list, { scanProductLogs: false });
        if (!remaining) continue; // A foreign same-name replacement cannot inherit this ID.
        if (remaining !== resource.id) throw new Error('Docker returned a different resource ID');
        runStep('remove owned immutable ID', resource.kind === 'network'
          ? ['network', 'rm', resource.id] : ['rm', '-f', resource.id], { scanProductLogs: false });
        if (runStep('confirm owned immutable ID absent', list, { scanProductLogs: false })) throw new Error('owned resource remains');
      } catch { cleanupFailures.push(resource.kind); }
    }
    if (cleanupFailures.length) {
      process.stderr.write(`${JSON.stringify({ stage: 'cleanup', errorClass: 'owned-resource-cleanup-failed' })}\n`);
      if (!primary) primary = new StepError('cleanup', 70, 'owned-resource-cleanup-failed');
    }
  }
  if (primary) throw primary;
  writeFileSync(path.join(args.artifactDir, 'installed-image-conformance.json'), `${JSON.stringify({
    ...(evidence as Record<string, unknown>), ownedCleanup: 'verified-absent', admissionScope: 'public16-only',
  }, null, 2)}\n`, { mode: 0o600 });
}

async function cli(): Promise<void> {
  if (argValue('--install-registry-config')) {
    const existing = argValue('--existing-docker-config');
    installRegistryConfig(readFileSync(0, 'utf8'), existing && existsSync(existing) ? readFileSync(existing, 'utf8') : '{}',
      required('registry-output', argValue('--install-registry-config')));
    process.stdout.write(`${JSON.stringify({ stage: 'registry-config', errorClass: 'none' })}\n`);
  } else if (argValue('--acquire-private17-admission')) {
    acquirePrivate17Admission(required('private17-output', argValue('--acquire-private17-admission')), {
      sourceSha: required('source-sha', argValue('--source-sha')),
      installedImage: required('installed-image', argValue('--installed-image')),
      admissionSha256: required('private17-artifact-authority', argValue('--admission-sha256')),
    });
  } else if (argValue('--verify-private17-admission')) {
    const publicEvidence = JSON.parse(readFileSync(required('public16-report', argValue('--public16-report')), 'utf8'));
    if (publicEvidence.schemaVersion !== 1 || publicEvidence.status !== 'ok'
      || publicEvidence.admissionScope !== 'public16-only' || publicEvidence.ownedCleanup !== 'verified-absent'
      || publicEvidence.sourceSha !== argValue('--source-sha')
      || publicEvidence.installedImage !== argValue('--installed-image')
      || publicEvidence.pgImage !== argValue('--pg-image')
      || publicEvidence.runnerSha256 !== argValue('--runner-sha256')
      || publicEvidence.fixtureSHA256 !== PUBLIC_FIXTURE_SHA256 || publicEvidence.nativeAbiVersion !== 1) {
      throw new StepError('private17-public-binding', 1, 'public16-binding-mismatch');
    }
    const result = verifyPrivate17Admission(required('private17-file', argValue('--verify-private17-admission')), {
      admissionSha256: required('private17-artifact-authority', argValue('--admission-sha256')),
      installedImage: required('installed-image', argValue('--installed-image')),
      pgImage: required('pg-image', argValue('--pg-image')),
      sourceSha: required('source-sha', argValue('--source-sha')),
      runnerSha256: required('runner-sha256', argValue('--runner-sha256')),
      publicDatabase: required('public-database', publicEvidence.database),
    });
    writeFileSync(required('private17-receipt', argValue('--private17-receipt')), `${JSON.stringify(result)}\n`, { mode: 0o600, flag: 'wx' });
  } else if (argValue('--select-registry-authority')) {
    const workload = JSON.parse(readFileSync(required('pg-workload', argValue('--select-registry-authority')), 'utf8')) as AuthorityWorkload;
    process.stdout.write(`${selectRegistryAuthority(workload,
      requireImmutableImage('pg-image', required('pg-image', argValue('--pg-image'))))}\n`);
  } else if (argValue('--validate-pull-job')) {
    const job = JSON.parse(readFileSync(required('job', argValue('--validate-pull-job')), 'utf8')) as PullJob;
    const pods = JSON.parse(readFileSync(required('pods', argValue('--pods')), 'utf8')) as { items: PullPod[] };
    const validated = validatePullJob(job, pods.items, {
      name: required('job-name', argValue('--job-name')), namespace: required('namespace', argValue('--namespace')),
      uid: required('job-uid', argValue('--job-uid')), image: requireImmutableImage('pg-image', required('pg-image', argValue('--pg-image'))),
      authorityName: required('authority-name', argValue('--authority-name')),
    });
    writeFileSync(required('pull-receipt', argValue('--pull-receipt')), `${JSON.stringify({
      schemaVersion: 1, status: 'ok', ...validated,
    })}\n`, { mode: 0o600, flag: 'wx' });
  } else {
    await main();
  }
}

if (require.main === module) cli().catch((error) => {
  process.stderr.write(`${error instanceof StepError ? error.message : JSON.stringify({ stage: 'conformance', errorClass: 'contract-failed' })}\n`);
  process.exitCode = error instanceof StepError ? error.exitStatus : 1;
});
