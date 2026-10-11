import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bunCompileTarget } from '../src/native-target';
import { collectJavascriptNotices } from '../src/javascript-notices';
import { sha256File } from '../src/manifest';

test('binds generated source notices to the compiler and exact emitted prefix before writing', () => {
  const parent = path.resolve('.test-data/xpod-cli/generated-notices');
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(path.join(parent, 'case-'));
  try {
    const stage = path.join(work, 'stage');
    const repo = path.join(work, 'repo');
    const generated = path.join(work, 'generated');
    mkdirSync(stage); mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
    mkdirSync(path.join(generated, 'objects'), { recursive: true });
    writeFileSync(path.join(stage, 'main.ts'), 'export const value = 1;');
    const prefix = 'var __fixture = 1;';
    const cli = path.join(work, 'cli.mjs');
    writeFileSync(cli, `${prefix}\n// main.ts\nexport const value = 1;`);
    const original = path.join(work, 'original');
    writeFileSync(original, prefix);
    const sha = sha256File(original);
    const object = `objects/${sha}.txt`;
    cpSync(original, path.join(generated, object));
    const record = { schemaVersion: 1, bunVersion: '1.3.8', prefixSha256: sha, prefixBytes: Buffer.byteLength(prefix), provenance: { source: 'fixture' }, files: [{ sourcePath: 'original.js', object, sha256: sha }] };
    const recordPath = path.join(generated, 'index.json');
    writeFileSync(recordPath, JSON.stringify(record));
    const metafile = path.join(work, 'metafile.json');
    writeFileSync(metafile, JSON.stringify({ inputs: { 'main.ts': { bytes: 23, imports: [] } }, outputs: { 'cli.mjs': { inputs: { 'main.ts': { bytesInOutput: 23 } } } } }));
    const options = { metafile, stageRoot: stage, repoRoot: repo, destination: path.join(work, 'output'), target: 'darwin-arm64', cli, bunVersion: '1.3.8', generated };
    expect(collectJavascriptNotices(options)).toEqual(['index.json', object]);
    const index = JSON.parse(readFileSync(path.join(options.destination, 'index.json'), 'utf8'));
    expect(index.generated).toEqual(record);
    expect(index.cliSha256).toBe(sha256File(cli));
    expect(readFileSync(path.join(options.destination, object))).toEqual(readFileSync(original));
    const refused = path.join(work, 'refused');
    expect(() => collectJavascriptNotices({ ...options, bunVersion: '1.3.9', destination: refused })).toThrow('Unsupported generated');
    expect(existsSync(refused)).toBe(false);
    writeFileSync(cli, 'var __different = 1;\n// main.ts\n');
    expect(() => collectJavascriptNotices({ ...options, destination: refused })).toThrow('prefix differs');
    writeFileSync(cli, `${prefix}\n// main.ts\n`);
    writeFileSync(path.join(generated, object), 'changed');
    expect(() => collectJavascriptNotices({ ...options, destination: refused })).toThrow('notice hash mismatch');
    cpSync(original, path.join(generated, object));
    record.files[0].object = '../outside';
    writeFileSync(recordPath, JSON.stringify(record));
    expect(() => collectJavascriptNotices({ ...options, destination: refused })).toThrow('Unsafe generated');
    expect(existsSync(refused)).toBe(false);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('inventories scoped/nested versions, skips type-only manifests and preserves originals without granting clearance', () => {
  const testRoot = path.resolve('.test-data/xpod-cli/javascript-notices');
  mkdirSync(testRoot, { recursive: true });
  const work = mkdtempSync(path.join(testRoot, 'collect-'));
  try {
    const stage = path.join(work, 'stage');
    const repo = path.join(work, 'repo');
    const output = path.join(work, 'output');
    const files: Record<string, string> = {
      'stage/main.ts': 'import module;',
      'repo/node_modules/@scope/module/package.json': JSON.stringify({ name: '@scope/module', version: '2', license: 'MIT' }),
      'repo/node_modules/@scope/module/dist/package.json': '{"type":"module"}',
      'repo/node_modules/@scope/module/dist/index.js': 'export const value = 2;',
      'repo/node_modules/@scope/module/LICENSE': 'Original copyright\r\n',
      'repo/node_modules/@scope/module/node_modules/other/package.json': JSON.stringify({ name: 'other', version: '1' }),
      'repo/node_modules/@scope/module/node_modules/other/index.js': 'module.exports=1;',
      'repo/node_modules/other/package.json': JSON.stringify({ name: 'other', version: '2', license: 'ISC' }),
      'repo/node_modules/other/index.js': 'module.exports=2;',
      'cli': 'binary fixture',
    };
    for (const [name, content] of Object.entries(files)) {
      const filename = path.join(work, name);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, content);
    }
    symlinkSync(path.join(repo, 'node_modules'), path.join(stage, 'node_modules'), 'dir');
    const inputPaths = ['main.ts', 'node_modules/@scope/module/dist/index.js', '../repo/node_modules/@scope/module/node_modules/other/index.js', '../repo/node_modules/other/index.js'];
    const metadata = { inputs: Object.fromEntries(inputPaths.map((name) => [name, { bytes: 1, imports: [{ path: 'node:fs', external: true }, { path: path.join(stage, 'main.ts'), external: true }] }])), outputs: { 'main.js': { inputs: { 'main.ts': { bytesInOutput: 1 } } } } };
    const metafile = path.join(work, 'metafile.json');
    writeFileSync(metafile, JSON.stringify(metadata));
    const options = { metafile, stageRoot: stage, repoRoot: repo, destination: output, target: 'darwin-arm64', cli: path.join(work, 'cli'), bunVersion: '1.3.8' };
    expect(collectJavascriptNotices(options).length).toBe(2);
    const index = JSON.parse(readFileSync(path.join(output, 'index.json'), 'utf8'));
    expect(index.status).toBe('partial-collection');
    expect(index.cliSha256).toBe(sha256File(options.cli));
    expect(index.inputs.length).toBe(4);
    expect(index.packages.map((entry: { name: string; version: string }) => `${entry.name}@${entry.version}`).sort()).toEqual(['@scope/module@2', 'other@1', 'other@2']);
    const scoped = index.packages.find((entry: { name: string }) => entry.name === '@scope/module');
    expect(readFileSync(path.join(output, scoped.files[0].object), 'utf8')).toBe('Original copyright\r\n');
    const unknown = index.packages.find((entry: { name: string; version: string }) => entry.name === 'other' && entry.version === '1');
    expect(unknown.declaredLicense).toBeNull();
    expect(unknown.noticeStatus).toBe('missing-original');
    expect(index.externalImports).toEqual(['main.ts', 'node:fs']);
    expect(JSON.stringify(index)).not.toContain(work);
    const supplementDir = path.join(work, 'supplements');
    mkdirSync(path.join(supplementDir, 'objects'), { recursive: true });
    const original = path.join(repo, 'node_modules/@scope/module/LICENSE');
    const sha = sha256File(original);
    const object = `objects/${sha}.txt`;
    cpSync(original, path.join(supplementDir, object));
    const supplement = { schemaVersion: 1, entries: [{ name: 'other', version: '1', provenance: { gitHead: 'fixed-source' }, files: [{ sourcePath: 'upstream LICENSE', object, sha256: sha }] }] };
    const supplementIndex = path.join(supplementDir, 'index.json');
    writeFileSync(supplementIndex, JSON.stringify(supplement));
    const supplementalOutput = path.join(work, 'supplemental-output');
    expect(collectJavascriptNotices({ ...options, supplements: supplementDir, destination: supplementalOutput }).length).toBe(2);
    const augmented = JSON.parse(readFileSync(path.join(supplementalOutput, 'index.json'), 'utf8'));
    expect(augmented.packages.find((entry: { name: string; version: string }) => entry.name === 'other' && entry.version === '1').noticeStatus).toBe('collected-candidates');
    expect(augmented.packages.find((entry: { name: string; version: string }) => entry.name === 'other' && entry.version === '2').noticeStatus).toBe('missing-original');
    writeFileSync(path.join(supplementDir, object), 'changed');
    const driftOutput = path.join(work, 'drift-refused');
    expect(() => collectJavascriptNotices({ ...options, supplements: supplementDir, destination: driftOutput })).toThrow('supplement hash mismatch');
    expect(existsSync(driftOutput)).toBe(false);
    cpSync(original, path.join(supplementDir, object));
    supplement.entries[0].files[0].object = '../outside';
    writeFileSync(supplementIndex, JSON.stringify(supplement));
    expect(() => collectJavascriptNotices({ ...options, supplements: supplementDir, destination: driftOutput })).toThrow('Unsafe JavaScript supplement');
    supplement.entries[0].files[0].object = object;
    supplement.entries.push(supplement.entries[0]);
    writeFileSync(supplementIndex, JSON.stringify(supplement));
    expect(() => collectJavascriptNotices({ ...options, supplements: supplementDir, destination: driftOutput })).toThrow('duplicate JavaScript notice');
    metadata.inputs['main.ts'].imports.push({ path: path.join(work, 'outside-import'), external: true });
    writeFileSync(metafile, JSON.stringify(metadata));
    expect(() => collectJavascriptNotices({ ...options, destination: path.join(work, 'outside-import-refused') })).toThrow('absolute external import');
    expect(existsSync(path.join(work, 'outside-import-refused'))).toBe(false);
    metadata.inputs['main.ts'].imports.pop();
    metadata.inputs['../../outside.js'] = { bytes: 1, imports: [] };
    writeFileSync(metafile, JSON.stringify(metadata));
    const refused = path.join(work, 'refused');
    expect(() => collectJavascriptNotices({ ...options, destination: refused })).toThrow('outside staging/dependencies');
    expect(existsSync(refused)).toBe(false);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('collects actual portable JS metafile on Windows metadata without admitting Windows native', () => {
  const parent = path.resolve('.test-data/xpod-cli/portable-notices');
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(path.join(parent, 'case-'));
  try {
    const stage = path.join(work, 'stage'); const repo = path.join(work, 'repo');
    mkdirSync(stage); mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
    const entry = path.join(stage, 'main.ts'); const cli = path.join(work, 'main.mjs'); const metafile = path.join(work, 'metafile.json');
    writeFileSync(entry, 'export const portable = 42;');
    const built = spawnSync(process.execPath, ['build', '--target=node', '--format=esm', '--outfile', cli, '--metafile=' + metafile, entry], { cwd: stage });
    expect(built.status).toBe(0); expect(built.error).toBeUndefined();
    const options = { metafile, stageRoot: stage, repoRoot: repo, destination: path.join(work, 'notices'), target: 'win32-x64', cli, bunVersion: process.versions.bun! };
    collectJavascriptNotices(options);
    const index = JSON.parse(readFileSync(path.join(options.destination, 'index.json'), 'utf8'));
    expect(index.target).toBe('win32-x64'); expect(index.cliSha256).toBe(sha256File(cli)); expect(index.inputs.length).toBe(1);
    expect(index.inputs[0].sha256).toBe(sha256File(entry));
    expect(() => collectJavascriptNotices({ ...options, target: '../win32-x64', destination: path.join(work, 'unsafe') })).toThrow('Invalid JavaScript build target metadata');
    expect(existsSync(path.join(work, 'unsafe'))).toBe(false);
    expect(() => bunCompileTarget('win32-x64')).toThrow('Unsupported build target');
    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) { expect(bunCompileTarget(target)).toBe('bun-' + target); }
  } finally { rmSync(work, { recursive: true, force: true }); }
});


test('requires original notices for explicitly shipped packages outside the import graph', () => {
  const parent = path.resolve('.test-data/xpod-cli/vendored-notices');
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(path.join(parent, 'case-'));
  try {
    const stage = path.join(work, 'stage'); const repo = path.join(work, 'repo');
    const vendor = path.join(work, 'vendor');
    mkdirSync(stage); mkdirSync(vendor); mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
    writeFileSync(path.join(stage, 'main.ts'), 'export const value = 1;');
    writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({ name: '@fixture/shipped', version: '1', license: 'MIT' }));
    const cli = path.join(work, 'bundle'); writeFileSync(cli, 'fixture');
    const metafile = path.join(work, 'inputs.json');
    writeFileSync(metafile, JSON.stringify({ inputs: { 'main.ts': { bytes: 1, imports: [] } }, outputs: { bundle: { inputs: {} } } }));
    const options = { stageRoot: stage, repoRoot: repo, cli, metafile, target: 'linux-x64', bunVersion: 'fixture',
      destination: path.join(work, 'notices'), vendoredRoots: [vendor], requireVendoredOriginals: true };
    expect(() => collectJavascriptNotices(options)).toThrow('Vendored JavaScript original notice missing');
    expect(existsSync(options.destination)).toBe(false);
    const supplement = path.join(work, 'supplement'); mkdirSync(path.join(supplement, 'objects'), { recursive: true });
    const original = path.join(vendor, 'LICENSE'); writeFileSync(original, 'Original terms\r\n');
    const sha = sha256File(original); const object = `objects/${sha}.txt`;
    cpSync(original, path.join(supplement, object)); rmSync(original);
    writeFileSync(path.join(supplement, 'index.json'), JSON.stringify({ schemaVersion: 1,
      entries: [{ name: '@fixture/shipped', version: '1', provenance: { source: 'fixture' }, files: [{ sourcePath: 'LICENSE', object, sha256: sha }] }] }));
    collectJavascriptNotices({ ...options, supplements: [supplement] });
    const index = JSON.parse(readFileSync(path.join(options.destination, 'index.json'), 'utf8'));
    expect(index.packages[0].vendored).toBe(true);
    expect(index.packages[0].inputCount).toBe(0);
    expect(readFileSync(path.join(options.destination, object), 'utf8')).toBe('Original terms\r\n');
    expect(index.status).toBe('partial-collection');
    expect(() => collectJavascriptNotices({ ...options, supplements: [supplement, supplement], destination: path.join(work, 'duplicate') })).toThrow('duplicate');
  } finally { rmSync(work, { recursive: true, force: true }); }
});


test('binds actual public build-tools prefixes including the explicit zero-prefix ESM profile', () => {
  const packageRoot = path.resolve(import.meta.dir, '..');
  const repoRoot = path.resolve(packageRoot, '../..');
  const parent = path.join(repoRoot, '.test-data/xpod-cli/build-tools-generated'); mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(path.join(parent, 'case-'));
  try {
    for (const [format, extension] of [['esm', 'mjs'], ['cjs', 'cjs']] as const) {
      const cli = path.join(work, format + '.js');
      const metafile = path.join(work, format + '-inputs.json');
      const compiled = spawnSync(process.execPath, ['build', '--target=node', '--format=' + format, '--metafile=' + metafile, '--outfile', cli, path.join(packageRoot, 'src/build-tools.ts')], { cwd: packageRoot, encoding: 'utf8' });
      expect(compiled.error).toBeUndefined(); expect(compiled.status).toBe(0); expect(compiled.signal).toBeNull();
      const options = { metafile, stageRoot: packageRoot, repoRoot, destination: path.join(work, format), target: process.platform + '-' + process.arch, cli, bunVersion: '1.4.2', supplements: path.join(packageRoot, 'licenses/javascript'), generated: path.join(packageRoot, 'licenses/javascript/generated/1.4.2'), generatedProfile: ('build-tools-' + format) as 'build-tools-esm' | 'build-tools-cjs' };
      collectJavascriptNotices(options);
      const index = JSON.parse(readFileSync(path.join(options.destination, 'index.json'), 'utf8'));
      expect(index.generated.prefixBytes).toBe(format === 'esm' ? 0 : 2129);
      if (format === 'esm') {
        const ordinary = path.join(work, 'ordinary-empty'); cpSync(options.generated, ordinary, { recursive: true });
        writeFileSync(path.join(ordinary, 'index.json'), JSON.stringify(index.generated));
        expect(() => collectJavascriptNotices({ ...options, generated: ordinary, generatedProfile: undefined, destination: path.join(work, 'ordinary-refused') })).toThrow('Unsupported generated');
      }
      expect(index.generated.files.some((row: {sourcePath:string}) => row.sourcePath === 'src/runtime.js')).toBe(true);
      expect(() => collectJavascriptNotices({ ...options, generated: undefined, destination: path.join(work, format + '-missing') })).toThrow('requires source provenance');
      writeFileSync(cli, 'var __unreviewed = 1;\n' + readFileSync(cli, 'utf8'));
      expect(() => collectJavascriptNotices({ ...options, destination: path.join(work, format + '-drift') })).toThrow('prefix differs');
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});
