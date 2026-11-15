import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, openSync, closeSync, ftruncateSync, symlinkSync, linkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { collectProductConsumerOriginalInventory, consumerOriginalModule, scanProductConsumerOriginal } from '../../scripts/lib/independent-admission/product-consumer-original-inventory';
import { afsConsumerOriginalSelection } from '../../scripts/lib/independent-admission/afs-consumer-originals';
import { registryConsumerParentTimeout } from '../../scripts/run-independent-publication';
import { afsConsumerBudget } from '../../scripts/lib/afs-consumer-budget';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { productConsumerOriginalLimits } from '../../scripts/lib/independent-admission/product-consumer-limits';
const api = { package: '@undefineds.co/xpod-api-linux-x64', target: 'linux-x64', version: '1.0.0', sourceSha: 'a'.repeat(40), archiveSha256: 'b'.repeat(64), integrity: 'sha512-fixture', archiveBytes: 1 };
function fixture(run: (root: string) => void) {
  const parent = path.resolve('.test-data/consumer-original-inventory-tests'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-')); try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function sparse(file: string, bytes: number) { const fd = openSync(file, 'wx'); try { ftruncateSync(fd, bytes); } finally { closeSync(fd); } }
test('actual canonical product identity selects policy, never an AFS approval flag', () => {
  expect(consumerOriginalModule({ ...api, afs: true } as never)).toBe('api');
  expect(consumerOriginalModule({ package: '@undefineds.co/xpod-afs-darwin-arm64', target: 'darwin-arm64' })).toBe('afs');
  expect(() => consumerOriginalModule({ package: api.package, target: 'darwin-arm64' })).toThrow('canonical actual product');
});
test('same-descriptor scan hashes complete multi-chunk bytes without a whole-file capture', () => fixture(root => {
  const body = Buffer.alloc(3 * 65536 + 7, 17), file = path.join(root, 'raw.log'); writeFileSync(file, body);
  const observed = scanProductConsumerOriginal(file, productConsumerOriginalLimits('api').smallMemberBytes);
  expect(observed.bytes).toBe(body.length); expect(observed.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  expect(observed.body).toBe(undefined);
}));
test('regular API originals keep the small budget and exclude private directories before recursion', () => fixture(root => {
  writeFileSync(path.join(root, 'result.json'), '{}'); mkdirSync(path.join(root, '.private-originals'));
  sparse(path.join(root, '.private-originals', 'credentials.bin'), 32 * 1024 ** 2);
  const observed = collectProductConsumerOriginalInventory(root, api);
  expect(observed.originals.map(row => row.path)).toEqual(['result.json']);
  expect(observed.totalBytes).toBe(2); expect(observed.manifestBytes).toBe(productConsumerOriginalLimits('api').manifestBytes);
}));
test('links, oversized ordinary files and complete inventory overflow fail before heavy reads', () => fixture(root => {
  const file = path.join(root, 'a'); writeFileSync(file, 'a'); symlinkSync(file, path.join(root, 'b'));
  expect(() => collectProductConsumerOriginalInventory(root, api)).toThrow('regular original'); rmSync(path.join(root, 'b'));
  linkSync(file, path.join(root, 'c')); expect(() => collectProductConsumerOriginalInventory(root, api)).toThrow('fresh ordinary');
  rmSync(path.join(root, 'c')); rmSync(file);
  const limits = productConsumerOriginalLimits('api'); sparse(file, limits.smallMemberBytes + 1);
  expect(() => collectProductConsumerOriginalInventory(root, api)).toThrow('oversized original'); rmSync(file);
  for (let i = 0; i < 5; i++) sparse(path.join(root, String(i)), limits.smallMemberBytes);
  expect(() => collectProductConsumerOriginalInventory(root, api)).toThrow('complete original inventory budget');
}));
test('AFS remains closed until Source fixes the complete public projection, not a recursive scene upload', () => fixture(root => {
  mkdirSync(path.join(root, 'module-chain-random', 'auth'), { recursive: true });
  writeFileSync(path.join(root, 'module-chain-random', 'auth', 'credentials.json'), '{"private":"never export"}');
  expect(() => collectProductConsumerOriginalInventory(root, { ...api, package: '@undefineds.co/xpod-afs-linux-x64' })).toThrow();
}));


/** Only original transport is exercised. These synthetic records are not native
 * tools, closed process evidence or a consumer capability; no issuer is called. */
function publicTransportFixture(root: string, shardBytes = 17 * 1024 ** 2) {
  const product = { ...api, package: '@undefineds.co/xpod-afs-linux-x64' };
  const rows = new Map<string, any>();
  const put = (name: string, value: unknown) => {
    const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), body);
    const row = { path: name, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), mode: 0o644 }; rows.set(name, row); return row;
  };
  const shardName = 'verifier-tools/transport-fixture/source-0000.tar';
  mkdirSync(path.dirname(path.join(root, shardName)), { recursive: true }); sparse(path.join(root, shardName), shardBytes);
  const hash = createHash('sha256'), block = Buffer.alloc(65536);
  for (let offset = 0; offset < shardBytes; offset += block.length) hash.update(block.subarray(0, Math.min(block.length, shardBytes - offset)));
  const shard = { path: shardName, bytes: shardBytes, sha256: hash.digest('hex'), mode: 0o644 }; rows.set(shardName, shard);
  const master = put('verifier-tools/manifest-0001.json', { schemaVersion: 1, kind: 'fixed-afs-consumer-tool-originals', sourceSha: product.sourceSha,
    roots: [{ rootId: 'transport-fixture', domain: 'source', archives: [shard], inventories: [] }], observations: [] });
  put('result.json', { transport: 'production-npm-registry', records: [], verifierToolOriginals: master });
  for (const runtime of ['node', 'bun']) put(runtime + '-mounted/module-chain.safe.json', { children: [] });
  const readOriginal = (name: string, maximum: number) => { const row = rows.get(name); if (!row || row.bytes > maximum) throw Error('fixture metadata bound'); return readFileSync(path.join(root, name)); };
  let selection = afsConsumerOriginalSelection({ target: product.target, originals: [...rows.values()], readOriginal });
  for (const pending of selection.pending) if (pending.startsWith('afs-transport-original-missing:')) put(pending.slice('afs-transport-original-missing:'.length), '{}');
  selection = afsConsumerOriginalSelection({ target: product.target, originals: [...rows.values()], readOriginal });
  expect(selection.pending.length).toBe(0);
  put('consumer-public-original-selection.json', { schemaVersion: 1, kind: 'fixed-afs-consumer-public-original-selection', sourceSha: product.sourceSha, target: product.target, files: selection.files });
  put('consumer-observation.json', { identity: product, stage: 'postpublish', baseVerified: true, fullVerified: true,
    allProfilesVerified: true, registryInstallVerified: true, profiles: [] }); // Data-only central metadata, never a capability.
  put('consumer-product-binding.json', { product, tools: [] });
  for (const suffix of ['receipt.json', 'stdout.raw.log', 'stderr.raw.log']) put('producer-supervision/registry-consumer.' + suffix, '{}');
  return { product, shardName, put, rows };
}
test('Source-selected registered shard crosses16MiB with full streaming SHA, private sibling remains outside public', () => fixture(root => {
  const publicRoot = path.join(root, 'public'); mkdirSync(publicRoot);
  const f = publicTransportFixture(publicRoot);
  mkdirSync(path.join(root, 'public-private', 'node-mounted', 'module-chain-fixture', 'auth'), { recursive: true });
  writeFileSync(path.join(root, 'public-private', 'node-mounted', 'module-chain-fixture', 'auth', 'credentials.json'), 'private-marker');
  const observed = collectProductConsumerOriginalInventory(publicRoot, f.product);
  const shard = observed.originals.find(row => row.path === f.shardName)!;
  expect(shard.bytes > productConsumerOriginalLimits('afs').smallMemberBytes).toBe(true);
  expect(shard.sha256).toBe(f.rows.get(f.shardName).sha256);
  expect(observed.originals.find(row => row.path === 'consumer-observation.json')?.sha256).toBe(f.rows.get('consumer-observation.json').sha256);
  expect(observed.originals.some(row => row.path.includes('credentials'))).toBe(false);
}));
test('a scene credential in the actual public root is rejected without treating a role hint as permission', () => fixture(root => {
  const f = publicTransportFixture(root, 1024);
  f.put('node-mounted/module-chain-fixture/auth/credentials.json', 'must-not-export');
  expect(() => collectProductConsumerOriginalInventory(root, f.product)).toThrow('unselected original');
}));
test('an unregistered large original or forged archive role cannot inherit the AFS shard window', () => fixture(root => {
  const f = publicTransportFixture(root, 1024);
  const file = path.join(root, 'unregistered.tar'); sparse(file, productConsumerOriginalLimits('afs').smallMemberBytes + 1);
  expect(() => collectProductConsumerOriginalInventory(root, f.product)).toThrow('unselected original');
  const hint = JSON.parse(readFileSync(path.join(root, 'consumer-public-original-selection.json'), 'utf8'));
  hint.files.push({ path: 'unregistered.tar', bytes: productConsumerOriginalLimits('afs').smallMemberBytes + 1,
    sha256: 'f'.repeat(64), mode: 0o644, role: 'verifier-tool-archive' });
  f.put('consumer-public-original-selection.json', hint);
  expect(() => collectProductConsumerOriginalInventory(root, f.product)).toThrow('outside Source selection');
}));
test('fixed parent uses actual Source stage budget and the real supervisor recognizes that same route', () => {
  const { commandBudget, MAX_TIMEOUT_MS } = createRequire(import.meta.url)('../../scripts/lib/afs-publication-command.cjs');
  for (const stage of ['prepublish', 'postpublish'] as const) {
    const timeout = registryConsumerParentTimeout('afs', stage);
    expect(timeout).toBe(afsConsumerBudget(stage).maximumDurationSeconds * 1000);
    const route = { cwd: process.cwd(), label: 'registry-consumer', env: { REGISTRY_CONSUMER_MODULE: 'afs', REGISTRY_CONSUMER_TARGET: 'linux-x64',
      PRODUCT_CONSUMER_STAGE: stage, INDEPENDENT_PUBLICATION_PHASE: 'registry-consumer-child' } };
    expect(commandBudget(process.execPath, [path.resolve('scripts/run-independent-publication.ts')], route).maximumTimeoutMs).toBe(timeout);
    for (const module of ['api', 'css', 'client', 'cli'] as const) expect(registryConsumerParentTimeout(module, stage)).toBe(MAX_TIMEOUT_MS);
  }
});


test('central consumer observation remains inside the ordinary small-file ceiling', () => fixture(root => {
  const f = publicTransportFixture(root, 1024);
  const file = path.join(root, 'consumer-observation.json'); rmSync(file);
  sparse(file, productConsumerOriginalLimits('afs').smallMemberBytes + 1);
  expect(() => collectProductConsumerOriginalInventory(root, f.product)).toThrow('bounded ordinary original');
}));
