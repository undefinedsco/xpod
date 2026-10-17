import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exactVersion } from '../independent-release-plan';
import { assertNewAcquisitionOutput, verifyAcquiredMetadata } from '../acquire-independent-product-input';
const { withOwnedTempRoot } = createRequire(import.meta.url)('./owned-temp-root.cjs');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface ProductCustodyInput { acquisitionRoot: string; custodyReceiptSha256: string }
interface ProjectionPolicy { workflowPath: string; materialRole: string; artifactNames(custody: any): string[] }
export interface ProjectionSession {
  root: string; custody: any; metadata: any; temporary: string;
  member(name: string, bound: number, minimum?: 0 | 1): any;
  project(selections: any[]): void;
  select(row: any, destination: string): any;
  writeOutput(receipt: any, extras?: Record<string, Buffer>): void;
}
function fail(message: string): never { throw new Error('Product projection: ' + message); }
export function productOriginal(file: string, expected?: string): Buffer {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 ** 2) fail('bounded regular original required');
  const bytes = readFileSync(file);
  if (expected && hash(bytes) !== expected) fail('original hash mismatch');
  return bytes;
}

/** Common producer claims only: transport comparison is not independent admission. */
export function assertPreviewProductContext(producer: any, custody: any, run: any, workflowPath: string, kind: string, expectedTarget = 'darwin-arm64'): any {
  const context = producer?.context;
  if (producer?.schemaVersion !== 1 || producer.kind !== kind || producer.status !== 'controlled-preview-materials'
    || !context || context.repository !== custody.repository || context.workflowPath !== workflowPath
    || typeof context.workflowRef !== 'string' || !context.workflowRef.startsWith(`${custody.repository}/${workflowPath}@`)
    || !/^[a-f0-9]{40}$/u.test(context.workflowSha) || context.runId !== custody.runId || context.runAttempt !== custody.runAttempt
    || context.runHeadSha !== custody.runHeadSha || context.event !== run.event || context.actualCheckoutSha !== custody.expectedSourceSha
    || context.githubSha !== context.actualCheckoutSha || context.target !== expectedTarget || !exactVersion(context.version)
    || producer.sourceBefore?.sha !== context.actualCheckoutSha || producer.sourceAfter?.sha !== context.actualCheckoutSha
    || producer.sourceBefore.status !== '' || producer.sourceAfter.status !== ''
    || producer.published !== false || producer.releaseQualified !== false || producer.consumerValidated !== false
    || producer.legalClearance !== false || producer.nativeAdmission !== false) fail('producer context/source/preview binding mismatch');
  return context;
}

export async function withProductProjection<T>(input: ProductCustodyInput, output: string, policy: ProjectionPolicy, operation: (session: ProjectionSession) => Promise<T>): Promise<T> {
  output = assertNewAcquisitionOutput(output);
  const root = path.resolve(input.acquisitionRoot);
  const custody = JSON.parse(productOriginal(path.join(root, 'receipt.json'), input.custodyReceiptSha256).toString());
  if (custody.schemaVersion !== 1 || custody.kind !== 'independent-product-artifact-acquisition' || custody.status !== 'blocked'
    || custody.repository !== 'undefinedsco/xpod' || custody.workflowPath !== policy.workflowPath
    || custody.materialRole !== policy.materialRole || custody.published !== false || custody.releaseQualified !== false
    || custody.archive?.path !== 'artifact.zip' || !/^[a-f0-9]{64}$/u.test(custody.archive.sha256)) fail('Product custody required; test/native artifacts cannot project');
  verifyAcquiredMetadata(root, custody.metadata);
  const metadata = JSON.parse(productOriginal(path.join(root, 'metadata.json')).toString());
  const { run, workflow, artifact } = metadata;
  if (run.id !== custody.runId || run.run_attempt !== custody.runAttempt || run.head_sha !== custody.runHeadSha
    || run.status !== 'completed' || run.conclusion !== 'success' || workflow.id !== run.workflow_id
    || workflow.path !== policy.workflowPath || run.path?.split('@')[0] !== policy.workflowPath
    || run.repository?.full_name !== custody.repository || run.head_repository?.full_name !== custody.repository
    || artifact.id !== custody.artifactId || artifact.expired !== false || artifact.workflow_run?.id !== run.id
    || artifact.workflow_run?.head_sha !== custody.runHeadSha || artifact.digest !== 'sha256:' + custody.archive.sha256
    || !policy.artifactNames(custody).includes(artifact.name)) fail('saved producer metadata mismatch');
  const registered = new Map<string, any>();
  const inventory = custody.inventory?.members;
  if (!Array.isArray(inventory)) fail('ZIP member inventory required');
  function member(name: string, bound: number, minimum: 0 | 1 = 1) {
    const selected = inventory.filter((row: any) => row.path === name);
    if (selected.length !== 1 || selected[0].kind !== 'file' || !Number.isSafeInteger(selected[0].bytes)
      || selected[0].bytes < minimum || selected[0].bytes > bound || !/^[a-f0-9]{64}$/u.test(selected[0].sha256)) fail('unique ordinary bounded member required: ' + name);
    registered.set(name, selected[0]);
    return selected[0];
  }
  const zipStat = lstatSync(path.join(root, 'artifact.zip'));
  if (!zipStat.isFile() || zipStat.isSymbolicLink() || zipStat.size !== custody.archive.bytes || zipStat.size !== artifact.size_in_bytes) fail('original ZIP size/type mismatch');
  return await withOwnedTempRoot('xpod-product-projection-', async (temporary: string) => {
    const projected = new Set<string>();
    function project(selections: any[]) {
      const result = spawnSync('python3', [path.join(import.meta.dir, 'inspect-product-artifact.py'), path.join(root, 'artifact.zip'), custody.archive.sha256,
        String(512 * 1024 ** 2), String(1024 ** 3), '50000', JSON.stringify(selections), temporary], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0 || result.error) fail('ZIP projection failed');
      const checked = JSON.parse(result.stdout);
      for (const row of selections) projected.add(row.destination);
      if (checked.selectedMembersProjected !== selections.length || checked.innerArchiveExpanded !== false) fail('ZIP projection facts mismatch');
      for (const row of registered.values()) {
        const actual = checked.members.filter((entry: any) => entry.path === row.path);
        if (actual.length !== 1 || actual[0].kind !== row.kind || actual[0].bytes !== row.bytes || actual[0].sha256 !== row.sha256) fail('ZIP inventory changed');
      }
    }
    const select = (row: any, destination: string) => ({ path: row.path, destination, bytes: row.bytes, sha256: row.sha256 });
    function writeOutput(receipt: any, extras: Record<string, Buffer> = {}): void {
      let owned = false;
      try {
        mkdirSync(output, { mode: 0o700 }); owned = true;
        for (const file of projected) renameSync(path.join(temporary, file), path.join(output, file));
        for (const [file, bytes] of Object.entries(extras)) {
          if (!/^[a-z0-9.-]+$/u.test(file) || projected.has(file) || file === 'projection.receipt.json') fail('invalid projection sidecar');
          writeFileSync(path.join(output, file), bytes, { flag: 'wx', mode: 0o400 });
        }
        writeFileSync(path.join(output, 'projection.receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
      } catch (error) {
        if (owned) {
          try { rmSync(output, { recursive: true, force: true }); }
          catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], 'Projection and cleanup failed'), { cause: error }); }
        }
        throw error;
      }
    }
    return await operation({ root, custody, metadata, temporary, member, project, select, writeOutput });
  });
}
