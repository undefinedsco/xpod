import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planIndependentRelease, type ReleaseInput } from '../../scripts/independent-release-plan';

// Synthetic tiny archives exercise the planning contract, never release qualification.
const roots: string[] = [];
const sourceSha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  mkdirSync('.test-data/independent-release-plan', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-data/independent-release-plan/case-')); roots.push(root);
  let sequence = 0;
  const ref = (file: string) => ({ path: file, sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') });
  const put = (value: unknown) => { const file = `${sequence++}.json`; writeFileSync(path.join(root, file), JSON.stringify(value)); return ref(file); };
  function product(product: 'cli' | 'client' | 'api' | 'css' | 'afs', options: { version?: string; target?: string; manifest?: Record<string, unknown>; gates?: Record<string, unknown>; files?: Record<string, string>; corruptInventory?: boolean } = {}) {
    const module = !['cli', 'client'].includes(product);
    const target = options.target ?? (module ? 'linux-x64' : undefined);
    const version = options.version ?? '0.1.0-preview.2';
    const name = `@undefineds.co/xpod-${product}${module ? '-' + target : ''}`;
    const directory = `${sequence++}`; mkdirSync(path.join(root, directory, 'package'), { recursive: true });
    const manifest = { name, version, ...(product === 'cli' ? { dependencies: { '@undefineds.co/xpod-client': '0.1.0-preview.2' } } : {}),
      ...(module ? { xpodModule: { schemaVersion: 1, id: product, cliApiVersion: 1, platform: target!.split('-')[0], arch: target!.split('-')[1], entry: 'entry.mjs',
        files: [{ path: 'entry.mjs', size: 0, sha256: createHash('sha256').update('').digest('hex'), mode: 0o644 }] } } : {}), ...options.manifest };
    if (module) writeFileSync(path.join(root, directory, 'package/entry.mjs'), '', { mode: 0o644 });
    for (const [file, body] of Object.entries(options.files ?? {})) {
      const destination = path.join(root, directory, 'package', file); mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, body, { mode: 0o644 });
      if (module) (manifest as any).xpodModule.files.push({ path: file, size: Buffer.byteLength(body),
        sha256: options.corruptInventory ? 'a'.repeat(64) : createHash('sha256').update(body).digest('hex'), mode: 0o644 });
    }
    writeFileSync(path.join(root, directory, 'package/package.json'), JSON.stringify(manifest));
    const archiveFile = `${directory}.tgz`;
    const packed = spawnSync('tar', ['-czf', path.join(root, archiveFile), '-C', path.join(root, directory), 'package']);
    if (packed.status !== 0) throw new Error('Fixture tar failed');
    const archive = ref(archiveFile);
    const gates = Object.fromEntries(Object.entries(options.gates ?? {}).map(([gate, value]) => [gate, put(value)]));
    const receipt = put({ schemaVersion: 1, kind: 'independent-product-input', sourceSha, package: name, version, target, archiveSHA256: archive.sha256, integrity: 'sha512-' + createHash('sha512').update(readFileSync(path.join(root, archiveFile))).digest('base64'), gates });
    return { product, version, target, archive, receipt };
  }
  const plan = (products: ReleaseInput['products']) => planIndependentRelease({ schemaVersion: 1, sourceSha, checkoutSha: sourceSha, runHeadSha: sourceSha, products }, root);
  return { root, put, ref, product, plan };
}
describe('independent release planning (synthetic contract fixtures)', () => {
  it('orders client before CLI and preserves independent module branches without root service', () => {
    const f = fixture();
    const result = f.plan([f.product('cli'), f.product('client'), f.product('css'), f.product('api'), f.product('afs')]);
    expect(result.products.find(row => row.id === 'cli')!.needs).toEqual(['client']);
    expect(result.products.filter(row => row.id !== 'cli').every(row => row.needs.length === 0)).toBe(true);
    expect(result.status).toBe('blocked'); expect(result.releaseQualified).toBe(false); expect(result.published).toBe(false);
    expect(JSON.stringify(result)).not.toContain('readyToPublish');
    expect(result.products.every(row => row.blockers.length > 0)).toBe(true);
  });
  it('retains actual producer evidence meanings instead of granting clearance', () => {
    const f = fixture(); const result = f.plan([f.product('api', { gates: {
      source: { schemaVersion: 1, status: 'candidate', sourceAuthority: { sourceCommit: sourceSha, dirty: false } },
      legal: { schemaVersion: 1, status: 'original-material-collection', legalClearance: false },
      native: { status: 'material-integrity-verified', externalAdmission: 'pending' },
      consumer: { status: 'passed', legalAccepted: true, nativeAccepted: true },
    } })]);
    expect(result.products[0].blockers).toHaveLength(5);
    expect(result.products[0].blockers.find(row => row.gate === 'legal')!.reason).toContain('does not confer');
    expect(result.releaseQualified).toBe(false);
  });
  it('uses exact preview versions for future registry acceptance', () => {
    const f = fixture(); const item = f.product('afs');
    expect(f.plan([item]).products[0].acceptance).toEqual({ transport: 'registry', version: item.version });
    expect(() => f.plan([{ ...item, version: 'next' }])).toThrow('exact independent version');
  });
  for (const value of ['file:../client.tgz', 'workspace:*', 'link:../client']) {
    it(`rejects test or workspace dependency ${value}`, () => {
      const f = fixture(); expect(() => f.plan([f.product('client', { manifest: { dependencies: { client: value } } })])).toThrow('not publishable');
    });
  }
  it('rejects private producer and unsuffixed module package', () => {
    const f = fixture(); expect(() => f.plan([f.product('api', { manifest: { private: true } })])).toThrow('private producer');
    expect(() => f.plan([f.product('api', { manifest: { name: '@undefineds.co/xpod-api' } })])).toThrow('identity');
  });
  it('rejects archive and receipt hash drift', () => {
    const f = fixture(); const item = f.product('api');
    writeFileSync(path.join(f.root, item.archive.path), 'changed');
    expect(() => f.plan([item])).toThrow('hash mismatch');
    const second = f.product('api'); writeFileSync(path.join(f.root, second.receipt.path), '{}');
    expect(() => f.plan([second])).toThrow('hash mismatch');
  });
  it('rejects receipt source/target/archive binding drift even after rehash', () => {
    for (const change of [{ sourceSha: 'a'.repeat(40) }, { target: 'darwin-arm64' }, { archiveSHA256: 'b'.repeat(64) }]) {
      const f = fixture(); const item = f.product('api');
      item.receipt = f.put({ ...JSON.parse(readFileSync(path.join(f.root, item.receipt.path), 'utf8')), ...change });
      expect(() => f.plan([item])).toThrow('receipt identity');
    }
  });
  it('rejects unsupported and mismatched target ABI and duplicate products', () => {
    const f = fixture(); expect(() => f.plan([f.product('api', { target: 'win32-x64' })])).toThrow('target');
    const item = f.product('api'); expect(() => f.plan([item, item])).toThrow('duplicate');
    expect(() => f.plan([f.product('api', { manifest: { xpodModule: { id: 'css', platform: 'linux', arch: 'x64', cliApiVersion: 1 } } })])).toThrow('ABI');
  });
  it('rejects dirty or unrelated existing source authority', () => {
    const f = fixture(); expect(() => f.plan([f.product('api', { gates: { source: { sourceAuthority: { sourceCommit: sourceSha, dirty: true } } } })])).toThrow('source authority');
  });
  it('does not use legacy failure as a module dependency or override product gates', () => {
    const f = fixture(); const input = { schemaVersion: 1, sourceSha, checkoutSha: sourceSha, runHeadSha: sourceSha, products: [f.product('api')], legacyRoot: { status: 'failed' } };
    const result = planIndependentRelease(input as ReleaseInput, f.root);
    expect(result.products[0].needs).toEqual([]); expect(result.products[0].blockers.map(row => row.gate)).toEqual(['runtime-closure', 'source', 'native', 'legal', 'consumer']);
  });
  it('distinguishes run head from actual checkout and rejects mismatched built source', () => {
    const f = fixture(); const input: ReleaseInput = { schemaVersion: 1, sourceSha, checkoutSha: sourceSha, runHeadSha: 'a'.repeat(40), products: [f.product('api')] };
    expect(planIndependentRelease(input, f.root).runHeadSha).toBe('a'.repeat(40));
    expect(() => planIndependentRelease({ ...input, sourceSha: 'b'.repeat(40), checkoutSha: 'b'.repeat(40) }, f.root)).toThrow('actual checkout');
  });
  it('rejects SRI drift and a CLI runtime client range', () => {
    const f = fixture(); const item = f.product('api');
    item.receipt = f.put({ ...JSON.parse(readFileSync(path.join(f.root, item.receipt.path), 'utf8')), integrity: 'sha512-' + 'a'.repeat(86) + '==' });
    expect(() => f.plan([item])).toThrow('receipt identity');
    expect(() => f.plan([f.product('cli', { manifest: { dependencies: { '@undefineds.co/xpod-client': '^0.1.0' } } })])).toThrow('exact runtime client');
  });
  it('checks only effective manifests and preserves original source manifest bytes', () => {
    const f = fixture();
    const item = f.product('api', { gates: { source: { schemaVersion: 1, originalManifest: { dependencies: { original: 'workspace:*' } } } } });
    expect(f.plan([item]).products[0].evidence).toHaveLength(1);
  });
  it('requires the physical module inventory to bind every installed member', () => {
    const f = fixture(); expect(() => f.plan([f.product('api', { manifest: { xpodModule: {
      schemaVersion: 1, id: 'api', cliApiVersion: 1, platform: 'linux', arch: 'x64', entry: 'entry.mjs', files: [],
    } } })])).toThrow('inventory mismatch');
  });
  it('does not accept a boolean self-approval envelope as an input receipt', () => {
    const f = fixture(); const item = f.product('api');
    item.receipt = f.put({ sourceAccepted: true, nativeAccepted: true, legalAccepted: true, readyToPublish: true });
    expect(() => f.plan([item])).toThrow('receipt identity');
  });
  for (const value of ['FILE:../local.tgz', ' file:../local.tgz', '1.0.0 ', 'C:\\local\\package', 'npm:alias@LINK:../local']) {
    it(`rejects noncanonical or local dependency ${value}`, () => {
      const f = fixture(); expect(() => f.plan([f.product('client', { manifest: { dependencies: { local: value } } })])).toThrow('not publishable');
    });
  }
  it('checks nested overrides and resolutions without flattening selectors', () => {
    for (const manifest of [
      { overrides: { dependency: { '.': '1.0.0', nested: 'FILE:../local' } } },
      { resolutions: { '**/nested': 'LINK:../local' } },
      { overrides: { 'dependency@file:../local': '1.0.0' } },
    ]) {
      const f = fixture(); expect(() => f.plan([f.product('client', { manifest })])).toThrow('not publishable');
    }
    const f = fixture(); expect(f.plan([f.product('client', { manifest: { overrides: { dependency: { '.': '1.0.0', nested: '^2.0.0' } } } })]).status).toBe('blocked');
  });
  it('requires actual API build inputs while keeping registry publication independent', () => {
    const f = fixture(); const result = f.plan([f.product('api')]);
    expect(result.buildDag.find(row => row.id === 'api-producer')!.needs).toEqual(['afs-client-build']);
    expect(result.buildDag.find(row => row.id === 'afs-client-build')!.needs).toEqual(['cli-build-and-producer-materials']);
    expect(result.products[0].needs).toEqual([]);
  });
  it('preserves real-shaped nested original development metadata while blocking runtime admission', () => {
    const f = fixture(); const original = JSON.stringify({ name: 'upstream-original', version: '1.0.0',
      dependencies: { shared: 'workspace:*' }, optionalDependencies: { helper: 'file:../helper' }, peerDependencies: { peer: 'link:../peer' },
      devDependencies: { tools: 'FILE:../tools' }, overrides: { build: 'workspace:*' } });
    const files = {
      'node_modules/upstream-original/package.json': original,
      'source/original-package/package.json': original,
      'node_modules/upstream-original/provenance/source/package.json': original,
      'provenance/identity-dedup.json': JSON.stringify({ algorithm: 'original-bytes-mode-and-complete-dependency-partition-v1', originalRootCount: 1, canonicalIdentityCount: 1,
        identities: [{ name: 'upstream-original', version: '1.0.0', originalContentSHA256: 'a'.repeat(64), identityClass: '0', dependencies: [] }] }),
      'provenance/packages/original.json': JSON.stringify({ name: 'upstream-original', version: '1.0.0', path: 'node_modules/upstream-original',
        files: [{ path: 'package.json', bytes: Buffer.byteLength(original), sha256: createHash('sha256').update(original).digest('hex'), mode: 0o644 }] }),
    };
    const result = f.plan([f.product('api', { files })]);
    expect(result.products[0].runtimeClosureMaterials).toHaveLength(2);
    expect(result.products[0].blockers.some(row => row.gate === 'runtime-closure')).toBe(true);
    expect(result.releaseQualified).toBe(false);
    expect(() => f.plan([f.product('api', { manifest: { devDependencies: { tools: 'FILE:../tools' } } })])).toThrow('not publishable');
    expect(() => f.plan([f.product('api', { files, corruptInventory: true })])).toThrow('inventory mismatch');
  });
  for (const version of ['1.0.0-01', 'v1.0.0', '1.0.0+build', '9007199254740992.0.0']) {
    it(`uses the same exact semver validation for product and runtime client: ${version}`, () => {
      const f = fixture(); expect(() => f.plan([f.product('client', { version })])).toThrow('exact independent version');
      expect(() => f.plan([f.product('cli', { manifest: { dependencies: { '@undefineds.co/xpod-client': version } } })])).toThrow('exact runtime client');
    });
  }
});
