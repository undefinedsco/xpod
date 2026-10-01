import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectJavascriptNotices } from '../src/javascript-notices';
import { sha256File } from '../src/manifest';

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
