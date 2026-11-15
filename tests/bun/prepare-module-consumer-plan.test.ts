import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { productTargets } from '../../scripts/module-product-targets';
import { prepareModuleConsumerPlan, validateModuleConsumerRequest } from '../../scripts/prepare-module-consumer-plan';
mkdirSync(path.resolve('.test-data'), { recursive: true });
const root = mkdtempSync(path.resolve('.test-data/module-consumer-plan-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const checkout = path.join(root, 'source'); mkdirSync(checkout);
execFileSync('git', ['init', '-q', checkout]);
writeFileSync(path.join(checkout, 'package.json'), '{}');
execFileSync('git', ['-C', checkout, 'add', 'package.json']);
execFileSync('git', ['-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
const sourceSha = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tuple = { schemaVersion: 1, sourceSha, runHeadSha: 'b'.repeat(40), runId: 1, runAttempt: 2, artifactId: 3, artifactSha256: 'c'.repeat(64) };
const request = () => ({ schemaVersion: 1 as const, module: 'css' as const, target: 'darwin-arm64', sourceSha, product: { ...tuple, schemaVersion: 1 as const }, cli: { ...tuple, schemaVersion: 1 as const }, budget: { estimatedPeakBytes: 1, remainingFloorBytes: 1024 ** 3, cushionBytes: 128 * 1024 ** 2 } });
const digest = (b: Buffer, algorithm: string, encoding: 'hex' | 'base64') => createHash(algorithm).update(b).digest(encoding);
function fixture(mode = '', module: 'css' | 'api' = 'css', target = 'darwin-arm64') {
  const temporaryParent = mkdtempSync(path.join(root, 'private-'));
  const input = { ...request(), module, target, checkout, sourceRoots: [checkout], node: process.execPath, bun: process.execPath, temporaryParent, output: path.join(temporaryParent, 'consumer-results') };
  const planFile = path.join(temporaryParent, 'plan.json'); let acquisitions = 0;
  const project = async (_binding: any, output: string) => {
    mkdirSync(output);
    const row = (name: string) => {
      const bytes = Buffer.from(name); writeFileSync(path.join(output, name), bytes);
      return { path: name, bytes: bytes.length, sha256: digest(bytes, 'sha256', 'hex'), integrity: 'sha512-' + digest(bytes, 'sha512', 'base64') };
    };
    const css = output.endsWith('product');
    const receipt: any = { sourceSha, runId: css ? 1 : '1', runAttempt: css ? 2 : '2', ...(css ? { runHeadSha: tuple.runHeadSha, archive: row('product.tgz') } : { eventHeadSha: tuple.runHeadSha, products: { cli: { archive: row('cli.tgz') }, client: { archive: row('client.tgz') } } }) };
    if (css && module === 'css') receipt.package = { name: '@undefineds.co/xpod-css-' + input.target, target: mode === 'producer-target' ? 'unsupported-target' : input.target, version: '0.0.1-preview.1' };
    if (css && module === 'api') {
      const document = (name: string, value: any) => {
        const bytes = Buffer.from(JSON.stringify(value)); writeFileSync(path.join(output, name), bytes);
        return { path: name, sha256: digest(bytes, 'sha256', 'hex'), bytes: bytes.length };
      };
      const archive = receipt.archive; delete receipt.archive;
      receipt.producerReceipt = document('producer.receipt.json', { schemaVersion: 1, kind: 'api-module-product-production',
        context: { actualCheckoutSha: sourceSha, target: mode === 'producer-target' ? 'unsupported-target' : input.target, version: '0.0.1-preview.1' }, archive });
      receipt.collectorInput = document('collector-input.json', { schemaVersion: 1,
        expectedSourceSha: mode === 'collector-source' ? 'd'.repeat(40) : sourceSha,
        archive: { path: 'product.tgz', sha256: mode === 'collector-archive' ? 'd'.repeat(64) : archive.sha256 } });
      if (mode === 'producer-hash') writeFileSync(path.join(output, 'producer.receipt.json'), '{}');
      if (mode === 'unsafe-ref') receipt.producerReceipt.path = '../producer.receipt.json';
    }
    writeFileSync(path.join(output, 'projection.receipt.json'), JSON.stringify(receipt));
    if (mode === 'noncanonical' && !css) receipt.runId = '01';
    if (mode === 'attempt') receipt.runAttempt = 99;
    if (mode === 'saved') receipt.extra = 'changed after save';
    if (mode === 'receipt') receipt.sourceSha = 'd'.repeat(40);
    if (mode === 'archive' && css) writeFileSync(path.join(output, 'product.tgz'), 'changed.tgz');
    return receipt;
  };
  const dependencies: any = { acquire: async (_tuple: any, output: string) => { acquisitions++; mkdirSync(output); writeFileSync(path.join(output, 'receipt.json'), '{}'); }, projectCss: project, projectApi: project, projectCli: project };
  return { input, planFile, dependencies, acquired: () => acquisitions };
}
describe('manual consumer plan', () => {
  test('rejects cross-source and user paths before transport', () => {
    const input = request(); input.cli.sourceSha = 'd'.repeat(40);
    expect(() => validateModuleConsumerRequest(input)).toThrow('same actual source');
    expect(() => validateModuleConsumerRequest({ ...request(), node: '/user/command' })).toThrow('keys');
    expect(() => validateModuleConsumerRequest({ ...request(), product: { ...tuple, runAttempt: 0 } })).toThrow('positive');
  });
  test('emits existing CSS driver shape with exact hash bindings', async () => {
    const f = fixture(); const plan = await prepareModuleConsumerPlan(f.input, f.planFile, f.dependencies);
    expect(f.acquired()).toBe(2); expect(plan.cssArchive.path.endsWith('/projection-product/product.tgz')).toBe(true);
    expect(plan.cssReceipt.sha256).toBe(digest(readFileSync(plan.cssReceipt.path), 'sha256', 'hex'));
    expect(JSON.parse(readFileSync(f.planFile, 'utf8'))).toEqual(plan);
    expect('published' in plan).toBe(false);
  });
  for (const mode of ['receipt', 'archive', 'attempt', 'saved', 'noncanonical']) test('rejects ' + mode + ' drift without writing plan', async () => {
    const f = fixture(mode); await expect(prepareModuleConsumerPlan(f.input, f.planFile, f.dependencies)).rejects.toThrow();
    expect(() => readFileSync(f.planFile)).toThrow();
  });
  test('API derives archive only from hash-bound producer with collector binding', async () => {
    const f = fixture('', 'api'); const plan = await prepareModuleConsumerPlan(f.input, f.planFile, f.dependencies);
    expect(f.acquired()).toBe(2); expect('cssReceipt' in plan).toBe(false); expect('cssArchive' in plan).toBe(false);
    expect(plan.apiArchive.path.endsWith('/projection-product/product.tgz')).toBe(true);
    expect(plan.apiReceipt.sha256).toBe(digest(readFileSync(plan.apiReceipt.path), 'sha256', 'hex'));
    expect(JSON.parse(readFileSync(plan.apiReceipt.path, 'utf8')).archive).toBeUndefined();
  });
  for (const row of productTargets('api')) test('API plan preserves explicit central target ' + row.target, async () => {
    const f = fixture('', 'api', row.target); const plan = await prepareModuleConsumerPlan(f.input, f.planFile, f.dependencies);
    expect(plan.target).toBe(row.target);
    expect(JSON.parse(readFileSync(f.planFile, 'utf8')).target).toBe(row.target);
    const wrong = fixture('producer-target', 'api', row.target);
    await expect(prepareModuleConsumerPlan(wrong.input, wrong.planFile, wrong.dependencies)).rejects.toThrow('producer/collector');
  });
  for (const mode of ['collector-source', 'collector-archive', 'producer-hash', 'unsafe-ref']) test('rejects API ' + mode, async () => {
    const f = fixture(mode, 'api'); await expect(prepareModuleConsumerPlan(f.input, f.planFile, f.dependencies)).rejects.toThrow();
    expect(() => readFileSync(f.planFile)).toThrow();
  });
  test('wrong checkout rejected before acquisition', async () => {
    const f = fixture(); f.input.sourceSha = 'd'.repeat(40); f.input.product.sourceSha = f.input.sourceSha; f.input.cli.sourceSha = f.input.sourceSha;
    await expect(prepareModuleConsumerPlan(f.input, f.planFile, f.dependencies)).rejects.toThrow('checkout'); expect(f.acquired()).toBe(0);
  });
});
