import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256File } from '../src/manifest';
import type { ApplicationSourceKit } from '../src/application-sources';

test('detached recipe stages only verified files and permits a different compiler identity', () => {
  const parent = path.resolve('.test-data/xpod-cli/rebuild');
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(path.join(parent, 'detached-'));
  try {
    const kitRoot = path.join(work, 'kit');
    const files = ['packages/xpod-cli/scripts/rebuild-application.ts', 'packages/xpod-cli/src/application-sources.ts', 'packages/xpod-cli/src/native-target.ts', 'packages/xpod-cli/src/manifest.ts'];
    const sourceRoot = path.resolve(import.meta.dir, '../../..');
    for (const file of files) {
      mkdirSync(path.dirname(path.join(kitRoot, file)), { recursive: true });
      cpSync(path.join(sourceRoot, file), path.join(kitRoot, file));
    }
    const entry = 'packages/xpod-cli/src/main.ts';
    writeFileSync(path.join(kitRoot, entry), 'console.log("detached-rebuild-fixture");');
    writeFileSync(path.join(kitRoot, 'package.json'), '{"name":"source-kit-fixture","type":"module"}');
    files.push(entry, 'package.json');
    const kit: ApplicationSourceKit = {
      schemaVersion: 1, status: 'application-materials', scope: 'test fixture', target: `${process.platform}-${process.arch}`,
      cliSha256: 'a'.repeat(64), source: { commit: 'b'.repeat(40), dirtyTreeHash: null },
      // Provenance deliberately differs from the invoked executable. It must
      // not prevent a recipient from choosing a compatible modified runtime.
      compiler: { version: 'different-original-compiler', executableSha256: 'c'.repeat(64), hostTarget: `${process.platform}-${process.arch}` },
      recipe: { entry, workingDirectory: '.', defines: [], removedEnvironmentOptions: ['NODE_ENV', 'NODE_OPTIONS', 'BUN_OPTIONS'], samePlatformUsesInvokedRuntime: true },
      inputs: [{ path: entry, sha256: sha256File(path.join(kitRoot, entry)) }], externalImports: [],
      files: files.map((file) => ({ path: file, sha256: sha256File(path.join(kitRoot, file)), sizeBytes: statSync(path.join(kitRoot, file)).size })),
    };
    writeFileSync(path.join(kitRoot, 'source-kit.json'), JSON.stringify(kit));
    const run = (): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [path.join(kitRoot, 'packages/xpod-cli/scripts/rebuild-application.ts')], {
      cwd: work, encoding: 'utf8', timeout: 30_000,
    });
    const result = run();
    expect(result.status).toBe(0);
    const receipt = JSON.parse(readFileSync(path.join(kitRoot, '.test-data/rebuild/receipt.json'), 'utf8'));
    expect(receipt.compiler.executableSha256).toBe(sha256File(process.execPath));
    expect(receipt.originalCompiler.executableSha256).toBe('c'.repeat(64));
    expect(receipt.arguments.some((arg: string) => arg.startsWith('--target='))).toBe(false);
    expect(receipt.rebuiltInputs).toEqual(kit.inputs);
    const binary = spawnSync(path.join(kitRoot, '.test-data/rebuild/xpodcli'), [], { cwd: work, encoding: 'utf8' });
    expect(binary.status).toBe(0);
    expect(binary.stdout.trim()).toBe('detached-rebuild-fixture');
    writeFileSync(path.join(kitRoot, entry), 'console.log("unverified changed source");');
    const refused = run();
    expect(refused.status).not.toBe(0);
    expect(String(refused.stderr)).toContain('source kit drift');
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 40_000);
