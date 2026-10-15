import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('the shared builder imports without resolving command arguments or starting a build', async () => {
  const library = path.resolve(import.meta.dir, '../dist/library.cjs');
  const before = existsSync(library) ? readFileSync(library) : undefined;
  const { buildAfsClient } = await import('../scripts/build-client');
  expect(typeof buildAfsClient).toBe('function');
  expect(existsSync(library) ? readFileSync(library) : undefined).toEqual(before);
});

// Explicit original native evidence enables the real packaging regression.
// Ordinary unit runs do not download or manufacture native authority.
const evidence = process.env.XPOD_AFS_LIFETIME_NATIVE_EVIDENCE;
const pins = process.env.XPOD_AFS_LIFETIME_NATIVE_PINS;
const target = process.env.XPOD_AFS_LIFETIME_TARGET;
(test as typeof test & { skipIf(condition: boolean): typeof test }).skipIf(!evidence || !pins || !target)('client cleanup followed by a new module build binds the new producer and preserves the runtime boundary', () => {
  const repo = path.resolve(import.meta.dir, '../../..');
  const output = mkdtempSync(path.join(repo, '.test-data/afs-lifetime-regression-'));
  const staged = path.join(repo, 'packages/xpod-afs/.test-data');
  const scopes = () => existsSync(staged) ? readdirSync(staged).filter(name => name.startsWith('producer-cli-')).sort() : [];
  const before = scopes();
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, ['scripts/build-afs-from-producer.ts', ...args,
      '--cli-package', 'packages/xpod-cli'], { cwd: repo, encoding: 'utf8' });
    expect({ exit: result.status, error: result.error?.message, signal: result.signal,
      diagnostic: result.status === 0 ? '' : result.stderr.slice(-6000) })
      .toEqual({ exit: 0, error: undefined, signal: null, diagnostic: '' });
  };
  try {
    run(['--mode', 'client']);
    expect(scopes()).toEqual(before);
    const old = Object.keys(JSON.parse(readFileSync(path.join(repo, 'packages/xpod-afs/dist/commands-inputs.json'), 'utf8')).inputs)
      .filter(name => name.includes('/producer-cli-'));
    expect(old.length > 0).toBe(true);
    expect(old.every(name => !existsSync(name))).toBe(true);
    run(['--mode', 'module', '--target', target!, '--out', output,
      '--native-evidence', evidence!, '--native-pins', pins!]);
    expect(scopes()).toEqual(before);
    const manifest = JSON.parse(readFileSync(path.join(output, 'package/package.json'), 'utf8'));
    expect(manifest.name).toBe('@undefineds.co/xpod-afs-' + target);
    const libraryInputs = Object.keys(JSON.parse(readFileSync(path.join(output, 'bundle-inputs.json'), 'utf8')).inputs);
    expect(libraryInputs.some(name => name.includes('/xpod-cli/') || name.includes('/producer-cli-'))).toBe(false);
    const runtime = readFileSync(path.join(output, 'package/dist/command-host.mjs'), 'utf8');
    expect(/(?:from\s*|import\s*\(|require\s*\()\s*['"]@undefineds\.co\/xpod-cli(?:\/|['"])/.test(runtime)).toBe(false);
    const kit = JSON.parse(readFileSync(path.join(output, 'package/provenance/module-source-kit.json'), 'utf8'));
    const fresh = kit.files.filter((file: { path: string }) => file.path.includes('/producer-cli-') && file.path.endsWith('/dist/output.mjs'));
    expect(fresh.length).toBe(1);
    expect(old.every(name => !fresh.some((file: { path: string }) => path.resolve(repo, file.path) === name))).toBe(true);
    const copied = readFileSync(path.join(output, 'module-source', fresh[0].path));
    expect(createHash('sha256').update(copied).digest('hex')).toBe(fresh[0].sha256);
    expect(copied.length).toBe(fresh[0].bytes);
    const archive = JSON.parse(readFileSync(path.join(output, 'build.safe.json'), 'utf8'));
    expect(createHash('sha256').update(readFileSync(archive.archive)).digest('hex')).toBe(archive.sha256);
    process.stdout.write(JSON.stringify({ stage: 'client-cleanup-then-module', exit: 0, target,
      archiveSHA256: archive.sha256, nativeHelperSHA256: archive.native.helperSHA256,
      moduleSourceDirty: archive.native.moduleSourceDirty, moduleSourceSHA: archive.native.moduleSourceSHA,
      freshSourceBytes: copied.length, temporaryScopesCleaned: true }) + '\n');
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 180_000);
