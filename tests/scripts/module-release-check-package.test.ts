import { afterAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkPackage, nativeServesTarget } from '../../scripts/module-release/check-package';

const base = path.resolve('.test-data/module-release-check');
mkdirSync(base, { recursive: true });
afterAll(() => rmSync(base, { recursive: true, force: true }));

function mach(arm = false) { const b = Buffer.alloc(32); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(arm ? 0x0100000c : 0x01000007, 4); b.writeUInt32LE(2, 12); return b; }
function elf() { const b = Buffer.alloc(64); b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); b.writeUInt16LE(2, 16); b.writeUInt32LE(1, 20); b.writeUInt16LE(62, 18); b.writeUInt16LE(64, 52); return b; }
function fat() { const b = Buffer.alloc(112); b.writeUInt32BE(0xcafebabe, 0); b.writeUInt32BE(2, 4); for (let i = 0; i < 2; i++) { const at = 8 + i * 20; b.writeUInt32BE(i ? 0x0100000c : 0x01000007, at); b.writeUInt32BE(48 + i * 32, at + 8); b.writeUInt32BE(32, at + 12); mach(Boolean(i)).copy(b, 48 + i * 32); } return b; }

/** Pack a module tarball whose xpodModule inventory describes exactly `files` unless told otherwise. */
function pack(files: Record<string, string | Buffer>, options: { name?: string; skipInventory?: string; license?: string; repository?: unknown } = {}) {
  const dir = mkdtempSync(path.join(base, 'pkg-'));
  const root = path.join(dir, 'package');
  const rows = [];
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    chmodSync(target, 0o644);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (file !== options.skipInventory) rows.push({ path: file, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mode: 0o644 });
  }
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: options.name ?? '@undefineds.co/xpod-api-darwin-arm64', version: '1.2.3',
    repository: 'repository' in options ? options.repository : { type: 'git', url: 'git+https://github.com/undefinedsco/xpod.git', directory: 'packages/xpod-api' },
    xpodModule: { schemaVersion: 1, id: 'api', cliApiVersion: 1, platform: 'darwin', arch: 'arm64', entry: 'dist/entry.mjs', files: rows },
  }));
  const tarball = path.join(dir, 'module.tgz');
  expect(spawnSync('tar', ['-czf', tarball, '-C', dir, 'package']).status).toBe(0);
  return { tarball, out: path.join(dir, 'out') };
}

const dependency = (license: string) => JSON.stringify({ name: 'dep', version: '1.0.0', license });

describe('module release package check', () => {
  it('accepts an exact inventory with target natives and permissive licences', () => {
    const { tarball, out } = pack({ 'dist/entry.mjs': 'export {}', 'node_modules/dep/package.json': dependency('MIT'), 'bin/helper': mach(true) });
    const report = checkPackage(tarball, 'api', 'darwin-arm64', out);
    expect(report.failures).toEqual([]);
    expect(report.natives).toEqual([{ path: 'bin/helper', ok: true }]);
  });

  it('rejects a native file built for another platform', () => {
    const { tarball, out } = pack({ 'dist/entry.mjs': 'export {}', 'vendor/linux/rg': elf() });
    expect(checkPackage(tarball, 'api', 'darwin-arm64', out).failures).toContain('native file cannot load on darwin-arm64: vendor/linux/rg');
  });

  it('accepts a universal Mach-O only for a darwin target it carries', () => {
    expect(nativeServesTarget(fat(), 'darwin-arm64')).toBe(true);
    expect(nativeServesTarget(fat(), 'darwin-x64')).toBe(true);
    expect(nativeServesTarget(fat(), 'linux-arm64')).toBe(false);
    expect(nativeServesTarget(mach(), 'darwin-arm64')).toBe(false);
  });

  it('rejects a file missing from the xpodModule inventory', () => {
    const { tarball, out } = pack({ 'dist/entry.mjs': 'export {}', 'extra.js': 'x' }, { skipInventory: 'extra.js' });
    expect(checkPackage(tarball, 'api', 'darwin-arm64', out).failures).toContain('file missing from xpodModule inventory: extra.js');
  });

  it('rejects an unclassified licence and flags weak copyleft for a source offer', () => {
    const blocked = pack({ 'dist/entry.mjs': 'export {}', 'node_modules/dep/package.json': dependency('SEE LICENSE IN README.md') });
    expect(checkPackage(blocked.tarball, 'api', 'darwin-arm64', blocked.out).failures).toContain('licence not allowed: dep@1.0.0 (SEE LICENSE IN README.md)');
    const lgpl = pack({ 'dist/entry.mjs': 'export {}', 'node_modules/dep/package.json': dependency('LGPL-3.0-or-later') });
    const report = checkPackage(lgpl.tarball, 'api', 'darwin-arm64', lgpl.out);
    expect(report.failures).toEqual([]);
    expect(report.sourceOffer).toEqual([{ name: 'dep', version: '1.0.0', license: 'LGPL-3.0-or-later' }]);
  });

  it('rejects a package whose repository would fail the npm provenance check', () => {
    const missing = pack({ 'dist/entry.mjs': 'export {}' }, { repository: undefined });
    expect(checkPackage(missing.tarball, 'api', 'darwin-arm64', missing.out).failures).toContain('repository.url must name https://github.com/undefinedsco/xpod');
    const other = pack({ 'dist/entry.mjs': 'export {}' }, { repository: 'https://github.com/someone/fork' });
    expect(checkPackage(other.tarball, 'api', 'darwin-arm64', other.out).failures).toContain('repository.url must name https://github.com/undefinedsco/xpod');
  });

  it('rejects a package whose name does not match the module target', () => {
    const { tarball, out } = pack({ 'dist/entry.mjs': 'export {}' }, { name: '@undefineds.co/xpod-api-linux-x64' });
    expect(checkPackage(tarball, 'api', 'darwin-arm64', out).failures).toContain('package name @undefineds.co/xpod-api-linux-x64 is not @undefineds.co/xpod-api-darwin-arm64');
  });
});
