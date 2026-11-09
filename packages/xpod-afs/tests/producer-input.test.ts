import { test, expect } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveProducerInput } from '../scripts/producer-input';

const base = path.resolve(import.meta.dir, '../../../.test-data/afs-producer-input');
function fixture() {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'artifact-'));
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@undefineds.co/xpod-cli', version: '0.1.0',
    exports: { './build-tools': './dist/tools.cjs', './producer-materials': './dist/index.json' } }));
  writeFileSync(path.join(root, 'dist/index.json'), JSON.stringify({schemaVersion:1,status:'producer-materials-only',producer:{name:'@undefineds.co/xpod-cli',version:'0.1.0'}}));
  return root;
}

test('missing or repeated producer selection rejects without resolving workspace tools', () => {
  expect(() => resolveProducerInput([])).toThrow('--cli-package');
  expect(() => resolveProducerInput(['--cli-package'])).toThrow('path');
  expect(() => resolveProducerInput(['--cli-package', 'one', '--cli-package', 'two'])).toThrow('exactly one');
});

test('a fixed explicit artifact resolves its own public tools, outside workspace package paths', async () => {
  const root = fixture();
  try {
    // Copy the normally built public artifact via its declared export; no source import.
    const cli = path.resolve(import.meta.dir, '../../xpod-cli');
    const tools = createRequire(path.join(cli, 'package.json')).resolve('@undefineds.co/xpod-cli/build-tools');
    copyFileSync(tools, path.join(root, 'dist/tools.cjs'));
    const before = createHash('sha256').update(readFileSync(path.join(root, 'dist/tools.cjs'))).digest('hex');
    const selected = resolveProducerInput(['--cli-package', root]);
    expect(selected.indexPath).toBe(path.join(root, 'dist/index.json'));
    expect(selected.toolsPath).toBe(path.join(root, 'dist/tools.cjs'));
    await expect(selected.tools.verifyProducerSourceArchive({ archive: path.join(root, 'missing.tar'), inventory: path.join(root, 'missing.json') })).rejects.toThrow();
    expect(createHash('sha256').update(readFileSync(selected.toolsPath)).digest('hex')).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an explicit artifact with missing tool implementations rejects', () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, 'dist/tools.cjs'), 'module.exports = {};');
    expect(() => resolveProducerInput(['--cli-package', root])).toThrow('public contract');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('wrong package or index identity and material ABI reject before tools execute', () => {
  for (const mismatch of ['package', 'version', 'abi']) {
    const root = fixture();
    try {
      writeFileSync(path.join(root, 'dist/tools.cjs'), 'throw new Error("tools must not execute");');
      if (mismatch === 'package') {
        const file = path.join(root, 'package.json'); const data = JSON.parse(readFileSync(file, 'utf8'));
        data.name = '@undefineds.co/other'; writeFileSync(file, JSON.stringify(data));
      } else {
        const file = path.join(root, 'dist/index.json'); const data = JSON.parse(readFileSync(file, 'utf8'));
        if (mismatch === 'version') data.producer.version = '9.0.0'; else data.schemaVersion = 99;
        writeFileSync(file, JSON.stringify(data));
      }
      expect(() => resolveProducerInput(['--cli-package', root])).toThrow('identity');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('export traversal and symlinks cannot select a different artifact', () => {
  for (const kind of ['traversal', 'symlink']) {
    const root = fixture();
    try {
      const file = path.join(root, 'package.json'); const data = JSON.parse(readFileSync(file, 'utf8'));
      if (kind === 'traversal') data.exports['./build-tools'] = './../other.cjs';
      else {
        writeFileSync(path.join(root, 'dist/original.cjs'), 'throw new Error("tools must not execute");');
        symlinkSync('original.cjs', path.join(root, 'dist/tools.cjs'));
      }
      writeFileSync(file, JSON.stringify(data));
      expect(() => resolveProducerInput(['--cli-package', root])).toThrow(kind === 'traversal' ? 'escapes' : 'symlink');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('changes to selected index or cached tools are rejected by the same artifact binding', () => {
  const root = fixture();
  try {
    const cli = path.resolve(import.meta.dir, '../../xpod-cli');
    copyFileSync(createRequire(path.join(cli, 'package.json')).resolve('@undefineds.co/xpod-cli/build-tools'), path.join(root, 'dist/tools.cjs'));
    const selected = resolveProducerInput(['--cli-package', root]);
    writeFileSync(selected.indexPath, readFileSync(selected.indexPath, 'utf8') + '\n');
    expect(() => selected.assertCurrent()).toThrow('hash changed');
    writeFileSync(selected.toolsPath, readFileSync(selected.toolsPath, 'utf8') + '\n');
    expect(() => resolveProducerInput(['--cli-package', root])).toThrow('hash changed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
