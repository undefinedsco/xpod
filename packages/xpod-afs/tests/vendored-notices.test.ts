import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Test-only explicit public CLI package input until its exports are integrated.
// Missing exports fail; never resolve a private source implementation.
const cliPackage = path.resolve(process.env.XPOD_AFS_TEST_CLI_PACKAGE ?? path.join(import.meta.dir, '../../xpod-cli'));
const publicRequire = createRequire(path.join(cliPackage, 'package.json'));
const { collectJavascriptNotices } = await import(pathToFileURL(publicRequire.resolve('@undefineds.co/xpod-cli/build-tools')).href);

const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

test('inventories an actually staged external vendor with original terms and rejects missing, drift and duplicate authority', () => {
  const parent = path.resolve('.test-data/afs-vendored-notices'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  try {
    const stage = path.join(root, 'source'); const repo = path.join(root, 'repo');
    const vendor = path.join(root, 'payload/node_modules/fixture-dependency'); const supplement = path.join(root, 'supplement');
    for (const directory of [stage, path.join(repo, 'node_modules'), vendor, path.join(supplement, 'objects')]) { mkdirSync(directory, { recursive: true }); }
    const entry = path.join(stage, 'main.ts'); const cli = path.join(root, 'main.mjs'); const metafile = path.join(root, 'meta.json');
    writeFileSync(entry, "import { value } from 'fixture-dependency'; export const result = value;");
    const build = spawnSync(process.execPath, ['build', '--target=node', '--format=esm', '--external=fixture-dependency', '--metafile=' + metafile, '--outfile', cli, entry], { cwd: stage });
    expect(build.status).toBe(0); expect(build.error).toBeUndefined();
    writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '2.0', license: 'fixture-license' }));
    const options = { stageRoot: stage, repoRoot: repo, metafile, cli, target: 'linux-x64', bunVersion: process.versions.bun!, vendoredRoots: [vendor], requireVendoredOriginals: true, destination: path.join(root, 'missing') };
    expect(() => collectJavascriptNotices(options)).toThrow('Vendored JavaScript original notice missing'); expect(existsSync(options.destination)).toBe(false);
    const original = Buffer.from('Fixture original terms\r\n'); const digest = hash(original); writeFileSync(path.join(supplement, 'objects', digest + '.txt'), original);
    const authority = Buffer.from(JSON.stringify({ name: 'fixture-dependency', version: '2.0' })); const authorityHash = hash(authority); writeFileSync(path.join(supplement, 'objects', authorityHash + '.txt'), authority);
    const index = { schemaVersion: 1, entries: [{ name: 'fixture-dependency', version: '2.0', provenance: { kind: 'controlled-test-original' }, authority: { sourcePath: 'package.json', object: 'objects/' + authorityHash + '.txt', sha256: authorityHash }, files: [{ sourcePath: 'LICENSE', object: 'objects/' + digest + '.txt', sha256: digest }] }] };
    writeFileSync(path.join(supplement, 'index.json'), JSON.stringify(index));
    const destination = path.join(root, 'collected'); collectJavascriptNotices({ ...options, destination, supplements: [supplement] });
    const collected = JSON.parse(readFileSync(path.join(destination, 'index.json'), 'utf8')); const pkg = collected.packages.find((item: { name: string }) => item.name === 'fixture-dependency');
    expect(pkg.vendored).toBe(true); expect(pkg.inputCount).toBe(0); expect(pkg.noticeStatus).toBe('collected-candidates'); expect(collected.externalImports).toContain('fixture-dependency');
    expect(readFileSync(path.join(destination, pkg.files[0].object))).toEqual(original); expect(pkg.sourceAuthority.sha256).toBe(authorityHash);
    expect(() => collectJavascriptNotices({ ...options, destination: path.join(root, 'duplicate'), supplements: [supplement, supplement] })).toThrow('duplicate JavaScript notice supplement');
    writeFileSync(path.join(supplement, 'objects', digest + '.txt'), 'changed');
    expect(() => collectJavascriptNotices({ ...options, destination: path.join(root, 'tampered'), supplements: supplement })).toThrow('supplement hash mismatch'); expect(existsSync(path.join(root, 'tampered'))).toBe(false);
    writeFileSync(path.join(supplement, 'objects', digest + '.txt'), original);
    writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '3.0' }));
    expect(() => collectJavascriptNotices({ ...options, destination: path.join(root, 'new-version'), supplements: supplement })).toThrow('Vendored JavaScript original notice missing');
    writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '2.0' }));
    const wrong = Buffer.from(JSON.stringify({ name: 'another-package', version: '2.0' })); const wrongHash = hash(wrong); writeFileSync(path.join(supplement, 'objects', wrongHash + '.txt'), wrong);
    index.entries[0].authority = { sourcePath: 'package.json', object: 'objects/' + wrongHash + '.txt', sha256: wrongHash }; writeFileSync(path.join(supplement, 'index.json'), JSON.stringify(index));
    expect(() => collectJavascriptNotices({ ...options, destination: path.join(root, 'wrong-authority'), supplements: supplement })).toThrow('source version authority mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preserves exact official versioned license and package authority bytes offline', () => {
  const directory = path.resolve(import.meta.dir, '../licenses/javascript');
  const index = JSON.parse(readFileSync(path.join(directory, 'index.json'), 'utf8')); const supplement = index.entries[0];
  const license = readFileSync(path.join(directory, supplement.files[0].object)); const authority = readFileSync(path.join(directory, supplement.authority.object));
  expect(hash(license)).toBe(supplement.files[0].sha256); expect(hash(authority)).toBe(supplement.authority.sha256);
  expect(JSON.parse(authority.toString()).name).toBe(supplement.name); expect(JSON.parse(authority.toString()).version).toBe(supplement.version);
  const blob = createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + license.length + '\0'), license])).digest('hex');
  expect(blob).toBe(supplement.provenance.gitBlobSHA); expect(supplement.provenance.sourceUrl).toContain('/' + supplement.provenance.commit + '/LICENSE');
  expect(readFileSync(path.join(directory, 'upstream-package.json'))).toEqual(authority);
});
