import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { exportApplicationSources, verifyApplicationSources } from '../src/application-sources';
import { sha256File } from '../src/manifest';

test('preserves patched/nested package layout and rejects input drift or escaped material before output', () => {
  const root = path.resolve('.test-data/xpod-cli/application-sources');
  mkdirSync(root, { recursive: true });
  const work = mkdtempSync(path.join(root, 'kit-'));
  try {
    const stage = path.join(work, 'stage');
    const repo = path.join(work, 'repo');
    const pkg = path.join(stage, 'packages/xpod-cli');
    const notices = path.join(work, 'install/licenses');
    const files: Record<string, string> = {
      'stage/src/client.ts': 'export const source = 1;',
      'stage/packages/xpod-cli/src/main.ts': 'import "nested";',
      'stage/packages/xpod-cli/scripts/rebuild-application.ts': '// fixture recipe',
      'stage/packages/xpod-cli/package.json': '{"name":"xpod-cli","version":"1"}',
      'stage/packages/xpod-cli/APPLICATION-SOURCE-README.md': 'Scope: application materials only.',
      'stage/package.json': '{"name":"xpod","version":"1"}',
      'repo/bun.lock': 'lock fixture',
      'repo/node_modules/nested/package.json': '{"name":"nested","version":"2","exports":"./dist/index.js"}',
      'repo/node_modules/nested/dist/package.json': '{"type":"module"}',
      'repo/node_modules/nested/dist/index.js': '/* actual local patch */ export const value = 2;',
      'repo/node_modules/nested/node_modules/nested/package.json': '{"name":"nested","version":"1"}',
      'repo/node_modules/nested/node_modules/nested/index.js': 'module.exports = 1;',
      'repo/node_modules/nested/LICENSE': 'Original notice\r\n',
      'install/NOTICES.md': 'Original notices retained.',
      'cli': 'binary fixture',
    };
    for (const [relative, data] of Object.entries(files)) {
      const file = path.join(work, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, data);
    }
    const inputs = ['src/client.ts', 'packages/xpod-cli/src/main.ts', 'node_modules/nested/dist/index.js', 'node_modules/nested/node_modules/nested/index.js']
      .map((name) => ({ path: name, sha256: sha256File(path.join(name.startsWith('node_modules/') ? repo : stage, name)) }));
    const packages = ['node_modules/nested', 'node_modules/nested/node_modules/nested'].map((name) => {
      const file = path.join(repo, name, 'package.json'); const info = JSON.parse(readFileSync(file, 'utf8'));
      return { root: name, name: info.name, version: info.version, packageJsonSha256: sha256File(file) };
    });
    mkdirSync(path.join(notices, 'javascript'), { recursive: true });
    const index = { schemaVersion: 1, target: 'darwin-arm64', cliSha256: sha256File(path.join(work, 'cli')), inputs, packages, externalImports: ['node:fs'] };
    const indexFile = path.join(notices, 'javascript/index.json'); writeFileSync(indexFile, JSON.stringify(index));
    const options = {
      stageRoot: stage, repoRoot: repo, packageRoot: pkg, notices, destination: path.join(work, 'output'), target: 'darwin-arm64',
      cli: path.join(work, 'cli'), compiler: process.execPath, compilerVersion: 'test-version', hostTarget: 'darwin-arm64',
      source: { commit: 'a'.repeat(40), dirtyTreeHash: null },
    };
    const kit = exportApplicationSources(options);
    expect(verifyApplicationSources(options.destination).cliSha256).toBe(index.cliSha256);
    expect(kit.files.some((file) => file.path === 'node_modules/nested/dist/package.json')).toBe(true);
    expect(readFileSync(path.join(options.destination, 'node_modules/nested/LICENSE'), 'utf8')).toBe('Original notice\r\n');
    expect(readFileSync(path.join(options.destination, inputs[2].path), 'utf8')).toContain('actual local patch');
    const inputFile = path.join(repo, inputs[2].path); writeFileSync(inputFile, 'changed after compile');
    const refused = path.join(work, 'refused');
    expect(() => exportApplicationSources({ ...options, destination: refused })).toThrow('input drift');
    expect(existsSync(refused)).toBe(false);
    writeFileSync(inputFile, files['repo/node_modules/nested/dist/index.js']);
    index.inputs[0].path = '../../outside'; writeFileSync(indexFile, JSON.stringify(index));
    expect(() => exportApplicationSources({ ...options, destination: refused })).toThrow('Unsafe');
    expect(existsSync(refused)).toBe(false);
    index.inputs[0].path = 'src/client.ts'; writeFileSync(indexFile, JSON.stringify(index));
    symlinkSync(path.join(work, 'cli'), path.join(repo, 'node_modules/nested/escape'));
    expect(() => exportApplicationSources({ ...options, destination: refused })).toThrow('symlink escape');
    expect(existsSync(refused)).toBe(false);
    writeFileSync(path.join(options.destination, 'src/client.ts'), 'modified kit source');
    expect(() => verifyApplicationSources(options.destination)).toThrow('drift');
  } finally { rmSync(work, { recursive: true, force: true }); }
});
