import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { acquireIndependentProductInput, type ArtifactAcquisitionInput } from './acquire-independent-product-input';
import { projectApiProductInput } from './project-api-product-input';
import { projectCssProductInput } from './project-css-product-input';
import { projectCliPublicationInput } from './project-cli-publication-input';

interface Budget { estimatedPeakBytes: number; remainingFloorBytes: number; cushionBytes: number }
export interface ModuleConsumerRequest {
  schemaVersion: 1; module: 'css' | 'api'; sourceSha: string;
  product: ArtifactAcquisitionInput; cli: ArtifactAcquisitionInput;
  budget: Budget; timeoutSeconds?: number;
}
export interface ModuleConsumerLocalInput extends ModuleConsumerRequest {
  checkout: string; sourceRoots: string[]; node: string; bun: string;
  temporaryParent: string; output: string;
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new Error('Module consumer plan: ' + message); }
function keys(value: any, required: string[], optional: string[] = []) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'object required');
  requireValue(required.every(k => Object.prototype.hasOwnProperty.call(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)), 'unexpected or missing keys');
}
/** Pure pre-check for untrusted manual JSON. Local paths are added separately by CI. */
export function validateModuleConsumerRequest(value: unknown): ModuleConsumerRequest {
  const input = value as ModuleConsumerRequest;
  keys(input, ['schemaVersion', 'module', 'sourceSha', 'product', 'cli', 'budget'], ['timeoutSeconds']);
  requireValue(input.schemaVersion === 1 && ['css', 'api'].includes(input.module) && typeof input.sourceSha === 'string' && /^[a-f0-9]{40}$/u.test(input.sourceSha), 'supported module and source identity required');
  for (const tuple of [input.product, input.cli]) {
    keys(tuple, ['schemaVersion', 'sourceSha', 'runHeadSha', 'runId', 'runAttempt', 'artifactId', 'artifactSha256']);
    requireValue(tuple.schemaVersion === 1 && tuple.sourceSha === input.sourceSha && typeof tuple.runHeadSha === 'string' && typeof tuple.artifactSha256 === 'string' && /^[a-f0-9]{40}$/u.test(tuple.runHeadSha)
      && /^[a-f0-9]{64}$/u.test(tuple.artifactSha256), 'exact same actual source and artifact digests required');
    requireValue([tuple.runId, tuple.runAttempt, tuple.artifactId].every(n => Number.isSafeInteger(n) && n > 0), 'positive exact run/attempt/artifact required');
  }
  keys(input.budget, ['estimatedPeakBytes', 'remainingFloorBytes', 'cushionBytes']);
  requireValue(Object.values(input.budget).every(n => Number.isSafeInteger(n) && n > 0)
    && input.budget.remainingFloorBytes >= 1024 ** 3 && input.budget.cushionBytes >= 128 * 1024 ** 2, 'resource budget below floor');
  requireValue(input.timeoutSeconds === undefined || (Number.isInteger(input.timeoutSeconds) && input.timeoutSeconds >= 1 && input.timeoutSeconds <= 600), 'timeout out of range');
  return input;
}
function original(file: string) {
  const stat = lstatSync(file);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 20 * 1024 ** 2, 'bounded regular receipt required');
  const bytes = readFileSync(file); return { path: file, sha256: sha(bytes) };
}
async function archive(directory: string, row: any, expected: string) {
  requireValue(row?.path === expected && Number.isSafeInteger(row.bytes) && row.bytes > 0 && typeof row.sha256 === 'string' && typeof row.integrity === 'string' && /^[a-f0-9]{64}$/u.test(row.sha256) && /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(row.integrity), 'archive reference invalid');
  const file = path.join(directory, expected), stat = lstatSync(file);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size === row.bytes, 'archive size/type mismatch');
  const h256 = createHash('sha256'), h512 = createHash('sha512');
  for await (const chunk of createReadStream(file)) { h256.update(chunk); h512.update(chunk); }
  requireValue(h256.digest('hex') === row.sha256 && 'sha512-' + h512.digest('base64') === row.integrity, 'archive digest mismatch');
  return { path: file, sha256: row.sha256, integrity: row.integrity };
}
// Dependency injection only replaces transport/project operations for tiny contract fixtures.
export async function prepareModuleConsumerPlan(input: ModuleConsumerLocalInput, planFile: string, dependencies = {
  acquire: acquireIndependentProductInput, projectCss: projectCssProductInput, projectApi: projectApiProductInput, projectCli: projectCliPublicationInput,
}) {
  const { checkout, sourceRoots, node, bun, temporaryParent, output, ...request } = input;
  validateModuleConsumerRequest(request);
  requireValue([checkout, node, bun, temporaryParent, output, planFile].every(p => typeof p === 'string' && path.isAbsolute(p)), 'absolute trusted local paths required');
  requireValue(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === request.sourceSha
    && execFileSync('git', ['-C', checkout, 'status', '--porcelain'], { encoding: 'utf8' }).trim() === '', 'clean actual source checkout required');
  const parent = realpathSync(temporaryParent);
  requireValue(parent === temporaryParent && lstatSync(parent).isDirectory() && (lstatSync(parent).mode & 0o077) === 0, 'private canonical temporary parent required');
  requireValue(Array.isArray(sourceRoots) && sourceRoots.length > 0 && sourceRoots.every(p => path.isAbsolute(p)), 'source roots required');
  const roots = sourceRoots.map(p => realpathSync(p));
  const within = (a: string, b: string) => a === b || a.startsWith(b + path.sep);
  requireValue(roots.some(r => within(realpathSync(checkout), r)) && roots.every(r => !within(parent, r) && !within(r, parent)), 'temporary parent must be outside denied sources');
  requireValue(path.dirname(output) === parent && path.dirname(planFile) === parent && output !== planFile, 'outputs must be direct children of temporary parent');
  const projected: any[] = [];
  for (const [kind, tuple] of [['product', request.product], ['cli', request.cli]] as const) {
    const acquired = path.join(parent, 'acquisition-' + kind), destination = path.join(parent, 'projection-' + kind);
    await dependencies.acquire(tuple, acquired, { token: process.env.GH_TOKEN });
    const custody = original(path.join(acquired, 'receipt.json'));
    const binding = { schemaVersion: 1 as const, acquisitionRoot: acquired, custodyReceiptSha256: custody.sha256 };
    const receipt: any = kind === 'product'
      ? await (request.module === 'css' ? dependencies.projectCss : dependencies.projectApi)({ ...binding, members: { producer: 'producer.receipt.json', archive: 'product.tgz', packRaw: 'evidence/pack.raw.log' } }, destination)
      : await dependencies.projectCli(binding, destination);
    requireValue(receipt.sourceSha === request.sourceSha && receipt.runId === (kind === 'product' ? tuple.runId : String(tuple.runId)) && receipt.runAttempt === (kind === 'product' ? tuple.runAttempt : String(tuple.runAttempt))
      && (kind === 'product' ? receipt.runHeadSha : receipt.eventHeadSha) === tuple.runHeadSha, 'projection source/attempt differs from request');
    const ref = original(path.join(destination, 'projection.receipt.json'));
    requireValue(JSON.stringify(JSON.parse(readFileSync(ref.path, 'utf8'))) === JSON.stringify(receipt), 'saved projection differs from returned receipt');
    projected.push({ directory: destination, receipt, ref });
  }
  const [product, cli] = projected;
  let productArchive = product.receipt.archive;
  if (request.module === 'api') {
    const linked = (reference: any) => {
      requireValue(reference && typeof reference.path === 'string' && path.basename(reference.path) === reference.path
        && typeof reference.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(reference.sha256), 'safe hash-bound API reference required');
      const file = path.join(product.directory, reference.path), actual = original(file);
      requireValue(actual.sha256 === reference.sha256 && (reference.bytes === undefined || lstatSync(file).size === reference.bytes), 'API original reference mismatch');
      return JSON.parse(readFileSync(file, 'utf8'));
    };
    const producer = linked(product.receipt.producerReceipt), collector = linked(product.receipt.collectorInput);
    requireValue(producer.schemaVersion === 1 && producer.kind === 'api-module-product-production'
      && producer.context?.actualCheckoutSha === request.sourceSha && producer.context?.target === 'darwin-arm64'
      && typeof producer.context?.version === 'string' && producer.context.version.length > 0
      && collector.schemaVersion === 1 && collector.expectedSourceSha === request.sourceSha
      && collector.archive?.path === 'product.tgz' && collector.archive.sha256 === producer.archive?.sha256,
      'API producer/collector source and archive binding mismatch');
    productArchive = producer.archive;
  }
  const plan = { schemaVersion: 1, sourceSha: request.sourceSha, checkout, sourceRoots, node, bun, temporaryParent: parent, output,
    budget: request.budget, timeoutSeconds: request.timeoutSeconds ?? 180,
    [request.module + 'Receipt']: product.ref, cliReceipt: cli.ref,
    [request.module + 'Archive']: await archive(product.directory, productArchive, 'product.tgz'),
    cliArchive: await archive(cli.directory, cli.receipt.products.cli.archive, 'cli.tgz'),
    clientArchive: await archive(cli.directory, cli.receipt.products.client.archive, 'client.tgz') };
  writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return plan;
}
if (import.meta.main) {
  try {
    requireValue(process.argv.length === 4, 'input JSON and new plan file required');
    await prepareModuleConsumerPlan(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv[3]);
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
